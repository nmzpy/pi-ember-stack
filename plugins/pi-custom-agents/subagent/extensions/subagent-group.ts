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
	invalidate?: () => void;
}

export function isSingleModeSubagentArgs(args: SubagentArgs): boolean {
	return Boolean(
		args.agent && args.task && !((args.tasks?.length ?? 0) > 0) && !((args.chain?.length ?? 0) > 0),
	);
}

function isNativeMultiModeSubagentArgs(args: SubagentArgs): boolean {
	return (args.tasks?.length ?? 0) > 0 || (args.chain?.length ?? 0) > 0;
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

	register(
		toolCallId: string,
		args: SubagentArgs,
		results: SubAgentResult[],
		invalidate?: () => void,
	): SubagentCallRecord {
		const existing = this.by_id.get(toolCallId);
		if (existing) {
			existing.args = args;
			existing.results = results;
			if (invalidate) existing.invalidate = invalidate;
			return existing;
		}

		const record: SubagentCallRecord = { toolCallId, args, results, invalidate };
		this.by_id.set(toolCallId, record);

		if (isNativeMultiModeSubagentArgs(args) || !isSingleModeSubagentArgs(args)) {
			this.hardExit();
			this.batch = [record];
			return record;
		}

		if (!this.batch || this.batch.length === 0) {
			this.batch = [record];
			return record;
		}

		const anchor = this.batch[0];
		if (!isSingleModeSubagentArgs(anchor.args)) {
			this.batch = [record];
			return record;
		}

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
