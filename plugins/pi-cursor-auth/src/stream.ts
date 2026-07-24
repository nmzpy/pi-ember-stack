/**
 * Pi streamSimple implementation for the Cursor cloud-direct provider.
 * Modeled on plugins/devin-auth/src/stream.ts.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	calculateCost,
	createAssistantMessageEventStream,
	parseStreamingJson,
} from "@earendil-works/pi-ai";
import { CURSOR_MODEL_ID_PATTERN } from "./constants.js";
import { map_context_to_cursor, cursor_context_has_content } from "./context-map.js";
import { resolve_pi_tool_name, normalize_tool_arguments } from "./context.js";
import {
	stream_agent_events,
	type CursorChatEvent,
	CursorChatError,
} from "./cloud-direct/chat.js";

let active_session_key = "default";
let active_workspace_path = "";
let active_pi_mode: string | undefined;
let last_directive_mode: string | undefined;
let directive_pending = true;

const MODE_DIRECTIVES: Record<string, string> = {
	plan: "You are in plan mode. Design your approach before coding. Reply in labeled lines: Task:, Investigation:, Module N:, Acceptance Criteria:. Do not write code until the plan is approved.",
	code: "You are in code mode. Implement the task directly. Prefer parallel read and edit calls for independent files. Explain briefly after changes.",
	debug: "You are in debug mode. Investigate the root cause, then fix it. Use read and bash to gather evidence. Prefer parallel independent reads.",
	orchestrate:
		"You are in orchestrate mode. Break the task into independent subtasks, delegate where possible, and synthesize results. Prefer parallel tool calls.",
};

function build_mode_directive(pi_mode: string | undefined): string {
	const mode = pi_mode ?? "code";
	return MODE_DIRECTIVES[mode] ?? MODE_DIRECTIVES.code;
}

function should_include_mode_directive(): boolean {
	return directive_pending || last_directive_mode !== active_pi_mode;
}

function mark_mode_directive_sent(): void {
	directive_pending = false;
	last_directive_mode = active_pi_mode;
}

function build_system_prompt(base_prompt: string | undefined): string {
	const directive = should_include_mode_directive() ? build_mode_directive(active_pi_mode) : "";
	const parts = [base_prompt?.trim(), directive.trim()].filter(Boolean);
	return parts.join("\n\n") || "You are a helpful assistant.";
}

function map_cursor_tool_name(raw_name: string, tools: Context["tools"]): string {
	const pi_name = resolve_pi_tool_name(raw_name, tools ?? []);
	return pi_name ?? raw_name;
}

function normalize_cursor_tool_args(
	tool_name: string,
	args: Record<string, unknown>,
	tools: Context["tools"],
): Record<string, unknown> {
	const pi_name = resolve_pi_tool_name(tool_name, tools ?? []) ?? tool_name;
	return normalize_tool_arguments(pi_name, args);
}

function finalize_cursor_tool_arguments(
	tool_name: string,
	partial_json: string,
	tools: Context["tools"],
): Record<string, unknown> {
	const parsed = parseStreamingJson(partial_json) as Record<string, unknown>;
	return normalize_cursor_tool_args(tool_name, parsed, tools);
}

export function stream_cursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let text_block_open = false;
		let thinking_block_open = false;
		let current_tool_call_index = -1;
		let partial_json = "";
		let current_tool_call_id = "";
		let current_tool_call_name = "";

		const close_text_block = (): void => {
			if (!text_block_open) return;
			const idx = output.content.length - 1;
			const block = output.content[idx];
			if (block.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex: idx,
					content: block.text,
					partial: output,
				});
			}
			text_block_open = false;
		};

		const close_thinking_block = (): void => {
			if (!thinking_block_open) return;
			const idx = output.content.length - 1;
			const block = output.content[idx];
			if (block.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: block.thinking,
					partial: output,
				});
			}
			thinking_block_open = false;
		};

		const close_tool_call = (): void => {
			if (current_tool_call_index < 0) return;
			const block = output.content[current_tool_call_index];
			if (block.type !== "toolCall") return;
			block.arguments = finalize_cursor_tool_arguments(
				current_tool_call_name,
				partial_json,
				context.tools,
			);
			stream.push({
				type: "toolcall_end",
				contentIndex: current_tool_call_index,
				toolCall: {
					type: "toolCall",
					id: current_tool_call_id,
					name: current_tool_call_name,
					arguments: block.arguments,
				},
				partial: output,
			});
			current_tool_call_index = -1;
			partial_json = "";
		};

		try {
			if (!CURSOR_MODEL_ID_PATTERN.test(model.id)) {
				throw new Error(`Invalid Cursor model id: ${model.id}`);
			}

			const access_token = options?.apiKey;
			if (!access_token) {
				throw new Error("No Cursor access token. Run /login cursor");
			}

			const mapped = map_context_to_cursor(context, build_system_prompt(context.systemPrompt));
			if (!cursor_context_has_content(mapped)) {
				throw new Error("Cursor provider: no user message or tool results to send");
			}

			stream.push({ type: "start", partial: output });
			mark_mode_directive_sent();

			for await (const ev of stream_agent_events({
				access_token,
				model_id: model.id,
				mapped,
				session_key: active_session_key,
				workspace_path: active_workspace_path,
				signal: options?.signal,
			})) {
				handle_event(ev);
			}

			close_text_block();
			close_thinking_block();
			close_tool_call();

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			const aborted = options?.signal?.aborted === true;
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof CursorChatError || error instanceof Error
					? error.message
					: String(error);
			stream.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				error: output,
			});
			stream.end();
		}

		function handle_event(ev: CursorChatEvent): void {
			switch (ev.kind) {
				case "text": {
					close_thinking_block();
					if (!text_block_open) {
						output.content.push({ type: "text", text: "" });
						stream.push({
							type: "text_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
						text_block_open = true;
					}
					const idx = output.content.length - 1;
					const block = output.content[idx];
					if (block.type === "text") {
						block.text += ev.text;
						stream.push({
							type: "text_delta",
							contentIndex: idx,
							delta: ev.text,
							partial: output,
						});
					}
					break;
				}
				case "reasoning": {
					close_text_block();
					if (!thinking_block_open) {
						output.content.push({ type: "thinking", thinking: "" });
						stream.push({
							type: "thinking_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
						thinking_block_open = true;
					}
					const idx = output.content.length - 1;
					const block = output.content[idx];
					if (block.type === "thinking") {
						block.thinking += ev.text;
						stream.push({
							type: "thinking_delta",
							contentIndex: idx,
							delta: ev.text,
							partial: output,
						});
					}
					break;
				}
				case "tool_call_start": {
					close_text_block();
					close_thinking_block();
					close_tool_call();
					current_tool_call_id = ev.id;
					current_tool_call_name = map_cursor_tool_name(ev.name, context.tools);
					partial_json = "";
					output.content.push({
						type: "toolCall",
						id: current_tool_call_id,
						name: current_tool_call_name,
						arguments: {},
					});
					current_tool_call_index = output.content.length - 1;
					stream.push({
						type: "toolcall_start",
						contentIndex: current_tool_call_index,
						partial: output,
					});
					break;
				}
				case "tool_call_args": {
					if (current_tool_call_index < 0) break;
					partial_json += ev.args_delta;
					const block = output.content[current_tool_call_index];
					if (block.type === "toolCall") {
						block.arguments = finalize_cursor_tool_arguments(
							current_tool_call_name,
							partial_json,
							context.tools,
						);
					}
					stream.push({
						type: "toolcall_delta",
						contentIndex: current_tool_call_index,
						delta: ev.args_delta,
						partial: output,
					});
					break;
				}
				case "finish": {
					close_text_block();
					close_thinking_block();
					close_tool_call();
					output.stopReason =
						ev.reason === "tool_calls"
							? "toolUse"
							: ev.reason === "length"
								? "length"
								: "stop";
					break;
				}
				case "usage": {
					output.usage.input = ev.prompt_tokens ?? 0;
					output.usage.output = ev.completion_tokens ?? 0;
					output.usage.totalTokens =
						ev.total_tokens ?? output.usage.input + output.usage.output;
					calculateCost(model, output.usage);
					break;
				}
			}
		}
	})();

	return stream;
}

/** @deprecated Use stream_cursor — kept for extensions import compatibility during transition. */
export const stream_cursor_subscription = stream_cursor;

export function set_cursor_session_key(session_key: string): void {
	active_session_key = session_key || "default";
}

export function get_cursor_session_key(): string {
	return active_session_key;
}

export function set_cursor_workspace_path(workspace_path: string | undefined): void {
	active_workspace_path = workspace_path?.trim() ?? "";
}

export function set_cursor_pi_mode(mode: string | undefined): void {
	if (mode !== active_pi_mode) directive_pending = true;
	active_pi_mode = mode;
}

export function reset_cursor_session(): void {
	active_pi_mode = undefined;
	last_directive_mode = undefined;
	directive_pending = true;
}

export const __test_only = {
	should_include_mode_directive,
	mark_mode_directive_sent,
	build_system_prompt,
	finalize_cursor_tool_arguments,
	get_active_pi_mode: () => active_pi_mode,
	get_last_directive_mode: () => last_directive_mode,
	get_directive_pending: () => directive_pending,
	reset_cursor_session,
};
