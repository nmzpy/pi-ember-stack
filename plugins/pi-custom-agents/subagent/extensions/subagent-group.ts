import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubAgentResult } from "./runner.ts";

export interface SubagentArgs {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
}

export interface SubagentCallRecord {
	toolCallId: string;
	args: SubagentArgs;
	results: SubAgentResult[];
	/** Tool-level failure text when Pi finalized without per-agent details. */
	failureMessage?: string;
	invalidate?: () => void;
	/** Lettered display label (e.g. Coder A) assigned when the call starts. */
	displayName?: string;
}

export function isSingleModeSubagentArgs(args: SubagentArgs): boolean {
	return Boolean(
		args.agent && args.task && !((args.tasks?.length ?? 0) > 0) && !((args.chain?.length ?? 0) > 0),
	);
}

/** Whether a snapshot still has live nested tool/text/thinking rows beneath the agent. */
export function has_live_nested_preview(results: SubAgentResult[]): boolean {
	return results.some(
		(result) =>
			result.latestToolCall ||
			result.isThinking ||
			result.isFinishing ||
			(result.liveItems?.length ?? 0) > 0,
	);
}

/**
 * An explicit false from agent_settled is authoritative. Do not let the
 * stale-preview guard retain a transient Finishing row after the child has
 * reached its terminal lifecycle event.
 */
function has_authoritative_finishing_clear(
	existing: SubAgentResult[],
	incoming: SubAgentResult[],
): boolean {
	return existing.some((old_result, old_index) =>
		old_result.isFinishing === true &&
		incoming.some(
			(next_result, next_index) =>
				next_result.isFinishing === false &&
					(old_result.toolCallId && next_result.toolCallId
						? old_result.toolCallId === next_result.toolCallId
						: old_index === next_index),
		),
	);
}

/** Keep live onToolCall partials when Pi renderCall replays stale context.state. */
export function should_keep_existing_subagent_results(
	existing: SubAgentResult[],
	incoming: SubAgentResult[],
): boolean {
	if (existing.length === 0) return false;
	if (incoming.length === 0) return true;
	if (has_authoritative_finishing_clear(existing, incoming)) return false;
	if (has_live_nested_preview(existing) && !has_live_nested_preview(incoming)) return true;
	return false;
}

/**
 * Per-tool-call subagent render state.
 *
 * Every subagent tool call is its own independent visual owner: there is no
 * cross-call batching, so consecutive single-mode delegations never collapse
 * under a shared `Subagents` header and a native parallel/chain call never
 * shares a `Delegating` header. The renderer only stores the per-call record
 * (args, live results, display name, invalidate target) so Pi rebuilds and
 * onToolCall partials can recover state by toolCallId.
 */
export class SubagentGroupRenderer {
	private readonly by_id = new Map<string, SubagentCallRecord>();

	resetForSession(): void {
		this.by_id.clear();
	}

	getRecord(toolCallId: string): SubagentCallRecord | undefined {
		return this.by_id.get(toolCallId);
	}

	register(
		toolCallId: string,
		args: SubagentArgs,
		results: SubAgentResult[],
		invalidate?: () => void,
		failureMessage?: string,
	): SubagentCallRecord {
		const existing = this.by_id.get(toolCallId);
		if (existing) {
			existing.args = args;
			// Pi rebuilds may call renderCall with a fresh context before renderResult;
			// never wipe a populated snapshot with an empty placeholder or stale state.
			if (should_keep_existing_subagent_results(existing.results, results)) {
				// keep existing.results
			} else if (results.length > 0 || existing.results.length === 0) {
				existing.results = results;
			}
			if (invalidate) existing.invalidate = invalidate;
			if (failureMessage) existing.failureMessage = failureMessage;
			return existing;
		}

		const record: SubagentCallRecord = { toolCallId, args, results, invalidate, failureMessage };
		this.by_id.set(toolCallId, record);
		return record;
	}

	setDisplayName(toolCallId: string, displayName: string): void {
		const record = this.by_id.get(toolCallId);
		if (record) record.displayName = displayName;
	}
}

let shared_group_renderer: SubagentGroupRenderer | undefined;

export function getSubagentGroupRenderer(): SubagentGroupRenderer {
	if (!shared_group_renderer) shared_group_renderer = new SubagentGroupRenderer();
	return shared_group_renderer;
}

const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_resume"]);

/**
 * Restore per-call subagent render state from branch history before Pi
 * rebuilds (ctrl+t thinking toggle, compaction, output-pad changes). Every
 * subagent tool call gets its own record so live partials and display names
 * survive the rebuild. No batch/header state exists anymore — each call is
 * already an independent owner.
 */
export function seed_subagent_renderer_from_branch(
	branch: SessionEntry[],
	renderer: SubagentGroupRenderer,
): void {
	const args_by_id = new Map<string, SubagentArgs>();
	const results_by_id = new Map<string, SubAgentResult[]>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				if ((part as { type?: string }).type !== "toolCall") continue;
				const tc = part as { id?: string; name?: string; arguments?: unknown };
				if (typeof tc.id !== "string" || typeof tc.name !== "string") continue;
				if (!SUBAGENT_TOOL_NAMES.has(tc.name)) continue;
				args_by_id.set(tc.id, (tc.arguments ?? {}) as SubagentArgs);
			}
		}
		if (msg.role === "toolResult") {
			if (!SUBAGENT_TOOL_NAMES.has(msg.toolName)) continue;
			const id = msg.toolCallId;
			if (typeof id !== "string") continue;
			const details = msg.details as { results?: SubAgentResult[] } | undefined;
			if (details?.results) results_by_id.set(id, details.results);
		}
	}

	for (const [toolCallId, args] of args_by_id) {
		renderer.register(toolCallId, args, results_by_id.get(toolCallId) ?? []);
		const displayName = results_by_id.get(toolCallId)?.[0]?.agent;
		if (displayName) renderer.setDisplayName(toolCallId, displayName);
	}
}
