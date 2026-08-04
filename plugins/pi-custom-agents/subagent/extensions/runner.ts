/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Runs an isolated AgentSession in-process on the main thread, reusing the
 * parent's canonical ModelRuntime through its extension-facing ModelRegistry
 * facade. This keeps every registered provider (Devin, xAI, built-ins, custom
 * models.json entries) and credential source available without re-registration.
 * Child sessions enable Pi compaction (Ember summarizer via compaction-wiring).
 *
 * session.prompt() is async and does not block the TUI render loop — pi's
 * event loop keeps rendering while the subagent streams. This avoids the
 * worker_thread boundary that previously prevented provider inheritance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSessionEvent,
	createAgentSession,
	discoverAndLoadExtensions,
	estimateTokens,
	getAgentDir,
	type LoadExtensionsResult,
	loadProjectContextFiles,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { is_benign_compact_error, should_skip_compact } from "../../auto-continue.ts";
import { infer_bare_agent_name } from "../../subagent-policy.ts";
import {
	mark_checkpoint_dir_live,
	persist_checkpoint_meta,
	type ResumeCheckpointMeta,
	read_resume_meta,
	subagent_sessions_dir_for,
	unmark_checkpoint_dir_live,
} from "./resume-store.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;

/** Values below this are treated as seconds (models often pass 120 for 120s). */
const SUBAGENT_TIMEOUT_SECONDS_THRESHOLD_MS = 1000;

/** Normalize subagent timeout tool args — SSOT for runner + tool handler. */
export function resolve_subagent_timeout_ms(timeout: unknown): number {
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		return DEFAULT_SUBAGENT_TIMEOUT_MS;
	}
	if (timeout < SUBAGENT_TIMEOUT_SECONDS_THRESHOLD_MS) {
		return Math.round(timeout * 1000);
	}
	return Math.round(timeout);
}

const SUBAGENT_EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TODO_EXTENSION_PATH = path.resolve(SUBAGENT_EXT_DIR, "../../../pi-ember-todo/index.ts");
const COMPACTION_WIRING_PATH = path.resolve(SUBAGENT_EXT_DIR, "../../compaction-wiring.ts");

const PARALLEL_TOOL_CALL_GUIDANCE = `

## Tool Call Efficiency

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching saves round-trips and reduces latency.

Todo is session-local: use ids returned by this child session's \`create\`, or an
exact \`task\` subject. Do not reuse ids from the parent session.
`;

const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i,
	/exceeds the context window/i,
	/maximum context length/i,
	/context window exceeds/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

/** Headroom above the model context window before we pre-emptively compact. */
const CONTEXT_SAFETY_FACTOR = 1.1;

/** Buffer reserved for the next turn's output and overhead. */
const CONTEXT_PROMPT_RESERVE = 8192;

/** In-memory settings for subagent child sessions — auto-compaction off (handled by runner), retry off. */
export function build_subagent_settings(): {
	compaction: { enabled: boolean };
	retry: { enabled: boolean };
} {
	return {
		compaction: { enabled: false },
		retry: { enabled: false },
	};
}

export function is_context_overflow_error(message: string | undefined): boolean {
	if (!message) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

async function load_subagent_extensions(cwd: string): Promise<LoadExtensionsResult> {
	// The child receives the same task-list tool as the parent. Without loading
	// this extension, `todo` remains in the agent's allowlist but has no
	// registration in the isolated AgentSession, which makes checklist updates
	// fail or silently disappear.
	const paths = [TODO_EXTENSION_PATH, COMPACTION_WIRING_PATH];
	return discoverAndLoadExtensions(paths, cwd);
}

async function compact_subagent_session(
	session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
): Promise<void> {
	const branch = session.sessionManager.getBranch?.() ?? [];
	if (should_skip_compact(branch)) return;
	try {
		await session.compact();
	} catch (err) {
		if (!is_benign_compact_error(err)) throw err;
	}
}

/** Estimate the tokens the next prompt will send, using the child's live messages. */
function estimate_subagent_prompt_tokens(
	session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
	pendingPrompt: string,
): number {
	const { messages } = session.sessionManager.buildSessionContext();
	const messageTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
	const promptTokens = estimateTokens({
		role: "user",
		content: pendingPrompt,
		timestamp: Date.now(),
	});
	return messageTokens + promptTokens;
}

/** True when the next prompt would exceed the model's context window plus safety headroom. */
function should_compact_before_prompt(
	session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
	pendingPrompt: string,
): boolean {
	const model = session.model;
	if (!model || model.contextWindow <= 0) return false;
	const budget = Math.floor(model.contextWindow / CONTEXT_SAFETY_FACTOR) - CONTEXT_PROMPT_RESERVE;
	return estimate_subagent_prompt_tokens(session, pendingPrompt) > Math.max(1, budget);
}

const MAX_SUBAGENT_LENGTH_CONTINUES = 5;
const MAX_SUBAGENT_WEBSOCKET_RETRIES = 3;
const SUBAGENT_WEBSOCKET_PATTERNS: readonly RegExp[] = [
	/websocket/i,
	/socket hang up/i,
	/ECONNRESET/i,
	/connection was reset/i,
];

const SUBAGENT_CONTINUE_PROMPT = "continue from where you left off";

function is_websocket_error(message: string | undefined): boolean {
	if (!message) return false;
	return SUBAGENT_WEBSOCKET_PATTERNS.some((pattern) => pattern.test(message));
}

/** Short abortable backoff before the single pre-response HTTP 500 retry. */
export const SUBAGENT_HTTP500_RETRY_BACKOFF_MS = 300;

/**
 * Exact empty-body pre-response HTTP 500 error patterns. Narrow by design:
 * only a pure 500 with no useful body is transient-safe to retry — never
 * arbitrary "500 ..." text, and never auth/permission/quota/billing/
 * invalid-model errors or 400/401/403/404/408/409/429/503 statuses.
 */
const EMPTY_BODY_HTTP500_PATTERNS: readonly RegExp[] = [
	/^500 status code \(no body\)$/,
	/^GetChatMessage HTTP 500:\s*$/,
];

/** True when the message is exactly an empty-body pre-response HTTP 500. */
export function is_empty_body_http500_error(message: string | undefined): boolean {
	if (!message) return false;
	const trimmed = message.trim();
	return EMPTY_BODY_HTTP500_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** The last assistant message in the stream, if any. */
function lastAssistantMessage(messages: Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

/**
 * True when the failed result is a pure pre-response empty-body HTTP 500 with
 * no partial visible text or tool calls — the only case the single retry may
 * safely re-run without duplicating emitted work.
 */
export function retryable_pre_response_http500_failure(result: SubAgentResult): boolean {
	if (result.stopReason !== "error") return false;
	const matches =
		is_empty_body_http500_error(result.errorMessage) ||
		is_empty_body_http500_error(lastAssistantErrorMessage(result.messages));
	if (!matches) return false;
	if (result.latestToolCall) return false;
	for (const item of result.liveItems ?? []) {
		if (item.kind === "tool") return false;
	}
	const lastAssistant = lastAssistantMessage(result.messages);
	if (!lastAssistant) return true;
	for (const part of lastAssistant.content) {
		if (typeof part === "string") continue; // legacy plain-text content part
		if (part.type === "text" && part.text.trim()) return false;
		if (part.type === "toolCall") return false;
	}
	return true;
}

/**
 * Rollback snapshot captured immediately before a `session.prompt()` call so a
 * failed pre-response attempt can be removed from the live session and result
 * accounting before the single retry re-sends the same task exactly once.
 */
export interface Http500RetryRollback {
	/** Session leaf entry id before the prompt; null when the session had no entries. */
	retryAnchor: string | null;
	/** `result.messages` length before the prompt (message-cache truncation point). */
	messagesBefore: number;
	/** `result.liveItems` length before the prompt (live-buffer truncation point). */
	liveItemsBefore: number;
	/** Usage/turn accounting before the prompt; restored so a successful retry counts once. */
	usageBefore: UsageStats;
}

/**
 * Minimal session surface the retry rollback needs: the persisted session
 * manager plus the live agent transcript. The SDK's `AgentSession` satisfies
 * this structurally (`sessionManager` + `agent.state.messages`).
 */
export interface SubagentRetrySession {
	sessionManager: SessionManager;
	agent: { state: { messages: AgentMessage[] } };
}

/**
 * Roll back a failed prompt attempt so a retry re-sends the task exactly once
 * from the pre-attempt state: no duplicate user message on the active branch
 * and no stale failed assistant in the live context or result accounting.
 *
 * Session side: branches the SessionManager back to the pre-attempt leaf (or
 * resets a fresh session), which removes the failed user + assistant messages
 * from the active branch, then resyncs the live agent transcript from the
 * persisted branch — the same pattern AgentSession itself uses after compaction
 * (`agent.state.messages = sessionManager.buildSessionContext().messages`), so
 * the retry's context snapshot contains neither the duplicate user nor the
 * failed assistant.
 *
 * Result side: truncates the streamed message cache and live buffer back to the
 * pre-attempt length and restores the usage/turn accounting so a successful
 * retry is counted exactly once.
 */
export function rollback_failed_prompt_attempt(
	result: SubAgentResult,
	session: SubagentRetrySession,
	rollback: Http500RetryRollback,
): void {
	if (result.messages.length > rollback.messagesBefore) {
		result.messages.length = rollback.messagesBefore;
	}
	const liveItems = result.liveItems;
	if (liveItems && liveItems.length > rollback.liveItemsBefore) {
		liveItems.length = rollback.liveItemsBefore;
	}
	result.usage = { ...rollback.usageBefore };
	result.latestToolCall = undefined;
	result.isThinking = false;
	const { sessionManager } = session;
	if (rollback.retryAnchor) {
		sessionManager.branch(rollback.retryAnchor);
	} else {
		sessionManager.resetLeaf();
	}
	const sessionContext = sessionManager.buildSessionContext();
	session.agent.state.messages = sessionContext.messages;
}

/** Abortable short sleep used by the pre-response HTTP 500 retry backoff.
 *  Resolves immediately when `signal` aborts so the caller can stop without
 *  waiting out the delay; never resolves later than the requested delay. */
async function abortable_delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	if (!signal) {
		await new Promise<void>((resolve) => setTimeout(resolve, ms));
		return;
	}
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			if (timer) clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export type PreResponseHttp500RetryDecision = "retry" | "aborted" | "skip";

/**
 * Decide and arm the single pre-response HTTP 500 retry. Returns:
 *  - "retry": the failed attempt was rolled back (session branch, live agent
 *    transcript, message cache, and usage accounting) and the caller should
 *    re-prompt the same task.
 *  - "aborted": an abort fired during the backoff; the caller must stop.
 *  - "skip": the failure is not retry-eligible (or the retry budget is
 *    exhausted); the normal failure text is preserved unchanged.
 */
export async function decide_pre_response_http500_retry(options: {
	result: SubAgentResult;
	aborted: boolean;
	http500_retried: boolean;
	signal?: AbortSignal;
	session: SubagentRetrySession;
	rollback: Http500RetryRollback;
	backoffMs?: number;
}): Promise<PreResponseHttp500RetryDecision> {
	const { result, aborted, http500_retried, signal, session, rollback } = options;
	if (aborted || http500_retried) return "skip";
	if (!retryable_pre_response_http500_failure(result)) return "skip";
	await abortable_delay(options.backoffMs ?? SUBAGENT_HTTP500_RETRY_BACKOFF_MS, signal);
	if (signal?.aborted) return "aborted";
	rollback_failed_prompt_attempt(result, session, rollback);
	result.stopReason = undefined;
	result.errorMessage = undefined;
	return "retry";
}

/** Resume checkpoints may end with a partial/failed assistant turn. Move the leaf
 * to the last non-assistant entry so the next prompt starts from a valid turn.
 * This is resume-checkpoint cleanup only — in-run retries use
 * `rollback_failed_prompt_attempt` with a pre-prompt anchor instead, because
 * branching to the last non-assistant entry alone leaves the failed attempt's
 * user message on the active branch and duplicates it on re-prompt. */
function trim_trailing_assistant_messages(sessionManager: SessionManager): void {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			continue;
		}
		if (i === branch.length - 1) return; // already ends on a non-assistant
		sessionManager.branch(entry.id);
		return;
	}
	// Every entry is an assistant message; start a fresh branch from the root.
	sessionManager.resetLeaf();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PiModel = Model<Api>;

type AbortSignalStatic = typeof AbortSignal & {
	any?(signals: AbortSignal[]): AbortSignal;
};

const AbortSignalCtor = AbortSignal as AbortSignalStatic;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Maximum tool-call rows retained in the live output buffer (SSOT). */
export const SUBAGENT_LIVE_OUTPUT_MAX_ROWS = 15;

/** Maximum characters retained per live agent text block (narration/answer). */
export const SUBAGENT_LIVE_TEXT_MAX_CHARS = 400;

/** A captured child tool call for the live output tray. */
export interface SubagentLiveToolRow {
	/** Child `tool_execution_*` event id — one row per tool call. */
	toolCallId?: string;
	name: string;
	args: Record<string, unknown>;
	/** Whether the tool has completed (`tool_execution_end` fired). */
	completed: boolean;
	/** Whether the tool result reported an error. */
	error: boolean;
	/** Structured diff/match stats from the result, when available. */
	details?: Record<string, unknown>;
}

/** A captured child assistant text block (narration between tools, or the
 *  streaming answer). Rendered as plain text lines in the live tray. */
export interface SubagentLiveTextBlock {
	text: string;
}

/** Chronological live item from the child session: one tool call or one
 *  assistant text block, in arrival order. `liveItems` is the single live
 *  buffer — tools and agent messages interleave exactly as the child emitted
 *  them, so the tray's fold boundaries (visible text hard-splits the work
 *  bundle) never reorder content. */
export type SubagentLiveItem =
	| { kind: "tool"; row: SubagentLiveToolRow }
	| { kind: "text"; text: string };

export interface SubAgentResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/** Child model exposes a reasoning/thinking stream (Pi `model.reasoning`). */
	reasoning?: boolean;
	/** Live thinking/reasoning stream from the child session. */
	isThinking?: boolean;
	stopReason?: string;
	errorMessage?: string;
	latestToolCall?: { name: string; args: Record<string, unknown> };
	/**
	 * Bounded chronological live buffer from the child session: the last
	 * `SUBAGENT_LIVE_OUTPUT_MAX_ROWS` tool calls and assistant text blocks
	 * (`liveItems`), rendered by the subagent renderer as a compact work-bundle
	 * tray (unified `•` header + folded child waves + streamed agent messages)
	 * that mirrors the main agent's `pi-compact-tools` grouping with the same
	 * SSOT formatters. One tool item per child tool call (keyed by
	 * `toolCallId`), so running rows complete in place instead of stacking
	 * duplicate Reading/Searching rows. Updated on every tool/text event;
	 * cleared at session start.
	 */
	liveItems?: SubagentLiveItem[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pi 0.80.10+ exposes ModelRegistry to extensions as a synchronous
 * compatibility facade over the canonical ModelRuntime, and createAgentSession
 * consumes ModelRuntime directly. Pi 0.80.6 instead ships a self-contained
 * ModelRegistry (authStorage + modelsJsonPath) and createAgentSession takes
 * modelRegistry directly. Detect which API is available so the subagent runner
 * works against either installed Pi version without copying credentials or
 * rebuilding provider catalogs.
 */
interface ModelRegistryRuntimeBridge {
	readonly runtime?: unknown;
}

interface ModelRegistryLegacy {
	readonly authStorage?: unknown;
	readonly modelsJsonPath?: string;
}

function resolve_parent_model_runtime(model_registry: ModelRegistry): unknown {
	const bridge = model_registry as unknown as ModelRegistryRuntimeBridge;
	if (bridge.runtime) return bridge.runtime;
	// Pi 0.80.6: no runtime field — createAgentSession accepts modelRegistry
	// directly. Return undefined so the caller skips the modelRuntime option.
	return undefined;
}

function is_legacy_model_registry(model_registry: ModelRegistry): boolean {
	const legacy = model_registry as unknown as ModelRegistryLegacy;
	return (
		!(model_registry as unknown as ModelRegistryRuntimeBridge).runtime &&
		Boolean(legacy.authStorage || legacy.modelsJsonPath !== undefined)
	);
}

const GENERIC_ABORT_PHRASES = [
	"this operation was aborted",
	"the operation was aborted",
	"request was aborted",
	"the signal was aborted",
	"operation was aborted",
];

export function isGenericAbortMessage(message: string | undefined): boolean {
	if (!message) return true;
	const lower = message.toLowerCase();
	return (
		GENERIC_ABORT_PHRASES.some((phrase) => lower.includes(phrase)) ||
		lower === "aborted" ||
		lower === "abort"
	);
}

/**
 * True when the message is one of pi-ai's generic stream-parser failures
 * ("Stream ended without finish_reason", "<provider> stream ended without a
 * terminal event", "Anthropic stream ended before message_stop", "OpenAI
 * Responses stream ended before a terminal response event"). pi-ai emits
 * these when the provider closes the SSE/event stream CLEANLY before a
 * terminal event: the thrown Error carries no `cause`, status, body, or event
 * data, so no underlying provider detail is recoverable from Ember-owned code
 * (we never patch upstream pi-ai). They are generic like abort messages and
 * must never shadow a specific provider/transport error captured earlier.
 */
export function is_parser_stream_error(message: string | undefined): boolean {
	if (!message) return false;
	return (
		/stream ended without finish_reason/i.test(message) ||
		/stream ended without a terminal event/i.test(message) ||
		/stream ended before message_stop/i.test(message) ||
		/stream ended before a terminal response event/i.test(message)
	);
}

/**
 * Deterministic suffix appended to a retained parser-stream failure so the
 * row states explicitly that the provider closed the stream early and NO
 * underlying error was reported. Honest by construction: we never invent a
 * status/body that pi-ai did not surface — the exact parser failure text is
 * retained and this note makes the irreducible limitation explicit.
 */
export const PARSER_STREAM_ERROR_LIMITATION_SUFFIX =
	" (provider closed the stream before a terminal finish event; no underlying error was reported \u2014 check provider status, model, and network)";

/** Append the limitation note once (idempotent). */
export function annotate_parser_stream_error(message: string): string {
	if (
		is_parser_stream_error(message) &&
		!message.includes(PARSER_STREAM_ERROR_LIMITATION_SUFFIX)
	) {
		return `${message}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`;
	}
	return message;
}

type FailureMessageTier = "specific" | "parser" | "abort";

/**
 * Tier of a candidate failure message. `specific` is a real provider/transport
 * reason; `parser` is a generic stream-parser failure (no underlying detail);
 * `abort` is a generic abort/empty message. Specific always outranks generic.
 */
function failure_message_tier(message: string | undefined): FailureMessageTier {
	if (!message || !message.trim()) return "abort";
	if (is_parser_stream_error(message)) return "parser";
	if (isGenericAbortMessage(message)) return "abort";
	return "specific";
}

/**
 * Pick the better of two candidate failure messages regardless of arrival
 * order: a specific (non-generic) message always wins over a generic
 * parser/abort message, and between two generic messages the later one wins.
 * This is the SSOT ordering rule used by every write site (message_end,
 * turn_end/agent_end, and the thrown-error catch block) so a real provider
 * error captured earlier is never overwritten by a later generic parser or
 * abort message, and vice versa.
 */
export function merge_failure_message(
	current: string | undefined,
	incoming: string | undefined,
): string | undefined {
	if (!incoming) return current;
	if (failure_message_tier(incoming) === "specific") return incoming;
	if (failure_message_tier(current) === "specific") return current;
	return incoming;
}

const MAX_CAUSE_CHAIN_DEPTH = 8;

/** Generic wrappers (aborts and parser-stream failures) add no provider detail. */
function is_wrapper_generic(message: string | undefined): boolean {
	return isGenericAbortMessage(message) || is_parser_stream_error(message);
}

/**
 * Extract the most useful failure message from a thrown error. Walks the full
 * Error.cause chain root-cause-first: a specific (non-generic, non-parser)
 * message anywhere in the chain wins, so a real provider/transport error
 * buried under pi-ai's generic parser wrapper surfaces instead of the
 * wrapper. When the whole chain is generic, keeps the outermost Error text
 * (never degrades to a stringified non-Error cause).
 */
export function extractFailureMessage(error: unknown): string {
	if (error === null || error === undefined) return "Unknown error";
	const chain: unknown[] = [];
	let current: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CAUSE_CHAIN_DEPTH && current !== null && current !== undefined;
		depth++
	) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	for (let i = chain.length - 1; i >= 0; i--) {
		const node = chain[i];
		if (node instanceof Error && node.message && !is_wrapper_generic(node.message)) {
			return node.message;
		}
	}
	for (const node of chain) {
		if (node instanceof Error && node.message) return node.message;
	}
	if (!(error instanceof Error)) return String(error);
	return "Unknown error";
}

/**
 * Pull the last assistant `errorMessage` from the message stream. Providers
 * fold real failure reasons (HTTP status + body, auth errors, etc.) into the
 * assistant message's `errorMessage` via `formatProviderError` before the
 * generic abort catch block can overwrite it. Parser-stream failures are
 * intentionally kept so `resolve_failure_message` can retain and annotate
 * them when nothing more specific exists.
 */
function lastAssistantErrorMessage(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const candidate = (msg as { errorMessage?: string }).errorMessage;
		if (candidate?.trim() && !isGenericAbortMessage(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve the best human-readable failure reason for a failed result, in
 * priority order: the most specific `errorMessage` across the top-level
 * result and the last assistant message (a specific provider/transport
 * reason beats a generic parser/abort message regardless of which source
 * carries it), non-empty `stderr`, or the last assistant text output.
 * A retained parser-stream failure is annotated with an explicit
 * limitation note (never replaced by a fallback, never silently dropped);
 * a generic abort/empty candidate falls through to stderr/output. Returns
 * undefined when nothing useful is available so callers can fall back to
 * short status labels.
 */
export function resolve_failure_message(result: SubAgentResult): string | undefined {
	if (!isFailedResult(result)) return undefined;
	const top = result.errorMessage;
	const fromMessages = lastAssistantErrorMessage(result.messages);
	let best: string | undefined;
	if (failure_message_tier(top) === "specific") {
		best = top;
	} else if (failure_message_tier(fromMessages) === "specific") {
		best = fromMessages;
	} else {
		best = merge_failure_message(top, fromMessages);
	}
	if (best && failure_message_tier(best) !== "abort") {
		return annotate_parser_stream_error(best);
	}
	if (result.stderr?.trim()) return result.stderr.trim();
	const finalOutput = getFinalOutput(result.messages).trim();
	if (finalOutput) return finalOutput;
	return undefined;
}

export interface SubAgentCheckpoint {
	parentSessionId: string;
	originToolCallId: string;
	displayName: string;
	agentName: string;
}

export interface SubAgentResume {
	parentSessionId: string;
	originToolCallId: string;
	displayName: string;
}

type SubagentStreamToolEvent = {
	toolCallId?: unknown;
	toolName?: string;
	name?: string;
	input?: unknown;
	args?: unknown;
	arguments?: unknown;
	/** `tool_execution_end` carries the tool result object. */
	result?: unknown;
	/** `message_end` / `turn_end` carry the finalized message(s). */
	message?: unknown;
	toolResults?: unknown;
};

/** Shape of `assistantMessageEvent` deltas we capture for live output. */
type SubagentStreamAssistantEvent = {
	type?: string;
	delta?: unknown;
	content?: unknown;
};

/** Coerce an unknown args payload to a Record (defensive — providers vary). */
function coerce_args(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Extract structured diff/match stats from a tool result, when present. */
function extract_result_details(result: unknown): Record<string, unknown> | undefined {
	if (result == null || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (details && typeof details === "object" && !Array.isArray(details)) {
		return details as Record<string, unknown>;
	}
	return undefined;
}

/** Whether a tool result reported an error. */
function result_is_error(result: unknown): boolean {
	if (result == null) return false;
	if (typeof result === "object" && "isError" in result) {
		return Boolean((result as { isError?: unknown }).isError);
	}
	return false;
}

/** Keep only the last SUBAGENT_LIVE_OUTPUT_MAX_ROWS live items. */
function trim_live_items(items: SubagentLiveItem[]): void {
	if (items.length > SUBAGENT_LIVE_OUTPUT_MAX_ROWS) {
		items.splice(0, items.length - SUBAGENT_LIVE_OUTPUT_MAX_ROWS);
	}
}

/**
 * Register or update a tool-call item in the bounded `liveItems` buffer.
 * `tool_execution_start`/`tool_call`/`tool_execution_update` refresh the
 * existing row for that `toolCallId` (or append a new running row);
 * `tool_execution_end` marks it completed in place — a call never stacks a
 * running row AND a completed duplicate. Id-less events fall back to the
 * latest same-name running row. The buffer keeps only the last
 * `SUBAGENT_LIVE_OUTPUT_MAX_ROWS` items. Returns true when the buffer changed.
 */
function note_live_tool_row(
	result: SubAgentResult,
	toolCallId: string | undefined,
	name: string,
	args: Record<string, unknown>,
	options: { completed?: boolean; error?: boolean; details?: Record<string, unknown> } = {},
): boolean {
	const items = result.liveItems ?? [];
	if (!result.liveItems) result.liveItems = items;
	const completed = options.completed ?? false;
	let existing: SubagentLiveToolRow | undefined;
	if (toolCallId !== undefined) {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i];
			if (item.kind === "tool" && item.row.toolCallId === toolCallId) {
				existing = item.row;
				break;
			}
		}
	}
	if (!existing && toolCallId === undefined) {
		const last = items[items.length - 1];
		if (last?.kind === "tool" && last.row.name === name && !last.row.completed) {
			existing = last.row;
		}
	}
	if (existing) {
		existing.args = args;
		if (completed) {
			existing.completed = true;
			existing.error = options.error ?? false;
			existing.details = options.details;
		}
		return true;
	}
	items.push({
		kind: "tool",
		row: {
			toolCallId,
			name,
			args,
			completed,
			error: options.error ?? false,
			details: options.details,
		},
	});
	trim_live_items(items);
	return true;
}

/**
 * Append an assistant text block to the live buffer. `openBlock` starts a
 * fresh block (`text_start`) so a completed block from an earlier message is
 * never appended to; deltas accumulate into the newest block, capped at
 * `SUBAGENT_LIVE_TEXT_MAX_CHARS`.
 */
function note_live_text_delta(result: SubAgentResult, delta: string, openBlock = false): void {
	if (!openBlock && delta.length === 0) return;
	const items = result.liveItems ?? [];
	if (!result.liveItems) result.liveItems = items;
	if (openBlock || items[items.length - 1]?.kind !== "text") {
		items.push({ kind: "text", text: "" });
		trim_live_items(items);
	}
	const last = items[items.length - 1];
	if (last?.kind === "text" && delta.length > 0) {
		const next = last.text + delta;
		last.text =
			next.length > SUBAGENT_LIVE_TEXT_MAX_CHARS
				? next.slice(0, SUBAGENT_LIVE_TEXT_MAX_CHARS)
				: next;
	}
}

/** Coerce a child event to a toolCallId when the provider supplies one. */
function event_tool_call_id(event: { toolCallId?: unknown }): string | undefined {
	return typeof event.toolCallId === "string" ? event.toolCallId : undefined;
}

/** Apply live child-session events that drive nested tool/thinking rows in the subagent renderer. */
export function apply_subagent_stream_event(
	result: SubAgentResult,
	event: {
		type: string;
		assistantMessageEvent?: SubagentStreamAssistantEvent;
	} & SubagentStreamToolEvent,
	notify: () => void,
): void {
	if (event.type === "turn_start" || event.type === "agent_start") {
		if (result.reasoning !== false && !result.latestToolCall && !result.isThinking) {
			result.isThinking = true;
			notify();
		}
		return;
	}
	if (event.type === "message_update") {
		const ev = event.assistantMessageEvent;
		if (ev?.type === "thinking_start" || ev?.type === "thinking_delta") {
			const cleared_tool = Boolean(result.latestToolCall);
			if (cleared_tool) delete result.latestToolCall;
			if (!result.isThinking || cleared_tool) {
				result.isThinking = true;
				notify();
			}
		} else if (ev?.type === "thinking_end") {
			if (result.isThinking) {
				result.isThinking = false;
				notify();
			}
		} else if (ev?.type === "text_start") {
			// Visible assistant text is a hard transcript boundary: open a fresh
			// live text block (the tray folds the prior tool wave below it).
			if (result.isThinking) result.isThinking = false;
			note_live_text_delta(result, "", true);
			notify();
		} else if (ev?.type === "text_delta") {
			if (result.isThinking) result.isThinking = false;
			const delta = typeof ev.delta === "string" ? ev.delta : "";
			note_live_text_delta(result, delta);
			notify();
		}
		return;
	}
	if (event.type === "tool_execution_start" || event.type === "tool_call") {
		result.isThinking = false;
		const name = event.toolName ?? event.name ?? "unknown";
		const args = coerce_args(event.input ?? event.args ?? event.arguments);
		result.latestToolCall = { name, args };
		note_live_tool_row(result, event_tool_call_id(event), name, args);
		notify();
		return;
	}
	if (event.type === "tool_execution_update") {
		result.isThinking = false;
		const name = event.toolName ?? event.name ?? result.latestToolCall?.name ?? "unknown";
		const args = coerce_args(
			event.args ?? event.input ?? event.arguments ?? result.latestToolCall?.args,
		);
		result.latestToolCall = { name, args };
		note_live_tool_row(result, event_tool_call_id(event), name, args);
		notify();
		return;
	}
	if (event.type === "tool_execution_end") {
		const name = event.toolName ?? result.latestToolCall?.name ?? "unknown";
		const toolCallId = event_tool_call_id(event);
		let args = result.latestToolCall?.args ?? {};
		if (toolCallId !== undefined) {
			// Resolve the stored args so a parallel batch's end event never
			// overwrites the row with another call's streaming args.
			for (const item of result.liveItems ?? []) {
				if (item.kind === "tool" && item.row.toolCallId === toolCallId) {
					args = item.row.args;
					break;
				}
			}
		}
		note_live_tool_row(result, toolCallId, name, args, {
			completed: true,
			error: result_is_error(event.result),
			details: extract_result_details(event.result),
		});
		notify();
		return;
	}
	// Keep latestToolCall visible after tool_execution_end until the next tool or thinking stream.
}

export async function runSubAgent(options: {
	cwd: string;
	systemPrompt: string;
	task: string;
	tools: string[];
	model: PiModel;
	modelRegistry: ModelRegistry;
	parentSignal?: AbortSignal;
	timeoutMs?: number;
	agentName?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	onUpdate?: (text: string) => void;
	onMessage?: (partialResult: SubAgentResult) => void;
	onToolCall?: (partialResult: SubAgentResult) => void;
	checkpoint?: SubAgentCheckpoint;
	resume?: SubAgentResume;
}): Promise<SubAgentResult> {
	const {
		cwd,
		systemPrompt,
		task,
		tools,
		model,
		modelRegistry,
		parentSignal,
		timeoutMs: timeoutMsInput,
		agentName = "subagent",
		thinkingLevel = "off",
		onMessage,
		onToolCall,
		checkpoint,
		resume,
	} = options;

	const timeoutMs = resolve_subagent_timeout_ms(timeoutMsInput);

	const timeoutController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	function resetOutputTimeout(): void {
		if (!timeoutController || !timeoutMs || timeoutMs <= 0) return;
		if (timeoutId) clearTimeout(timeoutId);
		timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
	}
	const signals = [parentSignal, timeoutController?.signal].filter((value): value is AbortSignal =>
		Boolean(value),
	);
	const combinedSignal =
		signals.length > 1
			? typeof AbortSignalCtor.any === "function"
				? AbortSignalCtor.any(signals)
				: signals[0]
			: signals[0];

	const agentDir = getAgentDir();

	const contextFiles = loadProjectContextFilesCompat({ cwd, agentDir });
	const contextPrefix =
		contextFiles.length > 0
			? `${contextFiles.map((f) => f.content).join("\n\n---\n\n")}\n\n---\n\n`
			: "";
	const fullSystemPrompt = contextPrefix + systemPrompt + PARALLEL_TOOL_CALL_GUIDANCE;

	const result: SubAgentResult = {
		agent: agentName,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: `${model.provider}/${model.id}`,
		reasoning: model.reasoning !== false,
		isThinking: false,
	};

	// Compaction (no parent UI extensions/skills).
	const extensionsResult = await load_subagent_extensions(cwd);
	const resourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => fullSystemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const settingsManager = SettingsManager.inMemory(build_subagent_settings());
	const model_runtime = resolve_parent_model_runtime(modelRegistry);
	const legacy_registry = is_legacy_model_registry(modelRegistry);

	// Deterministic bootstrap: mkdirSync(recursive) runs synchronously here, so
	// the <originToolCallId> dir is guaranteed to exist before SessionManager
	// records the <timestamp>_<childSessionId>.jsonl run-record and before any
	// checkpoint/resume metadata write. Never rely on a prior async op or on an
	// existsSync pre-check for correctness (a concurrent prune on session
	// shutdown can remove the dir between events).
	const checkpoint_dir =
		checkpoint?.parentSessionId && checkpoint.originToolCallId
			? subagent_sessions_dir_for(checkpoint.parentSessionId, checkpoint.originToolCallId)
			: resume?.parentSessionId && resume.originToolCallId
				? subagent_sessions_dir_for(resume.parentSessionId, resume.originToolCallId)
				: undefined;

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;

	// Abort handling: if the parent signal fires before the session is created,
	// we bail. Once the session exists, we call session.abort() so the SDK can
	// clean up gracefully.
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		if (session && typeof session.abort === "function") {
			session.abort().catch(() => {});
		}
	};

	let sessionManager: SessionManager;
	try {
		// Hold a live mark on the checkpoint dir for the entire run so a
		// concurrent `prune_foreign_checkpoints()` (foreign session shutdown)
		// can never delete it between the bootstrap above and the SDK's lazy
		// first run-record write. Deterministically guarantees the directory
		// exists for every SDK open/write.
		if (checkpoint_dir) mark_checkpoint_dir_live(checkpoint_dir);

		if (resume && checkpoint_dir) {
			const meta = read_resume_meta(resume.parentSessionId, resume.originToolCallId);
			if (!meta?.sessionFile || !fs.existsSync(meta.sessionFile)) {
				// The run never started — release the live mark (durable marker +
				// in-memory Set) so this dir is not protected by a dead run.
				if (checkpoint_dir) unmark_checkpoint_dir_live(checkpoint_dir);
				return failedResult(
					agentName,
					task,
					"error",
					`No saved session for ${resume.displayName}. Spawn with subagent first.`,
				);
			}
			try {
				sessionManager = SessionManager.open(meta.sessionFile, checkpoint_dir, cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// The run never started — release the live mark (durable marker +
				// in-memory Set) so this dir is not protected by a dead run.
				if (checkpoint_dir) unmark_checkpoint_dir_live(checkpoint_dir);
				return failedResult(
					agentName,
					task,
					"error",
					`Resume session for ${resume.displayName} is missing or corrupted. ${message}`,
				);
			}
			trim_trailing_assistant_messages(sessionManager);
		} else if (checkpoint && checkpoint_dir) {
			sessionManager = SessionManager.create(cwd, checkpoint_dir);
		} else {
			sessionManager = SessionManager.inMemory(cwd);
		}

		if (combinedSignal) {
			if (combinedSignal.aborted) {
				if (timeoutId) clearTimeout(timeoutId);
				const isTimeout = timeoutController?.signal.aborted && !parentSignal?.aborted;
				// The run never started — release the live mark (durable marker +
				// in-memory Set) so this dir is not protected by a dead run.
				if (checkpoint_dir) unmark_checkpoint_dir_live(checkpoint_dir);
				return failedResult(
					agentName,
					task,
					isTimeout ? "timeout" : "aborted",
					isTimeout ? `Timeout after ${timeoutMs}ms` : "Sub-agent aborted before start",
				);
			}
			combinedSignal.addEventListener("abort", onAbort, { once: true });
		}
	} catch (error) {
		// Any unexpected failure between mark and the run must release the live
		// mark (durable marker + in-memory Set) so a dead dir is never protected.
		if (checkpoint_dir) unmark_checkpoint_dir_live(checkpoint_dir);
		throw error;
	}

	try {
		const session_options: Record<string, unknown> = {
			cwd,
			model,
			thinkingLevel,
			resourceLoader,
			tools,
			sessionManager,
			settingsManager,
		};
		// Pi 0.80.10+ exposes the canonical ModelRuntime via the registry facade;
		// pass it through so child sessions inherit every registered provider,
		// credential source, and custom models.json entry. Pi 0.80.6 has no
		// ModelRuntime — createAgentSession takes modelRegistry directly.
		if (model_runtime) {
			session_options.modelRuntime = model_runtime;
		} else if (legacy_registry) {
			session_options.modelRegistry = modelRegistry;
		}
		const created = await createAgentSession(session_options);
		session = created.session;

		if (resume) {
			result.messages = load_prior_messages(session);
			result.usage.turns = result.messages.filter((m) => m.role === "assistant").length;
		}

		if (aborted) {
			throw new Error("Sub-agent aborted before start");
		}

		const notify_subagent_activity = (): void => {
			onToolCall?.({ ...result, messages: [...result.messages] });
		};

		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			// Idle timeout: reset on every child-session event so it fires only when
			// the subagent stops producing *any* output/activity for timeoutMs.
			resetOutputTimeout();
			apply_subagent_stream_event(result, event, notify_subagent_activity);
			if (event.type === "message_end") {
				const msg = event.message as Message | undefined;
				if (msg && msg.role === "assistant") {
					result.usage.turns++;
					if (msg.usage) {
						result.usage.input += msg.usage.input || 0;
						result.usage.output += msg.usage.output || 0;
						result.usage.cacheRead += msg.usage.cacheRead || 0;
						result.usage.cacheWrite += msg.usage.cacheWrite || 0;
						result.usage.cost += msg.usage.cost?.total || 0;
						result.usage.contextTokens = msg.usage.totalTokens || 0;
					}
					if (!result.model && msg.model) {
						result.model = `${msg.provider || "?"}/${msg.model}`;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					// Capture the assistant errorMessage with the specificity ordering
					// rule: a later generic parser/abort message must never overwrite a
					// specific provider/transport error captured earlier.
					if (msg.errorMessage) {
						result.errorMessage = merge_failure_message(result.errorMessage, msg.errorMessage);
					}
				}
				if (msg) {
					result.messages.push(msg);
					onMessage?.({ ...result, messages: [...result.messages] });
				}
			}
			if (event.type === "agent_end" || event.type === "turn_end") {
				// A provider error frequently arrives at run/turn end rather than a
				// normal message_end (auth/network/stopReason errors). Pull the
				// stopReason + non-generic errorMessage from those messages so a
				// failed child run never degrades to a bare ✗ with no reason.
				const end_msgs: Message[] = [];
				if (event.type === "agent_end" && Array.isArray(event.messages)) {
					end_msgs.push(...(event.messages as Message[]));
				} else if (event.type === "turn_end" && event.message) {
					end_msgs.push(event.message as Message);
				}
				for (const m of end_msgs) {
					if (m && m.role === "assistant") {
						if (m.stopReason) result.stopReason = m.stopReason;
						// Aborts are skipped here (the dedicated abort finalization owns
						// them); parser/stream and specific messages merge with the same
						// specificity ordering as message_end.
						if (m.errorMessage && !isGenericAbortMessage(m.errorMessage)) {
							result.errorMessage = merge_failure_message(result.errorMessage, m.errorMessage);
						}
					}
				}
				if (result.messages.length === 0 && end_msgs.length > 0) {
					result.messages = end_msgs;
				}
			}
		});

		let overflow_retried = false;
		let length_continues = 0;
		let pending_task = task;
		let websocket_retries = 0;
		let http500_retried = false;
		while (true) {
			// Re-ensure the checkpoint dir AND refresh the durable live marker
			// before each prompt so a concurrent prune (session_shutdown of a
			// foreign parent session) cannot leave the SDK's next run-record write
			// without a parent directory and cannot observe a stale marker on a
			// long multi-prompt run. Cheap and idempotent.
			if (checkpoint_dir) mark_checkpoint_dir_live(checkpoint_dir);

			// Pre-emptive overflow guard: if the next prompt would exceed the model's
			// context window plus a 10% tokenizer-safety headroom, compact the child
			// session before sending. This deterministically avoids the arbitrary
			// "prompt is too long" / "exceeds the context window" errors instead of
			// catching them after they happen.
			if (session && should_compact_before_prompt(session, pending_task)) {
				await compact_subagent_session(session);
				// If compaction did not shrink enough, the next iteration's check will
				// catch it; do not infinite-loop.
			}

			// Snapshot the pre-prompt session/result state so a failed pre-response
			// attempt can be rolled back before the single retry: the retry must
			// re-send the same task exactly once, with no duplicate user message on
			// the active session branch and no stale failed assistant in the live
			// agent context or result accounting.
			const retry_rollback: Http500RetryRollback = {
				retryAnchor: session.sessionManager.getLeafId(),
				messagesBefore: result.messages.length,
				liveItemsBefore: result.liveItems?.length ?? 0,
				usageBefore: { ...result.usage },
			};

			try {
				await session.prompt(pending_task);
			} catch (prompt_error) {
				const prompt_error_message = extractFailureMessage(prompt_error);
				if (!overflow_retried && session && is_context_overflow_error(prompt_error_message)) {
					overflow_retried = true;
					await compact_subagent_session(session);
					continue;
				}
				if (
					!aborted &&
					session &&
					is_websocket_error(prompt_error_message) &&
					websocket_retries < MAX_SUBAGENT_WEBSOCKET_RETRIES
				) {
					websocket_retries++;
					rollback_failed_prompt_attempt(result, session, retry_rollback);
					result.stopReason = undefined;
					result.errorMessage = undefined;
					continue;
				}
				throw prompt_error;
			}
			// Pre-response transient HTTP 500 retry (at most once). The child
			// runner intentionally disables core retry, and providers surface a
			// pre-response empty-body 500 as a *resolved* failed assistant message
			// rather than a thrown error, so the catch-based websocket retry above
			// never fires. Detect the resolved failure after prompt() settles and
			// re-run the same task once after a short abortable backoff when no
			// visible text or tool call was emitted.
			const http500_retry = await decide_pre_response_http500_retry({
				result,
				aborted,
				http500_retried,
				signal: combinedSignal,
				session,
				rollback: retry_rollback,
			});
			if (http500_retry === "retry") {
				http500_retried = true;
				continue;
			}
			if (http500_retry === "aborted") {
				break;
			}
			websocket_retries = 0;
			if (result.stopReason !== "length" || length_continues >= MAX_SUBAGENT_LENGTH_CONTINUES) {
				break;
			}
			length_continues++;
			pending_task = SUBAGENT_CONTINUE_PROMPT;
		}
		if (result.stopReason === "length" && !result.errorMessage) {
			result.errorMessage = "Output limit reached and continuation was exhausted.";
		}
		if (!aborted && result.stopReason === "aborted") {
			if (result.errorMessage) {
				result.stopReason = "error";
				result.exitCode = 1;
			} else {
				result.stopReason = undefined;
				result.exitCode = 0;
			}
		} else if (
			result.stopReason === "aborted" ||
			result.stopReason === "error" ||
			result.stopReason === "timeout" ||
			result.stopReason === "length"
		) {
			result.exitCode = 1;
		} else {
			result.exitCode = 0;
		}
	} catch (error) {
		result.exitCode = 1;
		if (!aborted && result.stopReason === "aborted") {
			result.stopReason = "error";
		} else {
			result.stopReason = result.stopReason || "error";
		}
		const caught = extractFailureMessage(error);
		// Prefer a richer caught message over an existing generic/empty one so
		// real provider/network errors surfaced by the catch block are not
		// dropped in favor of opaque abort or parser-stream strings. The
		// specificity ordering is symmetric: a specific error already captured
		// from the event stream is never replaced by a generic caught message.
		if (caught) {
			result.errorMessage = merge_failure_message(result.errorMessage, caught);
		}
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (combinedSignal) combinedSignal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			if (session && checkpoint_dir && (checkpoint || resume) && result.exitCode !== -1) {
				const session_file = session.sessionManager.getSessionFile();
				if (session_file) {
					const checkpoint_source = checkpoint ?? resume;
					if (checkpoint_source) {
						const meta: ResumeCheckpointMeta = {
							parentSessionId: checkpoint_source.parentSessionId,
							originToolCallId: checkpoint_source.originToolCallId,
							displayName: checkpoint?.displayName ?? checkpoint_source.displayName,
							agentName:
								checkpoint?.agentName ?? infer_bare_agent_name(checkpoint_source.displayName),
							cwd,
							sessionFile: session_file,
							updatedAt: new Date().toISOString(),
						};
						// Persist checkpoint metadata (meta.json + index.json) WHILE the
						// durable live marker is still held, so a foreign prune can never
						// observe an unprotected incomplete checkpoint. The live mark is
						// dropped only after this write, below.
						persist_checkpoint_meta(meta);
					}
				}
			}
			session?.dispose();
		} catch {
			/* best-effort finalize; never mask the run result */
		}
		// Drop the live mark LAST — after checkpoint persistence and session
		// disposal — so the dir stays protected for the entire finalization path
		// and only becomes disposable once the checkpoint is complete.
		if (checkpoint_dir) unmark_checkpoint_dir_live(checkpoint_dir);
	}

	// Surface the actual failure reason instead of the provider's generic
	// "This operation was aborted" / "Request was aborted" string. Only run
	// when the run actually failed — a successful stop with no errorMessage
	// must not be force-marked failed.
	if (timeoutController?.signal.aborted && !parentSignal?.aborted) {
		const has_real_error =
			Boolean(result.errorMessage && !isGenericAbortMessage(result.errorMessage)) ||
			Boolean(lastAssistantErrorMessage(result.messages));
		if (!has_real_error) {
			result.exitCode = 1;
			result.stopReason = "timeout";
			result.errorMessage =
				result.messages.length === 0
					? `Timed out after ${timeoutMs}ms with no output`
					: `Timed out after ${timeoutMs}ms idle`;
		}
	} else if (parentSignal?.aborted) {
		result.exitCode = 1;
		result.stopReason = result.stopReason === "timeout" ? "timeout" : "aborted";
		if (isGenericAbortMessage(result.errorMessage)) {
			result.errorMessage = "Cancelled: parent operation aborted";
		}
	} else if (isFailedResult(result)) {
		const resolved = resolve_failure_message(result);
		if (resolved) {
			result.errorMessage = resolved;
		} else {
			// Never leave a failed result caption-less. Every consumer (compact
			// TUI row, thread-viewer, expanded view, and the orchestrator tool
			// result / model-visible content) resolves the reason through
			// `resolve_failure_message`, so a failed run must always carry a
			// concrete, actionable message instead of degrading to a bare ✗ or an
			// unhelpful "(no output)" upstream.
			result.errorMessage =
				result.stopReason === "timeout"
					? `Subagent timed out${timeoutMs ? ` after ${Math.round(timeoutMs / 1000)}s` : ""}`
					: result.stopReason === "aborted"
						? "Subagent aborted"
						: result.stopReason === "length"
							? "Output limit reached"
							: "Subagent failed";
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failedResult(
	agent: string,
	task: string,
	stopReason: SubAgentResult["stopReason"],
	errorMessage: string,
): SubAgentResult {
	return {
		agent,
		task,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		stopReason,
		errorMessage,
	};
}

function load_prior_messages(
	session: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]>,
): Message[] {
	const branch = session.sessionManager.getBranch?.() ?? [];
	const messages: Message[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message as Message | undefined;
		if (!msg) continue;
		if (msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult") {
			messages.push(msg);
		}
	}
	return messages;
}

function loadProjectContextFilesCompat({
	cwd,
	agentDir,
}: {
	cwd: string;
	agentDir: string;
}): { content: string }[] {
	try {
		return loadProjectContextFiles({ cwd, agentDir });
	} catch {
		return [];
	}
}

export function getFinalOutput(messages: Message[]): string {
	// Prefer the last assistant message with non-empty text and NO tool calls (pure final answer).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts: string[] = [];
		let hasToolCalls = false;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) texts.push(part.text);
			else if (part.type === "toolCall") hasToolCalls = true;
		}
		if (texts.length > 0 && !hasToolCalls) return texts.join("");
	}
	// Fallback: last assistant message with any non-empty text (even if it also has tool calls).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const texts = msg.content
			.filter(
				(p): p is { type: "text"; text: string } => p.type === "text" && p.text.trim().length > 0,
			)
			.map((p) => p.text);
		if (texts.length > 0) return texts.join("");
	}
	return "";
}

export function isFailedResult(result: SubAgentResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	);
}

export function getResultOutput(result: SubAgentResult): string {
	if (isFailedResult(result)) {
		return resolve_failure_message(result) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function agent_result_status_label(result: SubAgentResult): string {
	if (result.exitCode === -1) return "running";
	if (isFailedResult(result)) {
		return result.stopReason ? `failed (${result.stopReason})` : "failed";
	}
	return "completed";
}

/** Raw answer body for orchestrator tool-result content (no lettered label). */
export function get_agent_result_body(result: SubAgentResult): string {
	if (result.exitCode === -1) {
		const partial = getFinalOutput(result.messages).trim();
		return partial || "(running...)";
	}
	return getResultOutput(result);
}

/**
 * Model-visible subagent tool-result text with lettered agent label (e.g. Coder A).
 * SSOT for orchestrator context — TUI uses details + render.ts separately.
 */
export function format_agent_tool_result_text(
	result: SubAgentResult,
	format_body: (body: string) => string = (body) => body,
): string {
	const label = result.agent.trim();
	const body = format_body(get_agent_result_body(result));
	return `### [${label}] ${agent_result_status_label(result)}\n\n${body}`;
}

export function format_agent_tool_result_batch(
	results: SubAgentResult[],
	options?: {
		header?: string;
		format_body?: (body: string) => string;
		separator?: string;
	},
): string {
	const format_body = options?.format_body ?? ((body: string) => body);
	const separator = options?.separator ?? "\n\n---\n\n";
	const body = results.map((r) => format_agent_tool_result_text(r, format_body)).join(separator);
	return options?.header ? `${options.header}\n\n${body}` : body;
}

export function agent_tool_result_content(
	result: SubAgentResult,
	format_body?: (body: string) => string,
): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text: format_agent_tool_result_text(result, format_body) }];
}

/** Concurrency-limited map. Runs up to `concurrency` async operations at a time. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
