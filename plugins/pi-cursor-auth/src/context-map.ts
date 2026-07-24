/**
 * Map Pi Context → Cursor Agent API request shapes.
 * Outbound tool names use context.ts SSOT maps.
 */
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import {
	cursor_serialize_tool,
	extract_user_message_text,
	is_non_ask_user_message,
	resolve_cursor_user_text,
} from "./context.js";

export interface CursorToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

export interface CursorToolResult {
	tool_call_id: string;
	content: string;
}

export interface CursorAssistantToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface CursorTurn {
	user_text: string;
	assistant_text: string;
	tool_calls: CursorAssistantToolCall[];
	/** Tool results already consumed into earlier history turns. */
	embedded_tool_results: CursorToolResult[];
}

export interface CursorMappedContext {
	system_prompt: string;
	user_text: string;
	turns: CursorTurn[];
	tool_results: CursorToolResult[];
	tools: CursorToolDef[];
}

interface TextContent {
	type: "text";
	text: string;
}

interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type AssistantContentPart = TextContent | { type: "thinking"; thinking: string } | ToolCallContent;
type UserContentPart = TextContent | ImageContent;

function text_from_user_content(content: string | UserContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image") return `[image/${part.mimeType || "unknown"}]`;
			return "";
		})
		.join("");
}

function assistant_visible_text(content: AssistantContentPart[]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extract_assistant_tool_calls(content: AssistantContentPart[]): CursorAssistantToolCall[] {
	const calls: CursorAssistantToolCall[] = [];
	for (const part of content) {
		if (part.type !== "toolCall") continue;
		calls.push({
			id: part.id,
			name: part.name,
			arguments: part.arguments ?? {},
		});
	}
	return calls;
}

function map_tools(tools: readonly Tool[] | undefined): CursorToolDef[] {
	return (tools ?? []).map((tool) => {
		const serialized = cursor_serialize_tool(tool);
		return {
			name: String(serialized.name),
			description: tool.description,
			parameters: serialized.parameters,
		};
	});
}

function find_turn_for_tool_result(
	turns: readonly CursorTurn[],
	tool_call_id: string,
): number {
	for (let i = turns.length - 1; i >= 0; i--) {
		if (turns[i]?.tool_calls.some((call) => call.id === tool_call_id)) return i;
	}
	return -1;
}

function parse_pi_messages(
	messages: readonly Message[],
): Pick<CursorMappedContext, "turns" | "tool_results"> {
	const turns: CursorTurn[] = [];
	const all_tool_results: CursorToolResult[] = [];
	let current_turn: CursorTurn | null = null;

	for (const message of messages) {
		if (message.role === "toolResult") {
			all_tool_results.push({
				tool_call_id: message.toolCallId,
				content: text_from_user_content(message.content as string | UserContentPart[]),
			});
			continue;
		}

		if (message.role === "user") {
			if (is_non_ask_user_message(message)) continue;
			const text = extract_user_message_text(message);
			if (!text) continue;
			if (current_turn) turns.push(current_turn);
			current_turn = {
				user_text: text,
				assistant_text: "",
				tool_calls: [],
				embedded_tool_results: [],
			};
			continue;
		}

		if (message.role === "assistant") {
			const parts = message.content as AssistantContentPart[];
			const text = assistant_visible_text(parts);
			const calls = extract_assistant_tool_calls(parts);
			if (!current_turn && (text || calls.length > 0)) {
				current_turn = {
					user_text: "",
					assistant_text: "",
					tool_calls: [],
					embedded_tool_results: [],
				};
			}
			if (!current_turn) continue;
			if (text) {
				current_turn.assistant_text = current_turn.assistant_text
					? `${current_turn.assistant_text}\n${text}`
					: text;
			}
			current_turn.tool_calls.push(...calls);
		}
	}

	if (current_turn) turns.push(current_turn);

	const tool_results: CursorToolResult[] = [];
	if (turns.length === 0) {
		tool_results.push(...all_tool_results);
		return { turns, tool_results };
	}

	const last_turn = turns.at(-1);
	if (!last_turn) {
		tool_results.push(...all_tool_results);
		return { turns, tool_results };
	}
	const last_call_ids = new Set(last_turn.tool_calls.map((call) => call.id));

	for (const result of all_tool_results) {
		if (last_call_ids.has(result.tool_call_id)) {
			tool_results.push(result);
			continue;
		}
		const turn_index = find_turn_for_tool_result(turns, result.tool_call_id);
		if (turn_index >= 0) {
			const turn = turns[turn_index];
			if (turn) turn.embedded_tool_results.push(result);
		} else {
			tool_results.push(result);
		}
	}

	return { turns, tool_results };
}

/** Pending user turns belong in the Run action, not conversation_state.turns. */
function split_pending_user_turn(turns: readonly CursorTurn[]): {
	completed_turns: CursorTurn[];
	pending_user_text: string;
} {
	const completed_turns = [...turns];
	const last = completed_turns.at(-1);
	if (
		last &&
		!last.assistant_text.trim() &&
		last.tool_calls.length === 0 &&
		last.embedded_tool_results.length === 0 &&
		last.user_text.trim()
	) {
		completed_turns.pop();
		return { completed_turns, pending_user_text: last.user_text };
	}
	return { completed_turns, pending_user_text: "" };
}

function resolve_mapped_user_text(
	context: Context,
	parsed: Pick<CursorMappedContext, "tool_results">,
	explicit_user_text?: string,
): string {
	const explicit = explicit_user_text?.trim();
	if (explicit) return explicit;

	const last_message = context.messages[context.messages.length - 1];
	if (last_message?.role === "toolResult" || parsed.tool_results.length > 0) {
		return "";
	}
	return resolve_cursor_user_text(context);
}

export function map_context_to_cursor(
	context: Context,
	system_prompt_override?: string,
	explicit_user_text?: string,
): CursorMappedContext {
	const parsed = parse_pi_messages(context.messages);
	const { completed_turns, pending_user_text } = split_pending_user_turn(parsed.turns);
	const system_prompt = system_prompt_override ?? context.systemPrompt ?? "You are a helpful assistant.";
	let user_text = resolve_mapped_user_text(context, parsed, explicit_user_text);
	if (!user_text.trim() && pending_user_text.trim()) {
		user_text = pending_user_text;
	}
	return {
		system_prompt,
		user_text,
		turns: completed_turns,
		tool_results: parsed.tool_results,
		tools: map_tools(context.tools),
	};
}

export function cursor_context_has_content(mapped: CursorMappedContext): boolean {
	return (
		mapped.user_text.trim().length > 0 ||
		mapped.tool_results.length > 0 ||
		mapped.turns.length > 0
	);
}

export const __test_only = {
	assistant_visible_text,
	extract_assistant_tool_calls,
	parse_pi_messages,
	resolve_mapped_user_text,
	split_pending_user_turn,
	text_from_user_content,
};
