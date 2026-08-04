import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubAgentResult } from "./runner.ts";
import { isThinkingBlocksHidden } from "../../../pi-ember-ui/mode-colors.ts";

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

function isNativeMultiModeSubagentArgs(args: SubagentArgs): boolean {
	return (args.tasks?.length ?? 0) > 0 || (args.chain?.length ?? 0) > 0;
}

/** Whether a snapshot still has live nested tool/text/thinking rows beneath the agent. */
export function has_live_nested_preview(results: SubAgentResult[]): boolean {
	const head = results[0];
	return Boolean(
		head?.latestToolCall ||
			head?.isThinking ||
			(head?.liveItems?.length ?? 0) > 0,
	);
}

/** Keep live onToolCall partials when Pi renderCall replays stale context.state. */
export function should_keep_existing_subagent_results(
	existing: SubAgentResult[],
	incoming: SubAgentResult[],
): boolean {
	if (existing.length === 0) return false;
	if (incoming.length === 0) return true;
	if (has_live_nested_preview(existing) && !has_live_nested_preview(incoming)) return true;
	return false;
}

/** Groups consecutive single-mode subagent tool calls under one Subagents header. */
export class SubagentGroupRenderer {
	private batch: SubagentCallRecord[] | undefined;
	private readonly by_id = new Map<string, SubagentCallRecord>();

	resetForSession(): void {
		this.batch = undefined;
		this.by_id.clear();
	}

	hardExit(): void {
		this.batch = undefined;
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
			// A call that joined the batch while its args were still streaming may
			// turn out to be a native parallel/chain call once the brace closes;
			// eject it back into its own isolated batch so the singles group does
			// not absorb a multi-mode layout.
			if (
				isNativeMultiModeSubagentArgs(args) &&
				this.batch &&
				this.batch.length > 1 &&
				this.batch.includes(existing)
			) {
				const remaining = this.batch.filter((member) => member !== existing);
				this.batch = remaining;
				remaining[0]?.invalidate?.();
			}
			return existing;
		}

		const record: SubagentCallRecord = { toolCallId, args, results, invalidate, failureMessage };
		this.by_id.set(toolCallId, record);

		if (isNativeMultiModeSubagentArgs(args)) {
			this.hardExit();
			this.batch = [record];
			return record;
		}

		if (!this.batch || this.batch.length === 0) {
			this.batch = [record];
			return record;
		}

		const anchor = this.batch[0];
		if (isNativeMultiModeSubagentArgs(anchor.args)) {
			this.batch = [record];
			return record;
		}

		// Single-mode AND still-streaming calls (args brace not closed yet) share
		// one consecutive batch, so an orchestrator emitting several `subagent`
		// tool calls in a burst does not render a fresh "Delegating" row per call.
		const prev_owner = anchor;
		this.batch.push(record);
		if (this.batch.length === 2) {
			prev_owner.invalidate?.();
		}
		return record;
	}

	getBatch(toolCallId: string): SubagentCallRecord[] {
		const record = this.by_id.get(toolCallId);
		if (!record) return [];
		if (!this.batch?.includes(record)) return [record];
		return [...this.batch];
	}

	setDisplayName(toolCallId: string, displayName: string): void {
		const record = this.by_id.get(toolCallId);
		if (record) record.displayName = displayName;
	}

	isOwner(toolCallId: string): boolean {
		const batch = this.getBatch(toolCallId);
		return batch.length <= 1 || batch[0]?.toolCallId === toolCallId;
	}

	shouldUseGroupLayout(toolCallId: string): boolean {
		return this.getBatch(toolCallId).length > 1;
	}
}

let shared_group_renderer: SubagentGroupRenderer | undefined;

export function getSubagentGroupRenderer(): SubagentGroupRenderer {
	if (!shared_group_renderer) shared_group_renderer = new SubagentGroupRenderer();
	return shared_group_renderer;
}

const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_resume"]);

/**
 * Live subagent-batch boundary for assistant stream events (SSOT).
 *
 * A visible thinking block is a chronological transcript boundary: a later
 * subagent tool call must not join a Subagents batch whose header renders
 * above the reasoning trace. Hidden thinking renders no transcript block, so
 * consecutive delegations keep collapsing exactly as before. Hidden assistant
 * messages (display: false, e.g. auto-continue) stream no visible content, so
 * their thinking never splits the batch either.
 */
export function apply_subagent_group_stream_boundary(
	renderer: SubagentGroupRenderer,
	ev: { type?: string } | undefined,
	message?: { role?: string; display?: boolean } | null,
): void {
	if (!ev) return;
	if (ev.type !== "thinking_start" && ev.type !== "thinking_delta") return;
	if (isThinkingBlocksHidden()) return;
	if (message?.role === "assistant" && message.display === false) return;
	renderer.hardExit();
}

/** Restore grouped subagent layout state from branch history before Pi rebuilds. */
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

	// Chronological replay mirrors the flattened todo timeline for user-message
	// and tool boundaries while adding the subagent chronology rule: a visible
	// non-empty thinking part renders as a transcript block, so the next
	// subagent call starts a fresh batch instead of attaching above the
	// reasoning trace. Hidden thinking renders no block and keeps batching.
	let pending_visible_thinking = false;
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "user") {
			const display = (msg as { display?: boolean }).display;
			if (display !== false) {
				renderer.hardExit();
				pending_visible_thinking = false;
			}
			continue;
		}
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const hidden = (msg as { display?: boolean }).display === false;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: string; thinking?: unknown };
			if (p.type === "thinking") {
				if (
					!hidden &&
					!isThinkingBlocksHidden() &&
					typeof p.thinking === "string" &&
					p.thinking.trim().length > 0
				) {
					pending_visible_thinking = true;
				}
				continue;
			}
			if (p.type !== "toolCall") continue;
			const tc = p as { id?: string; name?: string };
			if (typeof tc.id !== "string" || typeof tc.name !== "string") continue;
			if (!SUBAGENT_TOOL_NAMES.has(tc.name)) {
				renderer.hardExit();
				pending_visible_thinking = false;
				continue;
			}
			if (pending_visible_thinking) {
				renderer.hardExit();
				pending_visible_thinking = false;
			}
			const args = args_by_id.get(tc.id) ?? {};
			const results = results_by_id.get(tc.id) ?? [];
			renderer.register(tc.id, args, results);
			const displayName = results[0]?.agent;
			if (displayName) renderer.setDisplayName(tc.id, displayName);
		}
	}
}
