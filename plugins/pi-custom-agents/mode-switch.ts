/**
 * Mode-switch deferral helpers (SSOT).
 *
 * A manual mode switch while an agent run is still in flight must be
 * deferred: applying it live would mutate the ongoing stream (setActiveTools,
 * the hidden tool-access reminder, or the bound-model restore would abort or
 * poison the run) and would dismiss a pending Plan Review, because
 * `agent_settled` gates the review on `currentMode === "plan"`. The live UI
 * accent/label flips immediately; the logical switch is flushed once the run
 * settles, so it takes effect with the next message.
 */

/** True when a mode switch must wait for the current agent run to settle. */
export function should_defer_mode_switch(
	prevModeId: string,
	nextModeId: string,
	agentRunPending: boolean,
): boolean {
	return prevModeId !== nextModeId && agentRunPending;
}
