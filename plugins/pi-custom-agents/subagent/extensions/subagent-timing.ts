/** Elapsed-time + terminal tracking per subagent tool call — SSOT with Thinking's formatElapsed. */

const subagent_started_at = new Map<string, number>();
const subagent_final_elapsed_ms = new Map<string, number>();

export function markSubagentRunning(toolCallId: string): void {
	if (!subagent_started_at.has(toolCallId)) {
		subagent_started_at.set(toolCallId, performance.now());
	}
}

export function markSubagentTerminal(toolCallId: string): void {
	if (subagent_final_elapsed_ms.has(toolCallId)) return;
	const start = subagent_started_at.get(toolCallId);
	if (start !== undefined) {
		subagent_final_elapsed_ms.set(toolCallId, performance.now() - start);
	} else {
		subagent_final_elapsed_ms.set(toolCallId, 0);
	}
}

export function isSubagentToolTerminal(toolCallId: string): boolean {
	return subagent_final_elapsed_ms.has(toolCallId);
}

export function getSubagentElapsedMs(toolCallId: string): number {
	const final = subagent_final_elapsed_ms.get(toolCallId);
	if (final !== undefined) return final;
	const start = subagent_started_at.get(toolCallId);
	if (start === undefined) return 0;
	return performance.now() - start;
}

export function getGroupElapsedMs(batch: Array<{ toolCallId: string }>): number {
	let max = 0;
	for (const member of batch) {
		max = Math.max(max, getSubagentElapsedMs(member.toolCallId));
	}
	return max;
}

export function clearSubagentTiming(): void {
	subagent_started_at.clear();
	subagent_final_elapsed_ms.clear();
}
