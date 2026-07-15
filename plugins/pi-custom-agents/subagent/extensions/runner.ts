/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Compared to process-spawn, this saves ~4-11K tokens per invocation by using
 * the pi SDK directly with a minimal system prompt, no extensions, no skills,
 * no prompt templates, no thinking, and no compaction. To avoid blocking the
 * parent TUI thread while the subagent runs, each agent is executed in a
 * Node worker_thread and messages its progress back.
 */

import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
	type AuthStorage,
	getAgentDir,
	type ModelRegistry,
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
}

interface WorkerInput {
	cwd: string;
	agentDir: string;
	authPath: string;
	modelsPath: string | undefined;
	systemPrompt: string;
	fullSystemPrompt: string;
	task: string;
	tools: string[];
	model: Model<any>;
	agentName: string;
	thinkingLevel: string;
}

// ---------------------------------------------------------------------------
// Worker script — kept inline so the package stays self-contained. Worker
// threads cannot load .ts via jiti, so the code is written as plain JS and
// executed from a data: URL.
// ---------------------------------------------------------------------------

const WORKER_SCRIPT = `
const { parentPort, workerData } = require("node:worker_threads");

function post(type, payload) {
	parentPort?.postMessage({ type, payload });
}

const result = {
	agent: workerData.agentName || "subagent",
	task: workerData.task,
	exitCode: 0,
	messages: [],
	stderr: "",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	model: workerData.model ? \`\${workerData.model.provider}/\${workerData.model.id}\` : undefined,
};

async function main() {
// @earendil-works/pi-coding-agent is ESM-only (\"type\": \"module\", exports
// map has no require condition), so use dynamic import() instead of require().
const { createAgentSession, getAgentDir, loadProjectContextFiles, AuthStorage, ModelRegistry, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");

	const authStorage = AuthStorage.create(workerData.authPath);
	const modelRegistry = ModelRegistry.create(authStorage, workerData.modelsPath);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });

	const resourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => workerData.fullSystemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const { session } = await createAgentSession({
		cwd: workerData.cwd,
		model: workerData.model,
		thinkingLevel: workerData.thinkingLevel || "off",
		authStorage,
		modelRegistry,
		resourceLoader,
		tools: workerData.tools,
		sessionManager: SessionManager.inMemory(workerData.cwd),
		settingsManager,
	});

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end") {
			const msg = event.message;
			if (msg.role === "assistant") {
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
					result.model = \`\${msg.provider || "?"}/\${msg.model}\`;
				}
				if (msg.stopReason) result.stopReason = msg.stopReason;
				if (msg.errorMessage) result.errorMessage = msg.errorMessage;
			}
			result.messages.push(msg);
			post("message", { ...result, messages: [...result.messages] });
		}
		if (event.type === "agent_end" && result.messages.length === 0 && event.messages) {
			result.messages = event.messages;
		}
	});

	try {
		await session.prompt(workerData.task);
		result.exitCode = result.stopReason === "aborted" ? 1 : 0;
	} catch (error) {
		result.exitCode = 1;
		result.stopReason = result.stopReason || "error";
		result.errorMessage = result.errorMessage || (error instanceof Error ? error.message : String(error));
	} finally {
		unsubscribe?.();
		try { session.dispose(); } catch {}
	}
	post("done", result);
}

main().catch((err) => {
	result.exitCode = 1;
	result.stopReason = result.stopReason || "error";
	result.errorMessage = result.errorMessage || (err instanceof Error ? err.message : String(err));
	post("done", result);
});
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runSubAgent(options: {
	cwd: string;
	systemPrompt: string;
	task: string;
	tools: string[];
	model: Model<any>;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	agentName?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	onUpdate?: (text: string) => void;
	onMessage?: (partialResult: SubAgentResult) => void;
}): Promise<SubAgentResult> {
	const {
		cwd,
		systemPrompt,
		task,
		tools,
		model,
		authStorage,
		modelRegistry,
		signal,
		agentName = "subagent",
		thinkingLevel = "off",
		onMessage,
	} = options;

	if (signal?.aborted) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			stopReason: "aborted",
			errorMessage: "Sub-agent aborted before start",
		};
	}

	const agentDir = getAgentDir();
	const authPath = getAuthStoragePath(authStorage);
	const modelsPath = getModelsPath(modelRegistry);

	const contextFiles = await loadProjectContextFilesCompat({ cwd, agentDir });
	const contextPrefix = contextFiles.length > 0
		? contextFiles.map((f) => f.content).join("\n\n---\n\n") + "\n\n---\n\n"
		: "";
	const fullSystemPrompt = contextPrefix + systemPrompt + PARALLEL_TOOL_CALL_GUIDANCE;

	const input: WorkerInput = {
		cwd,
		agentDir,
		authPath,
		modelsPath,
		systemPrompt,
		fullSystemPrompt,
		task,
		tools,
		model,
		agentName,
		thinkingLevel,
	};

	return new Promise<SubAgentResult>((resolve, reject) => {
		let settled = false;
		const worker = new Worker(WORKER_SCRIPT, { eval: true, workerData: input as any });

		function finish(result: SubAgentResult) {
			if (settled) return;
			settled = true;
			worker.terminate().catch(() => {});
			resolve(result);
		}

		worker.on("message", (message: { type: "message" | "done"; payload: SubAgentResult }) => {
			if (message.type === "message") {
				onMessage?.(message.payload);
			} else if (message.type === "done") {
				finish(message.payload);
			}
		});

		worker.on("error", (err) => {
			finish({
				agent: agentName,
				task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				stopReason: "error",
				errorMessage: err instanceof Error ? err.message : String(err),
			});
		});

		worker.on("exit", (code) => {
			if (settled) return;
			finish({
				agent: agentName,
				task,
				exitCode: 1,
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				stopReason: "error",
				errorMessage: `Sub-agent worker exited unexpectedly (code ${code})`,
			});
		});

		if (signal) {
			const onAbort = () => {
				if (settled) return;
				worker.terminate().catch(() => {});
				finish({
					agent: agentName,
					task,
					exitCode: 1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					stopReason: "aborted",
					errorMessage: "Sub-agent aborted",
				});
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthStoragePath(authStorage: AuthStorage): string {
	try {
		const storage = authStorage as unknown as { authPath?: string; path?: string };
		if (storage.authPath) return storage.authPath;
		if (storage.path) return storage.path;
	} catch {}
	return path.join(getAgentDir(), "auth.json");
}

function getModelsPath(modelRegistry: ModelRegistry): string | undefined {
	try {
		const registry = modelRegistry as unknown as { modelsPath?: string; path?: string };
		if (registry.modelsPath) return registry.modelsPath;
		if (registry.path) return registry.path;
	} catch {}
	return undefined;
}

async function loadProjectContextFilesCompat({ cwd, agentDir }: { cwd: string; agentDir: string }): Promise<{ content: string }[]> {
	try {
		// @earendil-works/pi-coding-agent is ESM-only, so use dynamic import().
		const { loadProjectContextFiles } = await import("@earendil-works/pi-coding-agent");
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
			.filter((p): p is { type: "text"; text: string } => p.type === "text" && p.text.trim().length > 0)
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
