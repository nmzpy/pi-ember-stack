/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Runs an isolated AgentSession in-process on the main thread, reusing the
 * parent's canonical ModelRuntime through its extension-facing ModelRegistry
 * facade. This keeps every registered provider (Devin, xAI, built-ins, custom
 * models.json entries) and credential source available without re-registration.
 * Child sessions enable Pi compaction (Ember summarizer via compaction-wiring) and,
 * when global DCP is enabled, outbound pruning strategies without the DCP
 * compress tool.
 *
 * session.prompt() is async and does not block the TUI render loop — pi's
 * event loop keeps rendering while the subagent streams. This avoids the
 * worker_thread boundary that previously prevented provider inheritance.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	discoverAndLoadExtensions,
	getAgentDir,
	loadProjectContextFiles,
	type LoadExtensionsResult,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { is_benign_compact_error, should_skip_compact } from "../../auto-continue.ts";
import { is_dcp_enabled_for_subagent } from "../../../pi-ember-dcp/lib/wiring.ts";
import { infer_bare_agent_name } from "../../subagent-policy.ts";
import {
	get_checkpoint_dir,
	persist_checkpoint_meta,
	read_resume_meta,
	type ResumeCheckpointMeta,
} from "./resume-store.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;

const SUBAGENT_EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPACTION_WIRING_PATH = path.resolve(SUBAGENT_EXT_DIR, "../../compaction-wiring.ts");
const DCP_SUBAGENT_WIRING_PATH = path.resolve(
	SUBAGENT_EXT_DIR,
	"../../../pi-ember-dcp/subagent-wiring.ts",
);

const PARALLEL_TOOL_CALL_GUIDANCE = `

## Tool Call Efficiency

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching saves round-trips and reduces latency.
`;

const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i,
	/exceeds the context window/i,
	/maximum context length/i,
	/context window exceeds/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

/** In-memory settings for subagent child sessions — compaction on, retries off. */
export function build_subagent_settings(): {
	compaction: { enabled: boolean };
	retry: { enabled: boolean };
} {
	return {
		compaction: { enabled: true },
		retry: { enabled: false },
	};
}

export function is_context_overflow_error(message: string | undefined): boolean {
	if (!message) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

async function load_subagent_extensions(cwd: string): Promise<LoadExtensionsResult> {
	const paths = [COMPACTION_WIRING_PATH];
	if (is_dcp_enabled_for_subagent(cwd)) {
		paths.push(DCP_SUBAGENT_WIRING_PATH);
	}
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

function extractFailureMessage(error: unknown): string {
	if (error === null || error === undefined) return "Unknown error";
	const cause = (error as { cause?: unknown }).cause;
	if (cause instanceof Error && cause.message && !isGenericAbortMessage(cause.message)) {
		return cause.message;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Pull the last assistant `errorMessage` from the message stream. Providers
 * fold real failure reasons (HTTP status + body, auth errors, etc.) into the
 * assistant message's `errorMessage` via `formatProviderError` before the
 * generic abort catch block can overwrite it.
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
 * priority order: a non-generic `errorMessage`, the last assistant message's
 * non-generic `errorMessage`, non-empty `stderr`, or the last assistant text
 * output. Returns undefined when nothing useful is available so callers can
 * fall back to short status labels.
 */
export function resolve_failure_message(result: SubAgentResult): string | undefined {
	if (!isFailedResult(result)) return undefined;
	if (result.errorMessage && !isGenericAbortMessage(result.errorMessage)) {
		return result.errorMessage;
	}
	const fromMessages = lastAssistantErrorMessage(result.messages);
	if (fromMessages) return fromMessages;
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
		timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
		agentName = "subagent",
		thinkingLevel = "off",
		onMessage,
		onToolCall,
		checkpoint,
		resume,
	} = options;

	let lastOutputTime = Date.now();
	const timeoutController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	function resetOutputTimeout(): void {
		if (!timeoutController || !timeoutMs || timeoutMs <= 0) return;
		if (timeoutId) clearTimeout(timeoutId);
		lastOutputTime = Date.now();
		timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
	}
	resetOutputTimeout();
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
		reasoning: model.reasoning === true,
		isThinking: false,
	};

	// Compaction + optional DCP strategies (no parent UI extensions/skills).
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

	const checkpoint_dir =
		checkpoint?.parentSessionId && checkpoint.originToolCallId
			? get_checkpoint_dir(checkpoint.parentSessionId, checkpoint.originToolCallId)
			: resume?.parentSessionId && resume.originToolCallId
				? get_checkpoint_dir(resume.parentSessionId, resume.originToolCallId)
				: undefined;

	let sessionManager: SessionManager;
	if (resume && checkpoint_dir) {
		const meta = read_resume_meta(resume.parentSessionId, resume.originToolCallId);
		if (!meta?.sessionFile) {
			return failedResult(
				agentName,
				task,
				"error",
				`No saved session for ${resume.displayName}. Spawn with subagent first.`,
			);
		}
		sessionManager = SessionManager.open(meta.sessionFile, checkpoint_dir, cwd);
	} else if (checkpoint && checkpoint_dir) {
		sessionManager = SessionManager.create(cwd, checkpoint_dir);
	} else {
		sessionManager = SessionManager.inMemory(cwd);
	}

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
	if (combinedSignal) {
		if (combinedSignal.aborted) {
			if (timeoutId) clearTimeout(timeoutId);
			const isTimeout = timeoutController?.signal.aborted && !parentSignal?.aborted;
			return failedResult(
				agentName,
				task,
				isTimeout ? "timeout" : "aborted",
				isTimeout ? `Timeout after ${timeoutMs}ms` : "Sub-agent aborted before start",
			);
		}
		combinedSignal.addEventListener("abort", onAbort, { once: true });
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

		const capture_latest_tool_call = (event: {
			toolName?: string;
			name?: string;
			input?: unknown;
			args?: unknown;
			arguments?: unknown;
		}): void => {
			result.isThinking = false;
			result.latestToolCall = {
				name: event.toolName ?? event.name ?? "unknown",
				args: (event.input ?? event.args ?? event.arguments ?? {}) as Record<string, unknown>,
			};
			onToolCall?.({ ...result, messages: [...result.messages] });
		};

		const clear_latest_tool_call = (): void => {
			if (!result.latestToolCall) return;
			delete result.latestToolCall;
			onToolCall?.({ ...result, messages: [...result.messages] });
		};

		const notify_subagent_activity = (): void => {
			onToolCall?.({ ...result, messages: [...result.messages] });
		};

		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			resetOutputTimeout();
			if (event.type === "message_update") {
				const ev = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
				if (ev?.type === "thinking_start" || ev?.type === "thinking_delta") {
					if (!result.isThinking) {
						result.isThinking = true;
						notify_subagent_activity();
					}
				} else if (
					ev?.type === "thinking_end" ||
					ev?.type === "text_start" ||
					ev?.type === "text_delta"
				) {
					if (result.isThinking) {
						result.isThinking = false;
						notify_subagent_activity();
					}
				}
			}
			// Pi agent sessions emit tool_execution_start; extension hooks use tool_call.
			if (
				event.type === "tool_execution_start" ||
				(event as { type: string }).type === "tool_call"
			) {
				capture_latest_tool_call(event as Parameters<typeof capture_latest_tool_call>[0]);
			}
			if (
				event.type === "tool_execution_end" ||
				(event as { type: string }).type === "tool_result"
			) {
				clear_latest_tool_call();
			}
			if (event.type === "message_end") {
				resetOutputTimeout();
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
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
				}
				if (msg) {
					result.messages.push(msg);
					onMessage?.({ ...result, messages: [...result.messages] });
				}
			}
			if (event.type === "agent_end" && result.messages.length === 0 && event.messages) {
				result.messages = event.messages as Message[];
			}
		});

		let overflow_retried = false;
		while (true) {
			try {
				await session.prompt(task);
				break;
			} catch (prompt_error) {
				const overflow_message = extractFailureMessage(prompt_error);
				if (
					!overflow_retried &&
					session &&
					is_context_overflow_error(overflow_message)
				) {
					overflow_retried = true;
					await compact_subagent_session(session);
					continue;
				}
				throw prompt_error;
			}
		}
		if (!aborted && result.stopReason === "aborted") {
			if (result.errorMessage) {
				result.stopReason = "error";
				result.exitCode = 1;
			} else {
				result.stopReason = undefined;
				result.exitCode = 0;
			}
		} else {
			result.exitCode = result.stopReason === "aborted" ? 1 : 0;
		}
	} catch (error) {
		result.exitCode = 1;
		if (!aborted && result.stopReason === "aborted") {
			result.stopReason = "error";
		} else {
			result.stopReason = result.stopReason || "error";
		}
		const caught = extractFailureMessage(error);
		// Prefer a richer caught message over a generic/empty existing one so
		// real provider/network errors surfaced by the catch block are not
		// dropped in favor of opaque abort strings.
		if (caught && (!result.errorMessage || isGenericAbortMessage(result.errorMessage))) {
			result.errorMessage = caught;
		}
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (combinedSignal) combinedSignal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			if (session && checkpoint_dir && (checkpoint || resume) && result.exitCode !== -1) {
				const session_file = session.sessionManager.getSessionFile();
				if (session_file) {
					const meta: ResumeCheckpointMeta = {
						parentSessionId: (checkpoint ?? resume)!.parentSessionId,
						originToolCallId: (checkpoint ?? resume)!.originToolCallId,
						displayName: checkpoint?.displayName ?? resume!.displayName,
						agentName: checkpoint?.agentName ?? infer_bare_agent_name(resume!.displayName),
						cwd,
						sessionFile: session_file,
						updatedAt: new Date().toISOString(),
					};
					persist_checkpoint_meta(meta);
				}
			}
			session?.dispose();
		} catch {}
	}

	// Surface the actual failure reason instead of the provider's generic
	// "This operation was aborted" / "Request was aborted" string. Only run
	// when the run actually failed — a successful stop with no errorMessage
	// must not be force-marked failed.
	if (timeoutController?.signal.aborted && !parentSignal?.aborted) {
		const elapsed = Date.now() - lastOutputTime;
		result.exitCode = 1;
		result.stopReason = "timeout";
		result.errorMessage = `Timeout after ${elapsed}ms with no output`;
		// Preserve the original 300s default in the public summary when the
		// deadline has never been reset; otherwise report the idle gap so users
		// see the timer started from the last subagent output, not the run start.
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
		} else if (isGenericAbortMessage(result.errorMessage)) {
			result.errorMessage =
				result.stopReason === "aborted" ? "Subagent aborted" : "Subagent failed";
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
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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
