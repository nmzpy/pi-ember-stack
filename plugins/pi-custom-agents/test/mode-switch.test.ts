import { describe, expect, test } from "bun:test";
import { should_defer_mode_switch } from "../mode-switch.ts";

describe("should_defer_mode_switch", () => {
	test("defers a real mode change while an agent run is in flight", () => {
		expect(should_defer_mode_switch("plan", "code", true)).toBe(true);
		expect(should_defer_mode_switch("plan", "orchestrate", true)).toBe(true);
		expect(should_defer_mode_switch("code", "plan", true)).toBe(true);
	});

	test("never defers when the agent run has settled", () => {
		expect(should_defer_mode_switch("plan", "code", false)).toBe(false);
		expect(should_defer_mode_switch("plan", "orchestrate", false)).toBe(false);
	});

	test("never defers a same-mode re-apply even during a run", () => {
		expect(should_defer_mode_switch("plan", "plan", true)).toBe(false);
		expect(should_defer_mode_switch("code", "code", true)).toBe(false);
		expect(should_defer_mode_switch("code", "code", false)).toBe(false);
	});

	test("force bypasses deferral for post-settle decisions even while the flag is set", () => {
		// Plan Review "Implement Plan" switch and the agent_settled flush run
		// after the run is logically over; pi-ember-ui's agent_settled listener
		// clears agentRunPending only after pi-custom-agents' handler has run.
		expect(should_defer_mode_switch("plan", "orchestrate", true, true)).toBe(false);
		expect(should_defer_mode_switch("plan", "code", true, true)).toBe(false);
		expect(should_defer_mode_switch("code", "plan", true, true)).toBe(false);
	});

	test("force still never defers a same-mode re-apply", () => {
		expect(should_defer_mode_switch("plan", "plan", true, true)).toBe(false);
		expect(should_defer_mode_switch("plan", "plan", false, true)).toBe(false);
	});
});
