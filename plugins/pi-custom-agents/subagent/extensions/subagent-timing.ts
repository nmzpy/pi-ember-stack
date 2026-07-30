import { formatElapsed } from "../../../pi-ember-ui/index.ts";
import { THINKING_ELAPSED_MIN_MS } from "../../../pi-ember-ui/thinking-status-render.ts";

/** Elapsed-time + terminal tracking per subagent tool call — SSOT with Thinking's formatElapsed. */

const subagent_started_at = new Map<string, number>();
const subagent_final_elapsed_ms = new Map<string, number>();
const subagent_thinking_started_at = new Map<string, number>();

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
	clear_subagent_thinking_pass(toolCallId);
}

/** Arm a per-subagent thinking-pass timer (mirrors parent thinkingPassStartedAt). */
export function arm_subagent_thinking_pass(toolCallId: string): void {
	if (!subagent_thinking_started_at.has(toolCallId)) {
		subagent_thinking_started_at.set(toolCallId, performance.now());
	}
}

export function clear_subagent_thinking_pass(toolCallId: string): void {
	subagent_thinking_started_at.delete(toolCallId);
}

/** Dim elapsed suffix for nested subagent Thinking rows — SSOT with parent Thinking. */
export function format_subagent_thinking_elapsed_suffix(
	theme: { fg: (color: string, text: string) => string },
	toolCallId: string | undefined,
): string {
	if (!toolCallId) return "";
	const start = subagent_thinking_started_at.get(toolCallId);
	if (start === undefined) return "";
	const elapsedMs = performance.now() - start;
	if (elapsedMs < THINKING_ELAPSED_MIN_MS) return "";
	return theme.fg("dim", ` ${formatElapsed(elapsedMs)}`);
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
	subagent_thinking_started_at.clear();
}
