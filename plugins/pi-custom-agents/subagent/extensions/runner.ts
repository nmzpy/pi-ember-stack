/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Runs an isolated AgentSession in-process on the main thread, reusing the
 * parent's canonical ModelRuntime through its extension-facing ModelRegistry
 * facade. This keeps every registered provider (Devin, xAI, built-ins, custom
 * models.json entries) and credential source available without re-registration.
 * The session uses a minimal system prompt, no extensions,
 * no skills, no prompt templates, no thinking, and no compaction.
 *
 * session.prompt() is async and does not block the TUI render loop — pi's
 * event loop keeps rendering while the subagent streams. This avoids the
 * worker_thread boundary that previously prevented provider inheritance.
 */

import type { Message, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	getAgentDir,
	loadProjectContextFiles,
	type ModelRegistry,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARALLEL_TOOL_CALL_GUIDANCE = `

## Tool Call Efficiency

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching saves round-trips and reduces latency.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
	stopReason?: string;
	errorMessage?: string;
	latestToolCall?: { name: string; args: any };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface ModelRegistryRuntimeBridge {
	readonly runtime?: ModelRuntime;
}

/**
 * Pi exposes ModelRegistry to extensions as a synchronous compatibility facade,
 * while createAgentSession consumes the canonical ModelRuntime. Keep the one
 * unavoidable bridge at this SDK boundary so every subagent path reuses the
 * parent's exact provider/auth runtime instead of copying credentials or
 * rebuilding provider catalogs.
 */
function resolve_parent_model_runtime(model_registry: ModelRegistry): ModelRuntime {
	const model_runtime = (model_registry as unknown as ModelRegistryRuntimeBridge).runtime;
	if (!model_runtime) {
		throw new Error(
			"Subagent requires a Pi ModelRegistry backed by ModelRuntime (Pi 0.80.10 or newer).",
		);
	}
	return model_runtime;
}

export async function runSubAgent(options: {
	cwd: string;
	systemPrompt: string;
	task: string;
	tools: string[];
	model: Model<any>;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	agentName?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	onUpdate?: (text: string) => void;
	onMessage?: (partialResult: SubAgentResult) => void;
	onToolCall?: (partialResult: SubAgentResult) => void;
}): Promise<SubAgentResult> {
	const {
		cwd,
		systemPrompt,
		task,
		tools,
		model,
		modelRegistry,
		signal,
		agentName = "subagent",
		thinkingLevel = "off",
		onMessage,
		onToolCall,
	} = options;

	if (signal?.aborted) {
		return failedResult(agentName, task, "aborted", "Sub-agent aborted before start");
	}

	const agentDir = getAgentDir();

	const contextFiles = loadProjectContextFilesCompat({ cwd, agentDir });
	const contextPrefix =
		contextFiles.length > 0
			? contextFiles.map((f) => f.content).join("\n\n---\n\n") + "\n\n---\n\n"
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
	};

	// Empty resource loader — no parent extensions, skills, prompts, or themes.
	// createExtensionRuntime() provides the required ExtensionRuntime shape
	// (pendingProviderRegistrations, flagValues, assertActive, ...) so
	// createAgentSession's ExtensionRunner.bindCore() does not crash.
	const resourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => fullSystemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const model_runtime = resolve_parent_model_runtime(modelRegistry);

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
	if (signal) {
		if (signal.aborted) {
			return failedResult(agentName, task, "aborted", "Sub-agent aborted before start");
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const created = await createAgentSession({
			cwd,
			model,
			thinkingLevel,
			modelRuntime: model_runtime,
			resourceLoader,
			tools,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});
		session = created.session;

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
			result.latestToolCall = {
				name: event.toolName ?? event.name ?? "unknown",
				args: (event.input ?? event.args ?? event.arguments ?? {}) as Record<string, unknown>,
			};
			onToolCall?.({ ...result, messages: [...result.messages] });
		};

		unsubscribe = session.subscribe((event: { type: string; [key: string]: any }) => {
			// Pi agent sessions emit tool_execution_start; extension hooks use tool_call.
			if (event.type === "tool_execution_start" || event.type === "tool_call") {
				capture_latest_tool_call(event as Parameters<typeof capture_latest_tool_call>[0]);
			}
			if (event.type === "message_end") {
				const msg = event.message;
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
				result.messages = event.messages;
			}
		});

		await session.prompt(task);
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
		result.errorMessage =
			result.errorMessage || (error instanceof Error ? error.message : String(error));
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		try {
			session?.dispose();
		} catch {}
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
