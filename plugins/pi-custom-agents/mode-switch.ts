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
 *
 * Post-settle decisions bypass deferral with `force`: the Plan Review's
 * "Implement Plan" switch and the agent_settled flush run after the run is
 * logically over, so they must land immediately even though the shared
 * `agentRunPending` flag is still set (pi-ember-ui's own agent_settled
 * listener clears it only after pi-custom-agents' handler has run). Deferring
 * there would start the implement follow-up turn in the stale plan mode and
 * re-defer forever, leaving `currentMode` stuck while the UI shows the new
 * mode.
 */

/**
 * True when a mode switch must wait for the current agent run to settle.
 * `force` skips the wait for post-settle decisions (Plan Review implement,
 * the agent_settled flush) where the run is already over.
 */
export function should_defer_mode_switch(
	prevModeId: string,
	nextModeId: string,
	agentRunPending: boolean,
	force = false,
): boolean {
	if (force) return false;
	return prevModeId !== nextModeId && agentRunPending;
}
