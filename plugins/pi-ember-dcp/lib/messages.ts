/**
 * Helpers for inspecting and mutating the AgentMessage stream that the
 * `context` event hands us before each LLM call.
 *
 * Critical invariants:
 *
 * 1. Every ToolCall in an assistant message MUST be matched by exactly one
 *    ToolResultMessage immediately after it. When we "prune" a tool we
 *    therefore REPLACE the content of the ToolResultMessage with a short
 *    placeholder, never remove it. Many providers reject orphaned tool calls.
 *
 * 2. The `messages` array we receive contains references to message objects
 *    that the session manager still holds. Mutating them in place corrupts
 *    persisted session entries. ALWAYS clone a message (and any nested
 *    structures we plan to write to) before modifying it, and emit a fresh
 *    array via ContextEventResult.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */

import { approx_tokens as _approx_tokens } from "./tokens.ts";

export interface TextContent {
	type: "text";
	text: string;
	[k: string]: unknown;
}
export interface ImageContent {
	type: "image";
	[k: string]: unknown;
}
export interface ThinkingContent {
	type: "thinking";
	[k: string]: unknown;
}

/** Pi-ai's ToolCall uses `arguments`, not `input`. Critical to get right. */
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[k: string]: unknown;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	timestamp: number;
	[k: string]: unknown;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	timestamp: number;
	[k: string]: unknown;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
	[k: string]: unknown;
}

export type AnyMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function is_tool_result(m: AnyMessage): m is ToolResultMessage {
	return (m as { role?: string }).role === "toolResult";
}

export function is_assistant(m: AnyMessage): m is AssistantMessage {
	return (m as { role?: string }).role === "assistant";
}

export function is_user(m: AnyMessage): m is UserMessage {
	return (m as { role?: string }).role === "user";
}

export function is_tool_call(c: { type?: string }): c is ToolCall {
	return c?.type === "toolCall";
}

/** Iterate all ToolCall entries inside an assistant message's content. */
export function tool_calls_of(m: AssistantMessage): ToolCall[] {
	const out: ToolCall[] = [];
	for (const c of m.content) {
		if (is_tool_call(c)) out.push(c);
	}
	return out;
}

/**
 * Canonical JSON serialization for use as a dedup key.
 *
 * Standard `JSON.stringify(obj, keys.sort())` only sorts the TOP level, so
 * nested objects are normalized recursively too. Arrays preserve order.
 * Cycles and non-JSON values are stringified via `String()`.
 */
export function canonical_json(
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
): string {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "string") return JSON.stringify(value);
	if (t === "number") return Number.isFinite(value as number) ? String(value) : "null";
	if (t === "boolean") return String(value);
	if (t === "undefined") return "null";
	if (t === "bigint") return JSON.stringify(String(value));
	if (t !== "object") return JSON.stringify(String(value));

	const obj = value as object;
	if (seen.has(obj)) return '"[cycle]"';
	seen.add(obj);

	if (Array.isArray(obj)) {
		return `[${obj.map((v) => canonical_json(v, seen)).join(",")}]`;
	}
	const keys = Object.keys(obj as Record<string, unknown>).sort();
	const parts: string[] = [];
	for (const k of keys) {
		const v = (obj as Record<string, unknown>)[k];
		if (v === undefined) continue;
		parts.push(`${JSON.stringify(k)}:${canonical_json(v, seen)}`);
	}
	return `{${parts.join(",")}}`;
}

/** Build a stable key for deduplication: name + canonical JSON of arguments. */
export function tool_call_key(call: {
	name: string;
	arguments: Record<string, unknown>;
}): string {
	return `${call.name}::${canonical_json(call.arguments)}`;
}

export { approx_tokens } from "./tokens.ts";

/** Approximate token count for a ToolResultMessage's content payload. */
export function tool_result_tokens(m: ToolResultMessage): number {
	let n = 0;
	for (const c of m.content) {
		if ((c as TextContent).type === "text") n += _approx_tokens((c as TextContent).text);
		else n += 256; // images: rough placeholder cost
	}
	return n;
}

/**
 * Shallow-clone a message AND the inner mutable fields we may rewrite.
 *
 * For assistant messages we clone the content array and every ToolCall (their
 * `arguments` may be rewritten by purgeErrors). For tool result messages we
 * clone the content array (its entries may be replaced with placeholders).
 */
export function clone_for_mutation<T extends AnyMessage>(m: T): T {
	if (is_tool_result(m)) {
		return { ...m, content: m.content.map((c) => ({ ...c })) } as T;
	}
	if (is_assistant(m)) {
		const content = m.content.map((c) => {
			if (is_tool_call(c)) {
				return { ...c, arguments: { ...c.arguments } } as ToolCall;
			}
			return { ...c };
		});
		return { ...m, content } as T;
	}
	return { ...m } as T;
}

const PRUNED_PLACEHOLDER_PREFIX = "[pruned by pi-dcp:";
const COMPRESSION_PLACEHOLDER_PREFIX = "[pi-dcp compression";

/** True if this tool result's content is already a pi-dcp placeholder. */
export function is_already_placeholder(m: ToolResultMessage): boolean {
	const first = m.content[0] as TextContent | undefined;
	if (!first || first.type !== "text") return false;
	return (
		first.text.startsWith(PRUNED_PLACEHOLDER_PREFIX) ||
		first.text.startsWith(COMPRESSION_PLACEHOLDER_PREFIX)
	);
}

/**
 * Replace a tool result's content with a short placeholder. Returns the
 * estimated tokens removed. Idempotent — if already a placeholder, returns 0.
 * The caller is expected to have cloned `m` already via `clone_for_mutation`.
 */
export function placeholder_tool_result(m: ToolResultMessage, reason: string): number {
	if (is_already_placeholder(m)) return 0;
	const before = tool_result_tokens(m);
	m.content = [
		{
			type: "text",
			text: `${PRUNED_PLACEHOLDER_PREFIX} ${reason}]`,
		},
	];
	m.details = undefined;
	const after = tool_result_tokens(m);
	return Math.max(0, before - after);
}

/**
 * Replace a tool result's content with a compression-summary placeholder.
 * Caller must clone `m` first.
 */
export function compression_placeholder_tool_result(
	m: ToolResultMessage,
	compression_id: number,
	topic: string,
): number {
	if (is_already_placeholder(m)) return 0;
	const before = tool_result_tokens(m);
	m.content = [
		{
			type: "text",
			text: `${COMPRESSION_PLACEHOLDER_PREFIX} #${compression_id}: ${topic}] (see /dcp decompress ${compression_id} to restore)`,
		},
	];
	m.details = undefined;
	const after = tool_result_tokens(m);
	return Math.max(0, before - after);
}

export const PURGE_ARGS_MARKER = "[args purged by pi-dcp]";

/**
 * Compute the set of tool-call IDs that fall inside the last `turns` user
 * boundaries (counting newest-first). These IDs must be skipped by every
 * pruning strategy when turnProtection is enabled.
 *
 * `turns <= 0` returns an empty set (protection disabled).
 */
export function protected_by_recency(messages: AnyMessage[], turns: number): Set<string> {
	if (!Number.isFinite(turns) || turns <= 0) return new Set();
	const out = new Set<string>();
	let user_count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (is_user(m)) {
			user_count++;
			// A user message is the BOUNDARY between turns; everything beyond
			// it (older) belongs to a previous turn we are not protecting.
			if (user_count >= turns) break;
			continue;
		}
		if (is_tool_result(m)) {
			out.add(m.toolCallId);
			continue;
		}
		if (is_assistant(m)) {
			for (const c of m.content) {
				if (is_tool_call(c)) out.add(c.id);
			}
		}
	}
	return out;
}
