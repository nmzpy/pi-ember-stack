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
 * by using the pi SDK directly with a minimal system prompt and no AGENTS.md.
 * Child sessions enable Pi compaction (Ember summarizer via compaction-wiring) and optional
 * DCP outbound strategies when globally enabled — not the full parent extension stack.
 */

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS,
	is_subagent_resume_tool,
	model_provider_of,
	SUBAGENT_RESUME_TOOL_NAME,
	with_provider_patch_tool,
	without_subagent_delegation_tools,
} from "../../edit-tools.ts";

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

import { getSharedRenderer } from "../../../pi-compact-tools/index.ts";
import {
	requestTuiRender,
	subscribeGradientTick,
	syncThinkingGradientClock,
	unsubscribeGradientTick,
} from "../../../pi-ember-ui/index.ts";
import {
	isThinkingBlocksHidden,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	setToolGroupActive,
} from "../../../pi-ember-ui/mode-colors.ts";
import { buildSelectListTheme } from "../../../pi-ember-ui/select-list-theme.ts";
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
	renderSubagentExpanded,
	shouldShowSubagentDelegating,
} from "./render.ts";
import { prune_foreign_checkpoints, resolve_resume_target } from "./resume-store.ts";
import {
	agent_tool_result_content,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	format_agent_tool_result_batch,
	format_agent_tool_result_text,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSubAgent,
	type SubAgentResult,
} from "./runner.ts";
import { runNamedAgent, SUBAGENT_REQUEST_EVENT, type SubagentRunRequest } from "./service.ts";
import {
	apply_subagent_group_stream_boundary,
	getSubagentGroupRenderer,
	isSingleModeSubagentArgs,
	type SubagentArgs,
	type SubagentCallRecord,
	seed_subagent_renderer_from_branch,
} from "./subagent-group.ts";
import { install_subagent_render_spacing_patch } from "./subagent-render-spacing.ts";
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
	readonly toolCallId: string;
	args: unknown;
	results: SubAgentResult[];
	theme: CustomFactoryTheme | undefined;
	invalidate?: () => void;
}

const subagentTickRecords = new Map<string, SubagentTickRecord>();

function getOrCreateTickRecord(toolCallId: string): SubagentTickRecord {
	let record = subagentTickRecords.get(toolCallId);
	if (!record) {
		const rec: SubagentTickRecord = {
			callback: (): void => {
				rec.invalidate?.();
			},
			toolCallId,
			args: {},
			results: [],
			theme: undefined,
		};
		record = rec;
		subagentTickRecords.set(toolCallId, record);
	}
	return record;
}

function updateTickRecord(
	toolCallId: string,
	args: unknown,
	results: SubAgentResult[],
	theme: CustomFactoryTheme,
	invalidate?: () => void,
): SubagentTickRecord {
	const record = getOrCreateTickRecord(toolCallId);
	record.args = args;
	record.results = results;
	record.theme = theme;
	if (invalidate) record.invalidate = invalidate;
	return record;
}

function subscribeTick(
	toolCallId: string,
	args: unknown,
	results: SubAgentResult[],
	theme: CustomFactoryTheme,
	invalidate: () => void,
): void {
	const record = updateTickRecord(toolCallId, args, results, theme, invalidate);
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

function is_subagent_member_running(member: SubagentCallRecord): boolean {
	const terminal = isSubagentToolTerminal(member.toolCallId);
	if (terminal) return false;
	return (
		shouldShowSubagentDelegating(member.results, terminal) ||
		anySubagentRunning(member.args, member.results, terminal)
	);
}

function any_batch_member_running(batch: SubagentCallRecord[]): boolean {
	return batch.some(is_subagent_member_running);
}

function batch_owner(batch: SubagentCallRecord[]): SubagentCallRecord | undefined {
	return batch[0];
}

function note_subagent_live_partial(toolCallId: string, partial: SubAgentResult): void {
	if (partial.isThinking) {
		arm_subagent_thinking_pass(toolCallId);
	} else {
		clear_subagent_thinking_pass(toolCallId);
	}
	if (partial.latestToolCall) {
		clear_subagent_thinking_pass(toolCallId);
	}
	const group_renderer = getSubagentGroupRenderer();
	const record = group_renderer.getRecord(toolCallId);
	if (record && isSingleModeSubagentArgs(record.args)) {
		group_renderer.register(toolCallId, record.args, [partial], record.invalidate);
	}
	batch_owner(group_renderer.getBatch(toolCallId))?.invalidate?.();
}

function map_grouped_members(batch: SubagentCallRecord[]) {
	return batch.map((member) => ({
		args: member.args,
		results: member.results,
		failureMessage: member.failureMessage,
		displayName: member.displayName,
		terminal: isSubagentToolTerminal(member.toolCallId),
		toolCallId: member.toolCallId,
	}));
}

function sync_owner_gradient_tick(
	owner: SubagentCallRecord,
	batch_running: boolean,
	theme: CustomFactoryTheme,
	invalidate: () => void,
): void {
	if (batch_running) {
		subscribeTick(owner.toolCallId, owner.args, owner.results, theme, invalidate);
	} else {
		updateTickRecord(owner.toolCallId, owner.args, owner.results, theme, invalidate);
		unsubscribeTick(owner.toolCallId);
	}
}

import {
	arm_subagent_thinking_pass,
	clear_subagent_thinking_pass,
	clearSubagentTiming,
	getGroupElapsedMs,
	getSubagentElapsedMs,
	isSubagentToolTerminal,
	markSubagentRunning,
	markSubagentTerminal,
} from "./subagent-timing.ts";

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

const SubagentResumeParams = Type.Object({
	agent: Type.String({
		description:
			'Lettered display name of the prior subagent to continue (e.g. "Coder A", "Scout B")',
	}),
	task: Type.String({ description: "Follow-up instruction for the continued subagent run" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory override (defaults to prior run cwd)" }),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in milliseconds. Default: ${DEFAULT_SUBAGENT_TIMEOUT_MS} (120s).`,
		}),
	),
	instructions: Type.Optional(
		Type.String({
			description: "Bounded repository/task instructions passed to the child (max 16 KB)",
		}),
	),
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

export default async function (pi: ExtensionAPI): Promise<void> {
	await install_subagent_render_spacing_patch();
	let currentCtx: ExtensionContext | undefined;

	// Session-global per-type letter counters. Each agent type (e.g. "Coder",
	// "Scout") gets its own A, B, C… sequence that persists across tool calls
	// within a session and resets on session replacement.
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
		clearSubagentTiming();
		getSubagentGroupRenderer().resetForSession();
		try {
			const branch = ctx.sessionManager.getBranch() ?? [];
			seed_subagent_renderer_from_branch(branch, getSubagentGroupRenderer());
		} catch {
			/* branch may be unavailable during early startup */
		}
		agentLetterCounters.clear();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			prune_foreign_checkpoints(ctx.sessionManager.getSessionId());
		} catch {
			/* session may already be torn down */
		}
		currentCtx = undefined;
		threadStore.clear();
		clearAllTickRecords();
		clearSubagentTiming();
		getSubagentGroupRenderer().resetForSession();
		agentLetterCounters.clear();
	});

	pi.on("tool_call", (event: { toolName?: string }) => {
		const compact = getSharedRenderer();
		if (event.toolName === "subagent" || is_subagent_resume_tool(event.toolName ?? "")) {
			compact.clearGroupThinkingChild();
			setGroupThinkingChildActive(compact.hasGroupThinkingChild());
			setGroupReopenableActive(isThinkingBlocksHidden() && compact.hasReopenableGroup());
			setToolGroupActive(compact.hasActiveGroups());
			syncThinkingGradientClock();
			return;
		}
		getSubagentGroupRenderer().hardExit();
	});

	pi.on("tool_execution_end", (event: { toolName?: string; toolCallId?: string }) => {
		if (
			(event.toolName === "subagent" || is_subagent_resume_tool(event.toolName ?? "")) &&
			typeof event.toolCallId === "string"
		) {
			markSubagentTerminal(event.toolCallId);
			clear_subagent_thinking_pass(event.toolCallId);
			const batch = getSubagentGroupRenderer().getBatch(event.toolCallId);
			if (!any_batch_member_running(batch)) {
				const owner = batch_owner(batch);
				if (owner) unsubscribeTick(owner.toolCallId);
			}
			batch_owner(batch)?.invalidate?.();
		}
	});

	pi.on("message_start", (event: { message?: { role?: string } }) => {
		if (event.message?.role === "user") {
			getSubagentGroupRenderer().hardExit();
		}
	});

	// A visible thinking block is a chronological transcript boundary: a later
	// subagent tool call must not join an earlier Subagents batch whose header
	// renders above the reasoning trace. Hidden thinking renders no block and
	// keeps consecutive delegations collapsing into one batch.
	pi.on("message_update", (event: {
		assistantMessageEvent?: { type?: string };
		message?: { role?: string; display?: boolean };
	}) => {
		apply_subagent_group_stream_boundary(
			getSubagentGroupRenderer(),
			event.assistantMessageEvent,
			event.message,
		);
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
					"\n\nThe subagent tool is available for delegating tasks to specialized agents with isolated context. Use subagent_resume with a lettered name (e.g. Coder A) to continue a prior subagent. Use /subagent to list available agents. Bundled: Scout (fast codebase exploration), Coder (implementation). Modes: single, parallel (max 8), chain.",
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

	function render_subagent_call(
		args: SubagentArgs,
		theme: CustomFactoryTheme,
		context: { toolCallId: string; invalidate: () => void; state: Record<string, unknown> },
	): Component {
		const group_renderer = getSubagentGroupRenderer();
		const cached_record = group_renderer.getRecord(context.toolCallId);
		const state_results =
			(context.state.results as SubAgentResult[] | undefined) ?? cached_record?.results ?? [];
		const record = group_renderer.register(
			context.toolCallId,
			args,
			state_results,
			context.invalidate,
		);
		const results = record.results;
		const batch = group_renderer.getBatch(context.toolCallId);
		const owner = batch_owner(batch);
		const batch_running = any_batch_member_running(batch);
		const owner_tool_call_id = owner?.toolCallId ?? context.toolCallId;
		const terminal = isSubagentToolTerminal(owner_tool_call_id);

		if (!group_renderer.isOwner(context.toolCallId)) {
			if (owner && batch_running) {
				sync_owner_gradient_tick(owner, true, theme, owner.invalidate ?? context.invalidate);
				owner.invalidate?.();
			}
			return new Text("", 0, 0);
		}

		let shell = context.state.shell;
		if (!(shell instanceof Container)) {
			shell = new Container();
			context.state.shell = shell;
		}
		(shell as Container).clear();

		const grouped_members = group_renderer.shouldUseGroupLayout(context.toolCallId)
			? map_grouped_members(batch)
			: undefined;
		if (batch_running) {
			markSubagentRunning(owner_tool_call_id);
			if (!isSubagentToolTerminal(context.toolCallId)) {
				markSubagentRunning(context.toolCallId);
			}
		}
		const elapsedMs = grouped_members
			? getGroupElapsedMs(batch)
			: getSubagentElapsedMs(context.toolCallId);
		const layout = buildSubagentLayoutComponent(
			args,
			results,
			theme,
			elapsedMs,
			grouped_members,
			!batch_running && terminal,
			context.toolCallId,
			undefined,
			!isThinkingBlocksHidden(),
		);
		context.state.layout = layout;
		(shell as Container).addChild(layout);

		if (owner) {
			sync_owner_gradient_tick(owner, batch_running, theme, context.invalidate);
		}
		return shell as Container;
	}

	function render_subagent_result(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		expanded: boolean,
		theme: CustomFactoryTheme,
		context: {
			toolCallId: string;
			invalidate: () => void;
			state: Record<string, unknown>;
			args: SubagentArgs;
			isError?: boolean;
		},
	): Component {
		const group_renderer = getSubagentGroupRenderer();
		const details = result.details as SubagentDetails | undefined;
		const results = details?.results ?? [];
		const failureMessage =
			context.isError === true && results.length === 0
				? result.content
						.filter(
							(item): item is { type: "text"; text: string } =>
								item.type === "text" && typeof item.text === "string",
						)
						.map((item) => item.text.trim())
						.filter(Boolean)
						.join(" ") || undefined
				: undefined;
		context.state.results = results;
		group_renderer.register(
			context.toolCallId,
			context.args,
			results,
			context.invalidate,
			failureMessage,
		);

		const batch = group_renderer.getBatch(context.toolCallId);
		const owner = batch_owner(batch);
		const batch_running = any_batch_member_running(batch);

		if (!group_renderer.isOwner(context.toolCallId)) {
			if (owner && batch_running) {
				sync_owner_gradient_tick(owner, true, theme, owner.invalidate ?? context.invalidate);
			}
			owner?.invalidate?.();
			return new Text("", 0, 0);
		}

		const owner_tool_call_id = owner?.toolCallId ?? context.toolCallId;
		let terminal = isSubagentToolTerminal(owner_tool_call_id);
		const isRunning = batch_running;
		if (!isRunning) {
			markSubagentTerminal(context.toolCallId);
		}
		terminal = isSubagentToolTerminal(owner_tool_call_id);
		const grouped_members = group_renderer.shouldUseGroupLayout(context.toolCallId)
			? map_grouped_members(batch)
			: undefined;
		const elapsedMs = grouped_members
			? getGroupElapsedMs(batch)
			: getSubagentElapsedMs(context.toolCallId);
		if (owner) {
			sync_owner_gradient_tick(owner, isRunning, theme, context.invalidate);
		}
		if (!details) {
			const outputBlock = result.content.find((item) => item.type === "text");
			const output = outputBlock?.type === "text" ? outputBlock.text : "(no output)";
			return new Text(output ?? "(no output)", 0, 0);
		}

		const shell = context.state.shell;
		if (shell instanceof Container) {
			shell.clear();
			const layout = buildSubagentLayoutComponent(
				context.args,
				results,
				theme,
				elapsedMs,
				grouped_members,
				!isRunning && terminal,
				context.toolCallId,
				failureMessage,
				!isThinkingBlocksHidden(),
			);
			context.state.layout = layout;
			shell.addChild(layout);
		}

		if (expanded && !isRunning && details && details.results.length > 0) {
			const expandedContent = renderSubagentExpanded(details, theme);
			if (expandedContent) return expandedContent;
		}

		return new Text("", 0, 0);
	}

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
			"Bundled agents: Scout (fast recon), Coder (implementation). Coder's `todo` list is child-session-local: use ids from its own `create`, or an exact `task` subject; call `list` only when needed.",
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
				runOptions?: {
					checkpoint?: {
						parentSessionId: string;
						originToolCallId: string;
						displayName: string;
						agentName: string;
					};
					resume?: {
						parentSessionId: string;
						originToolCallId: string;
						displayName: string;
					};
				},
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
				const defaultTools = [...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS];
				let tools = with_provider_patch_tool(
					agent.tools ?? defaultTools,
					model_provider_of(resolved.model),
				);
				tools = without_subagent_delegation_tools(tools);

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
					checkpoint: runOptions?.checkpoint,
					resume: runOptions?.resume,
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
							note_subagent_live_partial(_toolCallId, partial);
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
						if (onUpdate) {
							onUpdate({
								content: agent_tool_result_content(result),
								details: makeDetails("chain")(results),
							});
						}
						const prevCount = i;
						let contentText: string;
						if (prevCount > 0) {
							const prevSummaries = results
								.slice(0, prevCount)
								.map((r) => format_agent_tool_result_text(r, (body) => body.slice(0, 500)))
								.join("\n\n");
							contentText = `Chain stopped at step ${i + 1}/${params.chain.length}. ${prevCount} previous step(s) succeeded:\n\n${prevSummaries}\n\nError at step ${i + 1}:\n\n${format_agent_tool_result_text(result)}`;
						} else {
							contentText = `Chain stopped at step ${i + 1}/${params.chain.length}:\n\n${format_agent_tool_result_text(result)}`;
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
							content: agent_tool_result_content(result),
							details: makeDetails("chain")(results),
						});
					}
				}

				const last = results[results.length - 1];
				return {
					content: agent_tool_result_content(last),
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
								note_subagent_live_partial(_toolCallId, partial);
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

				let headerText = `Parallel: ${successCount}/${results.length} succeeded`;
				if (cancelCount > 0) headerText += ` (${cancelCount} cancelled)`;
				return {
					content: [
						{
							type: "text",
							text: format_agent_tool_result_batch(results, {
								header: headerText,
								format_body: truncateParallelOutput,
							}),
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// --- Single mode ---
			if (params.agent && params.task) {
				const agentName = resolve_agent_name(params.agent);
				const displayName = assign_agent_letter(agentName);
				getSubagentGroupRenderer().setDisplayName(_toolCallId, displayName);
				const thread = threadStore.createThread({
					agentName: displayName,
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
					agent: displayName,
					task: params.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyUsage,
				};
				if (onUpdate) {
					onUpdate({
						content: agent_tool_result_content(runningPlaceholder),
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
					displayName,
					(partial) => {
						note_subagent_live_partial(_toolCallId, partial);
						threadStore.updateThread(thread.id, { result: partial });
						if (onUpdate) {
							onUpdate({
								content: agent_tool_result_content(partial),
								details: makeDetails("single")([partial]),
							});
						}
					},
					{
						checkpoint: {
							parentSessionId: ctx.sessionManager.getSessionId(),
							originToolCallId: _toolCallId,
							displayName,
							agentName,
						},
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
						content: agent_tool_result_content(result),
						details: makeDetails("single")([result]),
					});
				}

				if (isError) {
					return {
						content: agent_tool_result_content(result),
						details: makeDetails("single")([result]),
						isError: true,
					};
				}

				return {
					content: agent_tool_result_content(result),
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
			return render_subagent_call(args, theme, context);
		},

		renderResult(result, { expanded }, theme, context) {
			return render_subagent_result(result, expanded === true, theme, context);
		},
	});

	pi.registerTool({
		name: SUBAGENT_RESUME_TOOL_NAME,
		label: "Subagent Resume",
		description:
			"Continue a prior single-mode subagent by its lettered display name (e.g. Coder A). Requires a persisted child session from an earlier subagent call in this parent session.",
		parameters: SubagentResumeParams,
		renderShell: "self",
		promptSnippet: "Continue a prior subagent (Coder A, Scout B, …)",
		promptGuidelines: [
			"Use subagent_resume when a prior lettered subagent (e.g. Coder A) should continue the same isolated session with a follow-up task.",
			"Resume only works for single-mode subagent runs, not parallel or chain batches.",
			"Spawn the initial run with subagent before calling subagent_resume.",
		],
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = resolve_resume_target(ctx, params.agent);
			if (!resolved.ok) {
				return {
					content: [{ type: "text", text: resolved.error }],
					details: {
						mode: "single" as const,
						agentScope: "user" as const,
						projectAgentsDir: null,
						results: [],
					},
					isError: true,
				};
			}

			const target = resolved.target;
			const discovery = discoverAgents(ctx.cwd, "user", bundledAgentsDir);
			const agent = resolveAgent(discovery.agents, target.agentName);
			if (!agent) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent for resume target "${target.displayName}": ${target.agentName}`,
						},
					],
					details: {
						mode: "single" as const,
						agentScope: "user" as const,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
					isError: true,
				};
			}

			const displayName = target.displayName;
			getSubagentGroupRenderer().setDisplayName(_toolCallId, displayName);
			const thread = threadStore.createThread({
				agentName: displayName,
				task: params.task,
				mode: "single",
				toolCallId: _toolCallId,
			});

			const modelRegistry = ctx.modelRegistry;
			const resolvedModel = resolveModel(agent.model, ctx.model, ctx.modelRegistry);
			if (!resolvedModel.model) {
				const tried = resolvedModel.attempted.join(", ") || "none";
				return {
					content: [{ type: "text", text: `Model not found for resume target (tried: ${tried}).` }],
					details: {
						mode: "single" as const,
						agentScope: "user" as const,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
					isError: true,
				};
			}

			let tools = with_provider_patch_tool(
				agent.tools ?? [...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS],
				model_provider_of(resolvedModel.model),
			);
			tools = without_subagent_delegation_tools(tools);

			const runningPlaceholder: SubAgentResult = {
				agent: displayName,
				task: params.task,
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
			const makeDetails = (results: SubAgentResult[]): SubagentDetails => ({
				mode: "single",
				agentScope: "user",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if (onUpdate) {
				onUpdate({
					content: agent_tool_result_content(runningPlaceholder),
					details: makeDetails([runningPlaceholder]),
				});
			}

			const result = await runSubAgent({
				cwd: params.cwd ?? target.cwd ?? ctx.cwd,
				systemPrompt: params.instructions
					? `${agent.systemPrompt}\n\n## Task Contract\n${params.instructions.slice(0, 16 * 1024)}`
					: agent.systemPrompt,
				task: params.task,
				tools,
				model: resolvedModel.model,
				modelRegistry,
				parentSignal: signal,
				timeoutMs: params.timeout,
				agentName: displayName,
				thinkingLevel: agent.thinking,
				onMessage: (partial) => threadStore.updateThread(thread.id, { result: partial }),
				onToolCall: (partial) => {
					note_subagent_live_partial(_toolCallId, partial);
					threadStore.updateThread(thread.id, { result: partial });
					onUpdate?.({
						content: agent_tool_result_content(partial),
						details: makeDetails([partial]),
					});
				},
				resume: {
					parentSessionId: target.parentSessionId,
					originToolCallId: target.originToolCallId,
					displayName,
				},
			});

			threadStore.updateThread(thread.id, {
				status: isFailedResult(result)
					? result.stopReason === "aborted"
						? "aborted"
						: "failed"
					: "completed",
				result,
			});

			if (onUpdate) {
				onUpdate({
					content: agent_tool_result_content(result),
					details: makeDetails([result]),
				});
			}

			if (isFailedResult(result)) {
				return {
					content: agent_tool_result_content(result),
					details: makeDetails([result]),
					isError: true,
				};
			}

			return {
				content: agent_tool_result_content(result),
				details: makeDetails([result]),
			};
		},

		renderCall(args, theme, context) {
			return render_subagent_call(args, theme, context);
		},

		renderResult(result, { expanded }, theme, context) {
			return render_subagent_result(result, expanded === true, theme, context);
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
				_tui: CustomFactoryTui,
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
					buildSelectListTheme(theme as unknown as Theme),
				);
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
						requestTuiRender();
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
			(_tui: CustomFactoryTui, theme: CustomFactoryTheme, _kb: unknown, done: () => void) => {
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
								requestTuiRender();
							}
						},
						onNext: () => {
							const current = getThreads();
							if (currentIndex < current.length - 1) {
								currentIndex++;
								viewer.setThread(current[currentIndex], makeCallbacks());
								requestTuiRender();
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
					requestTuiRender();
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
						requestTuiRender();
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
						requestTuiRender();
					}
				}
			},
			{ overlay: true, overlayOptions: { maxHeight: "70%" } },
		); // Overlay: editor stays visible below
	}
}
