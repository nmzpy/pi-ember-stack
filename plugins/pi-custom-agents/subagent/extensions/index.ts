/**
 * pi-subagent — Minimal-overhead sub-agent extension for pi.
 *
 * Provides a `subagent` tool that delegates tasks to specialized agents
 * running in isolated in-process SDK sessions. Supports three modes:
 *
 *   - Single:  { agent: "Scout", task: "find auth code" }
 *   - Parallel: { tasks: [{ agent: "Scout", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "Scout", task: "..." }, ...] }
 *
 * Compared to process-spawning, this saves ~4-11K tokens per sub-agent
 * by using the pi SDK directly with a minimal system prompt, no AGENTS.md,
 * no extensions, no skills, no thinking, and no compaction.
 */

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type AbortSignalStatic = typeof AbortSignal & {
	any?(signals: AbortSignal[]): AbortSignal;
};

const AbortSignalCtor = AbortSignal as AbortSignalStatic;

interface CustomFactoryTui {
	requestRender(): void;
}

interface CustomFactoryTheme {
	fg(tag: string, text: string): string;
	bold(text: string): string;
}

interface CustomFactoryResult {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	dispose?(): void;
}

interface CustomFactoryOptions {
	overlay?: boolean;
	overlayOptions?: Record<string, unknown>;
}

interface CustomUi {
	custom<T>(
		factory: (
			tui: CustomFactoryTui,
			theme: CustomFactoryTheme,
			kb: unknown,
			done: (value: T) => void,
		) => CustomFactoryResult,
		opts?: CustomFactoryOptions,
	): Promise<T>;
}

import { subscribeGradientTick, unsubscribeGradientTick } from "../../../pi-ember-ui/index.ts";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentList,
	invalidateAgentCache,
	resolveAgent,
} from "./agents.ts";
import {
	anySubagentRunning,
	buildSubagentLayoutComponent,
	isSubagentDelegating,
	renderSubagentExpanded,
} from "./render.ts";
import {
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSubAgent,
	type SubAgentResult,
} from "./runner.ts";
import { runNamedAgent, SUBAGENT_REQUEST_EVENT, type SubagentRunRequest } from "./service.ts";
import { ThreadViewer, type ThreadViewerCallbacks } from "./thread-viewer.ts";
import { type SubagentThread, threadStore } from "./threads.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024; // 50 KB per parallel task

import { resolveModel } from "./model.ts";

// ---------------------------------------------------------------------------
// Stable per-tool-call gradient subscription
// ---------------------------------------------------------------------------

/**
 * A stable tick subscription record keyed by toolCallId. The callback
 * identity never changes for the lifetime of a tool call, so the shared
 * gradient clock's subscriber Set is never churned during renderCall.
 * Only the invalidate *target* is rebound when Pi provides a fresh
 * invalidate closure (rebuilds). This prevents the JavaScript Set
 * live-iteration hazard where a rebind during dispatch causes
 * recursive/infinite invalidation.
 *
 * One record per running subagent tool call. Subscribe once when
 * running starts, unsubscribe when terminal, and clear all on
 * session_start/session_shutdown.
 */
interface SubagentTickRecord {
	/** Stable callback identity — never replaced. */
	readonly callback: () => void;
	/** Mutable invalidate target — rebound on each renderCall. */
	invalidateTarget: (() => void) | undefined;
}

const subagentTickRecords = new Map<string, SubagentTickRecord>();

function getOrCreateTickRecord(toolCallId: string): SubagentTickRecord {
	let record = subagentTickRecords.get(toolCallId);
	if (!record) {
		const rec: SubagentTickRecord = {
			callback: (): void => {
				rec.invalidateTarget?.();
			},
			invalidateTarget: undefined,
		};
		record = rec;
		subagentTickRecords.set(toolCallId, record);
	}
	return record;
}

function rebindTickTarget(toolCallId: string, invalidate: (() => void) | undefined): void {
	const record = getOrCreateTickRecord(toolCallId);
	record.invalidateTarget = invalidate;
}

function subscribeTick(toolCallId: string, invalidate: (() => void) | undefined): void {
	const record = getOrCreateTickRecord(toolCallId);
	record.invalidateTarget = invalidate;
	subscribeGradientTick(record.callback);
}

function unsubscribeTick(toolCallId: string): void {
	const record = subagentTickRecords.get(toolCallId);
	if (!record) return;
	unsubscribeGradientTick(record.callback);
	subagentTickRecords.delete(toolCallId);
}

function clearAllTickRecords(): void {
	for (const record of subagentTickRecords.values()) {
		unsubscribeGradientTick(record.callback);
	}
	subagentTickRecords.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in milliseconds for this task. Default: ${DEFAULT_SUBAGENT_TIMEOUT_MS} (120s).`,
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in milliseconds for this step. Default: ${DEFAULT_SUBAGENT_TIMEOUT_MS} (120s).`,
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution with {previous}",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	timeout: Type.Optional(
		Type.Number({
			description: `Global timeout in milliseconds for all sub-agents (overridden by per-task/step timeouts). Default: ${DEFAULT_SUBAGENT_TIMEOUT_MS} (120s).`,
		}),
	),
	instructions: Type.Optional(
		Type.String({
			description: "Bounded repository/task instructions passed to each child (max 16 KB)",
		}),
	),
	abortOnFailure: Type.Optional(
		Type.Boolean({
			description: "In parallel mode, cancel remaining tasks when one fails. Default: false.",
			default: false,
		}),
	),
});

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubAgentResult[];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;

	// Session-global per-type letter counters for parallel/chain agents.
	// Each agent type (e.g. "Coder", "Scout") gets its own A, B, C… sequence
	// that persists across tool calls within a session and resets on session
	// replacement. Single-mode calls do NOT get a letter.
	const agentLetterCounters = new Map<string, number>();

	function assign_agent_letter(agentName: string): string {
		const index = agentLetterCounters.get(agentName) ?? 0;
		agentLetterCounters.set(agentName, index + 1);
		// A-Z for 0-25, then AA, AB, AC… for 26+
		let letter: string;
		if (index < 26) {
			letter = String.fromCharCode(65 + index);
		} else {
			const first = Math.floor(index / 26) - 1;
			const second = index % 26;
			letter = String.fromCharCode(65 + first) + String.fromCharCode(65 + second);
		}
		return `${agentName} ${letter}`;
	}

	// Invalidate agent cache + clear thread store on session replacement.
	pi.on("session_start", (event, ctx) => {
		currentCtx = ctx;
		if (event.reason === "reload") invalidateAgentCache();
		threadStore.clear();
		clearAllTickRecords();
		agentLetterCounters.clear();
	});

	pi.on("session_shutdown", () => {
		currentCtx = undefined;
		threadStore.clear();
		clearAllTickRecords();
		agentLetterCounters.clear();
	});

	// Proactively steer agents toward sub-agent delegation when users mention it
	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt.toLowerCase();
		if (
			/\b(delegate to|use a subagent|run in parallel|spawn an agent|scout|coder|explore|review this|chain)\b/.test(
				prompt,
			)
		) {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\nThe subagent tool is available for delegating tasks to specialized agents with isolated context. Use /subagent to list available agents. Bundled: Scout (fast codebase exploration), Coder (implementation). Modes: single, parallel (max 8), chain.",
			};
		}
	});

	// Resolve bundled agents directory relative to this extension file
	const bundledAgentsDir = path.resolve(__dirname, "../agents");

	// Public one-request/one-response service used by pi-review.
	pi.events.on(SUBAGENT_REQUEST_EVENT, (raw) => {
		const request = raw as SubagentRunRequest;
		const ctx = currentCtx;
		if (!request?.id || typeof request.respond !== "function") return;
		if (!ctx) {
			request.respond({ id: request.id, ok: false, error: "Subagent session is not active." });
			return;
		}
		if (request.accept && !request.accept()) return;
		const agent = resolveAgent(
			discoverAgents(ctx.cwd, "user", bundledAgentsDir).agents,
			request.agent,
		);
		if (!agent) {
			request.respond({ id: request.id, ok: false, error: `Unknown agent: ${request.agent}` });
			return;
		}
		const thread = threadStore.createThread({
			agentName: agent.name,
			task: request.task,
			mode: "single",
		});
		void runNamedAgent({
			agent: request.readOnly ? { ...agent, tools: ["read", "grep", "find", "ls"] } : agent,
			task: request.task,
			cwd: request.cwd ?? ctx.cwd,
			ctx,
			timeout: request.timeout,
			instructions: request.instructions,
			signal: request.signal,
			onMessage: (result) => threadStore.updateThread(thread.id, { result }),
		}).then(
			(result) => {
				threadStore.updateThread(thread.id, {
					status: isFailedResult(result)
						? result.stopReason === "aborted"
							? "aborted"
							: "failed"
						: "completed",
					result,
				});
				if (isFailedResult(result))
					request.respond({ id: request.id, ok: false, error: getResultOutput(result) });
				else request.respond({ id: request.id, ok: true, result });
			},
			(error) => {
				threadStore.updateThread(thread.id, { status: "failed" });
				request.respond({
					id: request.id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	});

	// /subagent command — list available agents
	pi.registerCommand("subagent", {
		description: "List available sub-agents, reload agent definitions, or show agent details",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();
			const discovery = discoverAgents(ctx.cwd, "both", bundledAgentsDir);

			if (cmd === "reload" || cmd === "refresh") {
				invalidateAgentCache();
				const fresh = discoverAgents(ctx.cwd, "both", bundledAgentsDir);
				const list = formatAgentList(fresh.agents, 20);
				const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
				const dirs = fresh.projectAgentsDir
					? `project: ${fresh.projectAgentsDir}`
					: "no project agents dir";
				pi.sendMessage({
					customType: "pi-subagent",
					content: `Agent definitions reloaded.\n\nAvailable agents (${fresh.agents.length}):\n  ${list.text}${extra}\n\nDirectories searched:\n  user: ${path.join(getAgentDir(), "agents")}\n  ${dirs}\n  bundled: ${bundledAgentsDir}`,
					display: true,
				});
				ctx.ui.notify("Agent definitions reloaded", "info");
				return;
			}

			// Handle listing keywords before agent lookup
			if (cmd === "all" || cmd === "list" || cmd === "agents") {
				const list = formatAgentList(discovery.agents, 20);
				const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
				const dirs = discovery.projectAgentsDir ? `\n  project: ${discovery.projectAgentsDir}` : "";
				pi.sendMessage({
					customType: "pi-subagent",
					content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
					display: true,
				});
				return;
			}

			if (cmd) {
				// Show details for a specific agent
				const agent = resolveAgent(discovery.agents, args.trim());
				if (!agent) {
					ctx.ui.notify(`Unknown agent: "${args.trim()}". Use /subagent to list all.`, "error");
					return;
				}
				pi.sendMessage({
					customType: "pi-subagent",
					content: [
						`Agent: ${agent.name} (${agent.source})`,
						`Description: ${agent.description}`,
						`Model: ${agent.model || "inherits from parent"}`,
						`Thinking: ${agent.thinking || "off"}`,
						`Tools: ${agent.tools?.join(", ") || "all default"}`,
						`Source file: ${agent.filePath}`,
						"",
						"--- System Prompt ---",
						agent.systemPrompt,
					].join("\n"),
					display: true,
				});
				return;
			}

			// List all agents
			const list = formatAgentList(discovery.agents, 20);
			const extra = list.remaining > 0 ? `\n  ... +${list.remaining} more` : "";
			const dirs = discovery.projectAgentsDir ? `\n  project: ${discovery.projectAgentsDir}` : "";
			pi.sendMessage({
				customType: "pi-subagent",
				content: `Available agents (${discovery.agents.length}):\n  ${list.text}${extra}\n\nScopes searched:\n  user: ${path.join(getAgentDir(), "agents")}${dirs}\n  bundled: ${bundledAgentsDir}\n\nUse /subagent <name> for agent details, /subagent reload to refresh.`,
				display: true,
			});
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context (SDK-based, minimal overhead).",
			"Modes: single (agent + task), parallel (tasks array, max 8, 4 concurrent), chain (sequential with {previous}).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" or "project".`,
		].join(" "),
		parameters: SubagentParams,
		renderShell: "self",
		promptSnippet: "Delegate tasks to specialized sub-agents (Scout, Coder)",
		promptGuidelines: [
			"Use subagent to delegate work that would flood the main context with search results or file contents.",
			"Modes: single {agent, task}, parallel {tasks: [...]} (max 8, 4 concurrent), chain {chain: [...]} (sequential with {previous}).",
			"Bundled agents: Scout (fast recon), Coder (implementation).",
			"Agent names are case-insensitive and surrounding whitespace is ignored.",
			"Use /subagent to list all available agents or /subagent <name> for agent details.",
		],
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope, bundledAgentsDir);
			const agents = discovery.agents;
			const resolve_agent_name = (requestedName: string): string =>
				resolveAgent(agents, requestedName)?.name ?? requestedName.trim();
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SubAgentResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// Validate: exactly one mode
			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: [
								"Invalid parameters. Provide exactly one mode:",
								"  single: { agent, task }",
								"  parallel: { tasks: [...] }",
								"  chain: { chain: [...] }",
								`Available agents: ${available}`,
							].join("\n"),
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Handle project-local agent confirmation
			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const s of params.chain) requestedAgentNames.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => resolveAgent(agents, name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0 && confirmProjectAgents) {
					if (ctx.hasUI) {
						const names = projectAgentsRequested.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok) {
							return {
								content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
								details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							};
						}
					} else {
						// ponytail: fail closed in headless sessions — project agent
						// prompts and tools run without user oversight.
						return {
							content: [
								{
									type: "text",
									text:
										"Cannot run project-local agents without UI confirmation. " +
										"Set confirmProjectAgents: false to allow in headless sessions, " +
										"or use agentScope: 'user' to skip project agents.",
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
				}
			}

			// The runner bridges this extension-facing registry to Pi's canonical
			// ModelRuntime once, so every execution path shares the parent's exact
			// providers, credentials, headers, and dynamic catalogs.
			const modelRegistry = ctx.modelRegistry;

			// Helper: run a single agent via SDK
			async function runOne(
				agentName: string,
				task: string,
				cwd: string | undefined,
				parentSignal?: AbortSignal,
				timeoutMs?: number,
				onProgress?: (partial: SubAgentResult) => void,
				displayName?: string,
				onToolCall?: (partial: SubAgentResult) => void,
			): Promise<SubAgentResult> {
				const agent = resolveAgent(agents, agentName);

				// Use the provided display name (lettered for parallel/chain) or
				// fall back to the bare agent name (single mode).
				const label = displayName ?? agent?.name ?? agentName.trim();

				if (!agent) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						agent: label,
						task,
						exitCode: 1,
						messages: [],
						stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
						errorMessage: `Unknown agent: "${agentName}"`,
					};
				}

				const resolved = resolveModel(agent.model, ctx.model, ctx.modelRegistry);
				if (!resolved.model) {
					const tried = resolved.attempted.join(", ") || "none";
					const parentInfo = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
					return {
						agent: label,
						task,
						exitCode: 1,
						messages: [],
						stderr: `Model not found for agent "${agentName}". Tried: ${tried}. Parent model: ${parentInfo}. Check agent definition and pi model configuration.`,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
						errorMessage: `No model resolved (tried: ${tried})`,
					};
				}

				// Resolve tools; strip "subagent" to prevent accidental recursion.
				// Sub-agents cannot spawn further sub-agents (one level of delegation only).
				const defaultTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
				let tools = agent.tools ?? defaultTools;
				tools = tools.filter((t) => t !== "subagent");

				return runSubAgent({
					cwd: cwd ?? ctx.cwd,
					systemPrompt: params.instructions
						? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, 16 * 1024)}`
						: agent.systemPrompt,
					task,
					tools,
					model: resolved.model,
					modelRegistry,
					parentSignal,
					timeoutMs,
					agentName: label,
					thinkingLevel: agent.thinking,
					onMessage: onProgress,
					onToolCall,
				});
			}

			// --- Chain mode ---
			if (params.chain && params.chain.length > 0) {
				const results: SubAgentResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const stepAgentName = resolve_agent_name(step.agent);
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const thread = threadStore.createThread({
						agentName: stepAgentName,
						task: taskWithContext,
						mode: "chain-step",
						toolCallId: _toolCallId,
					});
					// Assign a session-global letter for chain mode so the user and
					// orchestrating agent can track individual agents.
					const stepDisplayName = assign_agent_letter(stepAgentName);
					// Publish the active step before awaiting it so chain mode shows
					// the running agent's gradient instead of an empty group header.
					results.push({
						agent: stepDisplayName,
						task: taskWithContext,
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
					});
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: "Running..." }],
							details: makeDetails("chain")(results),
						});
					}
					const result = await runOne(
						stepAgentName,
						taskWithContext,
						step.cwd,
						signal,
						step.timeout ?? params.timeout,
						(partial) => threadStore.updateThread(thread.id, { result: partial }),
						stepDisplayName,
						(partial) => {
							threadStore.updateThread(thread.id, { result: partial });
							results[i] = partial;
							if (onUpdate) {
								onUpdate({
									content: [{ type: "text", text: "Running..." }],
									details: makeDetails("chain")(results),
								});
							}
						},
					);
					threadStore.updateThread(thread.id, {
						status: isFailedResult(result)
							? result.stopReason === "aborted"
								? "aborted"
								: "failed"
							: "completed",
						result,
					});
					results[i] = result;

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: errorMsg }],
								details: makeDetails("chain")(results),
							});
						}
						// Include successful previous step outputs in the error content
						const prevCount = i;
						let contentText = `Chain stopped at step ${i + 1} (${stepAgentName}): ${errorMsg}`;
						if (prevCount > 0) {
							const prevSummaries = results
								.slice(0, prevCount)
								.map((r, j) => {
									const out = getResultOutput(r).slice(0, 500);
									return `Step ${j + 1} (${r.agent}): ${out}`;
								})
								.join("\n");
							contentText = `Chain stopped at step ${i + 1}/${params.chain.length}. ${prevCount} previous step(s) succeeded:\n\n${prevSummaries}\n\nError at step ${i + 1} (${stepAgentName}): ${errorMsg}`;
						}
						return {
							content: [{ type: "text", text: contentText }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}

					previousOutput = getFinalOutput(result.messages);

					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
							details: makeDetails("chain")(results),
						});
					}
				}

				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: getFinalOutput(last.messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// --- Parallel mode ---
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				const abortOnFailure = params.abortOnFailure ?? false;
				const parallelController = new AbortController();
				let abortCause: "parent" | "sibling" | undefined;

				// Combine parent signal with parallel abort controller
				let parallelSignal: AbortSignal = parallelController.signal;
				if (signal) {
					// Always link parent abort into parallelController so queued tasks see aborted state
					if (signal.aborted) {
						abortCause = "parent";
						parallelController.abort();
					} else {
						signal.addEventListener(
							"abort",
							() => {
								if (!abortCause) abortCause = "parent";
								parallelController.abort();
							},
							{ once: true },
						);
					}
					if (typeof AbortSignalCtor.any === "function") {
						parallelSignal = AbortSignalCtor.any([signal, parallelController.signal]);
					} else {
						parallelSignal = parallelController.signal;
					}
				}

				// Pre-create threads for all parallel tasks
				const parallelDisplayNames = params.tasks.map((t) =>
					assign_agent_letter(resolve_agent_name(t.agent)),
				);
				const parallelThreads = params.tasks.map((t, i) =>
					threadStore.createThread({
						agentName: parallelDisplayNames[i],
						task: t.task,
						mode: "parallel-task",
						toolCallId: _toolCallId,
					}),
				);

				const allResults: SubAgentResult[] = new Array(params.tasks.length);
				// Initialize placeholder results for streaming
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: parallelDisplayNames[i],
						task: params.tasks[i].task,
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
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				// Publish running placeholders immediately so the compact renderer
				// shows lettered agent rows before the first subagent tool call.
				emitParallelUpdate();

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, index) => {
						// Skip if already aborted by sibling failure or parent abort
						if (parallelSignal.aborted || parallelController.signal.aborted) {
							const skippedResult: SubAgentResult = {
								agent: parallelDisplayNames[index],
								task: t.task,
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
								stopReason: "aborted",
								errorMessage:
									abortCause === "sibling"
										? "Cancelled: sibling task failed"
										: "Cancelled: parent operation aborted",
							};
							allResults[index] = skippedResult;
							threadStore.updateThread(parallelThreads[index].id, {
								status: "aborted",
								result: skippedResult,
							});
							emitParallelUpdate();
							return skippedResult;
						}
						const result = await runOne(
							resolve_agent_name(t.agent),
							t.task,
							t.cwd,
							parallelSignal,
							t.timeout ?? params.timeout,
							(partial) => threadStore.updateThread(parallelThreads[index].id, { result: partial }),
							parallelDisplayNames[index],
							(partial) => {
								threadStore.updateThread(parallelThreads[index].id, { result: partial });
								allResults[index] = partial;
								emitParallelUpdate();
							},
						);
						allResults[index] = result;
						threadStore.updateThread(parallelThreads[index].id, {
							status: isFailedResult(result)
								? result.stopReason === "aborted"
									? "aborted"
									: "failed"
								: "completed",
							result,
						});
						// Early-abort: if this task failed and abortOnFailure is set
						if (abortOnFailure && isFailedResult(result)) {
							abortCause = "sibling";
							parallelController.abort();
						}
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const cancelCount = results.filter(
					(r) => r.stopReason === "aborted" && r.errorMessage?.includes("Cancelled"),
				).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});

				let headerText = `Parallel: ${successCount}/${results.length} succeeded`;
				if (cancelCount > 0) headerText += ` (${cancelCount} cancelled)`;
				return {
					content: [
						{
							type: "text",
							text: `${headerText}\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// --- Single mode ---
			if (params.agent && params.task) {
				const agentName = resolve_agent_name(params.agent);
				const thread = threadStore.createThread({
					agentName,
					task: params.task,
					mode: "single",
					toolCallId: _toolCallId,
				});
				const emptyUsage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				};
				const runningPlaceholder: SubAgentResult = {
					agent: agentName,
					task: params.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyUsage,
				};
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: "(running...)" }],
						details: makeDetails("single")([runningPlaceholder]),
					});
				}
				const result = await runOne(
					agentName,
					params.task,
					params.cwd,
					signal,
					params.timeout,
					(partial) => threadStore.updateThread(thread.id, { result: partial }),
					undefined,
					(partial) => {
						threadStore.updateThread(thread.id, { result: partial });
						if (onUpdate) {
							onUpdate({
								content: [
									{
										type: "text",
										text: getFinalOutput(partial.messages) || "(running...)",
									},
								],
								details: makeDetails("single")([partial]),
							});
						}
					},
				);
				threadStore.updateThread(thread.id, {
					status: isFailedResult(result)
						? result.stopReason === "aborted"
							? "aborted"
							: "failed"
						: "completed",
					result,
				});
				const isError = isFailedResult(result);

				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
						details: makeDetails("single")([result]),
					});
				}

				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			// Should not reach here due to validation above
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		// ------------------------------------------------------------------
		// TUI rendering — compact grouped layout (Exploring-style)
		// ------------------------------------------------------------------

		renderCall(args, theme, context) {
			// The cap is a full-width sibling above the padded subagent box.
			// Its render(width) reads the live viewport width and visibility state.
			let shell = context.state.shell;
			if (!(shell instanceof Container)) {
				shell = new Container();
				context.state.shell = shell;
			}
			shell.clear();

			// The layout Container holds per-row components: transparent Text
			// for running rows/header and per-terminal-row subagentBg Boxes.
			// Rebuild on every renderCall so statuses are always current.
			const results = context.state.results ?? [];
			const layout = buildSubagentLayoutComponent(args, results, theme);
			context.state.layout = layout;
			shell.addChild(layout);

			// Stable subscription: rebind the invalidate target (Pi rebuilds
			// provide a fresh closure) without churning the subscriber Set.
			// Subscribe only while any agent is running; unsubscribe on
			// terminal so the clock can stop.
			const running = isSubagentDelegating(results) || anySubagentRunning(args, results);
			if (running) {
				subscribeTick(context.toolCallId, context.invalidate);
			} else {
				rebindTickTarget(context.toolCallId, context.invalidate);
			}
			return shell;
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			const results = details?.results ?? [];
			context.state.results = results;
			const isRunning = details
				? isSubagentDelegating(results) || anySubagentRunning(context.args, results)
				: false;
			// Unsubscribe the stable tick callback when the tool call is
			// terminal (no agents running). This is idempotent — if the
			// record was already removed (e.g. a second renderResult), the
			// unsubscribe is a no-op.
			if (!isRunning) {
				unsubscribeTick(context.toolCallId);
			} else {
				rebindTickTarget(context.toolCallId, context.invalidate);
			}
			if (!details) {
				const outputBlock = result.content.find(
					(item: { type: string; text?: string }) => item.type === "text",
				);
				const output = outputBlock?.type === "text" ? outputBlock.text : "(no output)";
				return new Text(output, 0, 0);
			}

			// Rebuild the layout Container with the latest statuses.
			// renderResult runs after renderCall in updateDisplay, so this
			// wins the paint. The shell from renderCall is reused — we
			// replace the layout child in the shell.
			const shell = context.state.shell;
			if (shell instanceof Container) {
				shell.clear();
				const layout = buildSubagentLayoutComponent(context.args, results, theme);
				context.state.layout = layout;
				shell.addChild(layout);
			}

			// Expanded view (Ctrl+O): detailed per-agent output with a background
			// on each completed agent rather than the entire subagent block.
			if (expanded && !isRunning && details && details.results.length > 0) {
				const expandedContent = renderSubagentExpanded(details, theme);
				if (expandedContent) return expandedContent;
			}

			// Collapsed: the shell from renderCall is the visible component.
			return new Text("", 0, 0);
		},
	});
	// /agent command — switch between subagent threads.
	// When a thread is selected, the viewer replaces the main TUI (not overlay).
	pi.registerCommand("agent", {
		description: "Switch to a subagent thread to view its work in isolation",
		handler: async (_args, ctx) => {
			// Show picker overlay
			const selectedId = await showAgentPicker(ctx, buildPickerItems(threadStore.getAllThreads()));
			if (!selectedId) return; // Cancelled — stay in current view

			// Main selected — close viewer if active, return to conversation
			if (selectedId === "__main__") {
				if (activeViewerDone) {
					activeViewerDone();
					activeViewerDone = null;
				}
				return;
			}

			// Close existing viewer (if any) before opening new one
			if (activeViewerDone) {
				activeViewerDone();
				activeViewerDone = null;
			}

			// Show thread viewer (re-resolve against current store)
			const freshThreads = threadStore.getAllThreads();
			const idx = freshThreads.findIndex((t) => t.id === selectedId);
			if (idx === -1) {
				ctx.ui.notify("Selected subagent thread no longer exists.", "warning");
				return;
			}

			await showThreadViewer(ctx, freshThreads, idx);
		},
	});

	// ---------------------------------------------------------------------------
	// Module-level viewer state (so /agent can close an active viewer)
	// ---------------------------------------------------------------------------
	let activeViewerDone: (() => void) | null = null;

	// ---------------------------------------------------------------------------
	// Picker helpers (shared between /agent handler and Ctrl+P in viewer)
	// ---------------------------------------------------------------------------

	interface PickerItem {
		value: string;
		label: string;
		description: string;
	}

	function buildPickerItems(threads: SubagentThread[]): PickerItem[] {
		const items: PickerItem[] = [
			{ value: "__main__", label: "Main [default]", description: "(current)" },
		];
		for (const t of threads) {
			let statusIcon: string;
			switch (t.status) {
				case "running":
					statusIcon = "⏳";
					break;
				case "completed":
					statusIcon = "✓";
					break;
				case "failed":
					statusIcon = "✗";
					break;
				case "aborted":
					statusIcon = "✗";
					break;
			}
			let modeTag = "";
			if (t.mode === "parallel-task") modeTag = " [parallel]";
			else if (t.mode === "chain-step") modeTag = " [chain]";
			const label = `${statusIcon} ${t.agentName}${modeTag}`;
			const desc = t.task.length > 60 ? `${t.task.slice(0, 57)}...` : t.task;
			items.push({ value: t.id, label, description: desc });
		}
		return items;
	}

	async function showAgentPicker(
		ctx: { ui: CustomUi },
		items: PickerItem[],
	): Promise<string | null> {
		return ctx.ui.custom<string | null>(
			(
				tui: CustomFactoryTui,
				theme: CustomFactoryTheme,
				_kb: unknown,
				done: (value: string | null) => void,
			) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "⌥ + ← previous, ⌥ + → next."), 1, 0));

				const selectList = new SelectList(
					items.map((it) => ({ value: it.value, label: it.label, description: it.description })),
					Math.min(items.length + 2, 15),
					{
						selectedPrefix: (t: string) => theme.fg("accent", t),
						selectedText: (t: string) => theme.fg("accent", t),
						description: (t: string) => theme.fg("muted", t),
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
				);
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(
					new Text(`${theme.fg("dim", "↑↓ navigate · enter select · esc back")}`, 1, 0),
				);

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true },
		);
	}

	// Helper: show thread viewer as overlay so editor remains visible.
	// Uses dynamic thread list + store subscriptions for live progress.
	// Ctrl+P opens picker overlay to jump to any thread.
	async function showThreadViewer(
		ctx: { ui: CustomUi },
		_threads: SubagentThread[],
		startIndex: number,
	): Promise<void> {
		let currentIndex = startIndex;

		// Resolve thread list dynamically
		const getThreads = () => threadStore.getAllThreads();

		// Overlay mode: viewer appears above editor, Esc dismisses
		await ctx.ui.custom<void>(
			(tui: CustomFactoryTui, theme: CustomFactoryTheme, _kb: unknown, done: () => void) => {
				let unsubscribe: (() => void) | undefined;
				let closed = false;

				const cleanup = () => {
					if (unsubscribe) {
						unsubscribe();
						unsubscribe = undefined;
					}
				};

				const close = () => {
					if (closed) return;
					closed = true;
					cleanup();
					activeViewerDone = null;
					done();
				};

				// Track this viewer so /agent can close it before opening a new one
				activeViewerDone = close;

				function makeCallbacks(): ThreadViewerCallbacks {
					const list = getThreads();
					return {
						onClose: close,
						onPrev: () => {
							const current = getThreads();
							if (currentIndex > 0) {
								currentIndex--;
								viewer.setThread(current[currentIndex], makeCallbacks());
								tui.requestRender();
							}
						},
						onNext: () => {
							const current = getThreads();
							if (currentIndex < current.length - 1) {
								currentIndex++;
								viewer.setThread(current[currentIndex], makeCallbacks());
								tui.requestRender();
							}
						},
						hasPrev: currentIndex > 0,
						hasNext: currentIndex < list.length - 1,
					};
				}

				const list = getThreads();
				if (list.length === 0 || currentIndex < 0 || currentIndex >= list.length) {
					close();
					return {
						render: (_w: number) => [],
						invalidate: () => {},
						handleInput: (_data: string) => {},
						dispose: () => {
							cleanup();
							if (activeViewerDone === close) activeViewerDone = null;
							closed = true;
						},
					};
				}

				const viewer = new ThreadViewer(list[currentIndex], makeCallbacks(), theme);
				let pickerOpen = false;

				// Subscribe to thread store for live updates (after viewer is created)
				unsubscribe = threadStore.subscribe(() => {
					const current = getThreads();
					if (current.length === 0) {
						close();
						return;
					}
					currentIndex = Math.min(currentIndex, current.length - 1);
					viewer.setThread(current[currentIndex], makeCallbacks());
					tui.requestRender();
				});

				return {
					render: (w: number) => viewer.render(w),
					invalidate: () => viewer.invalidate(),
					handleInput: (data: string) => {
						// Ctrl+P opens the picker to jump between threads
						if (data === "\x10") {
							if (!pickerOpen) {
								pickerOpen = true;
								openThreadPicker().finally(() => {
									pickerOpen = false;
								});
							}
							return;
						}
						viewer.handleInput(data);
						tui.requestRender();
					},
					dispose: () => {
						cleanup();
						if (activeViewerDone === close) activeViewerDone = null;
						closed = true;
					},
				};

				// Opens picker overlay on top of viewer to jump to any thread
				async function openThreadPicker() {
					const items = buildPickerItems(getThreads());
					const selectedId = await showAgentPicker(ctx, items);
					if (!selectedId) return;
					if (selectedId === "__main__") {
						close();
						return;
					}
					const idx = getThreads().findIndex((t) => t.id === selectedId);
					if (idx >= 0) {
						currentIndex = idx;
						viewer.setThread(getThreads()[currentIndex], makeCallbacks());
						tui.requestRender();
					}
				}
			},
			{ overlay: true, overlayOptions: { maxHeight: "70%" } },
		); // Overlay: editor stays visible below
	}
}
