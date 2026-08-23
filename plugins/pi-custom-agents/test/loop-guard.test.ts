import { describe, expect, test } from "bun:test";
import {
	create_loop_guard_state,
	evaluate_tool_call,
	reset_run_state,
	reset_session_state,
	resolve_settled_action,
	apply_quiz_outcome,
	tool_call_signature,
	LOOP_TOOL_CALL_LIMIT,
	PERSISTENT_LOOP_THRESHOLD,
} from "../loop-guard.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL = "read";
const INPUT_A = { path: "/foo.ts" };
const INPUT_B = { path: "/bar.ts" };

// ---------------------------------------------------------------------------
// (a) 3 consecutive same calls → auto-retry (first detection)
// ---------------------------------------------------------------------------

describe("loop guard — first detection auto-retry", () => {
	test("3 consecutive identical calls trip the guard as 'first'", () => {
		const state = create_loop_guard_state();

		// First two calls: no block.
		expect(evaluate_tool_call(state, TOOL, INPUT_A).block).toBe(false);
		expect(evaluate_tool_call(state, TOOL, INPUT_A).block).toBe(false);

		// Third call: trips.
		const r3 = evaluate_tool_call(state, TOOL, INPUT_A);
		expect(r3.block).toBe(true);
		expect(r3.tripped).toBe(true);
		expect(r3.kind).toBe("first");

		// Settled → auto_retry.
		const settled = resolve_settled_action(state);
		expect(settled.type).toBe("auto_retry");
		expect(settled.signature).toBe(tool_call_signature(TOOL, INPUT_A));
	});

	test("after auto_retry the signature is in retried_signatures", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);

		expect(state.retried_signatures.has(tool_call_signature(TOOL, INPUT_A))).toBe(true);
	});

	test("after auto_retry, per-run state is reset but retried_signatures persist", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);

		expect(state.detected).toBe(false);
		expect(state.count).toBe(0);
		expect(state.signature).toBeUndefined();
		expect(state.retried_signatures.size).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// (b) Next same call is caught at threshold 1 and shows the quiz
// ---------------------------------------------------------------------------

describe("loop guard — persistent detection shows quiz", () => {
	test("a repeated signature on the retry turn is caught at threshold 1", () => {
		const state = create_loop_guard_state();

		// First detection + auto-retry.
		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);

		// Reset for the new run (agent_start).
		reset_run_state(state);

		// First call of the new run with the same signature → immediate trip.
		const r = evaluate_tool_call(state, TOOL, INPUT_A);
		expect(r.block).toBe(true);
		expect(r.tripped).toBe(true);
		expect(r.kind).toBe("persistent");
		expect(state.count).toBe(PERSISTENT_LOOP_THRESHOLD);

		// Settled → show_quiz.
		const settled = resolve_settled_action(state);
		expect(settled.type).toBe("show_quiz");
		expect(settled.signature).toBe(tool_call_signature(TOOL, INPUT_A));
	});
});

// ---------------------------------------------------------------------------
// (c) "end" clears the history
// ---------------------------------------------------------------------------

describe("loop guard — quiz 'end' outcome", () => {
	test("end removes the signature from retried_signatures", () => {
		const state = create_loop_guard_state();
		const sig = tool_call_signature(TOOL, INPUT_A);

		// First detection + auto-retry.
		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);
		reset_run_state(state);

		// Persistent detection.
		evaluate_tool_call(state, TOOL, INPUT_A);
		const settled = resolve_settled_action(state);
		expect(settled.type).toBe("show_quiz");

		// User chooses "end".
		apply_quiz_outcome(state, "end", settled.signature);

		expect(state.retried_signatures.has(sig)).toBe(false);
		expect(state.detected).toBe(false);
		expect(state.prompt_active).toBe(false);
	});

	test("after end, the same signature requires 3 calls again", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);
		reset_run_state(state);

		evaluate_tool_call(state, TOOL, INPUT_A);
		const settled = resolve_settled_action(state);
		apply_quiz_outcome(state, "end", settled.signature);
		reset_run_state(state);

		// Now the same tool call should NOT trip at count 1.
		const r1 = evaluate_tool_call(state, TOOL, INPUT_A);
		expect(r1.block).toBe(false);
		expect(r1.tripped).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (d) session_shutdown clears all state
// ---------------------------------------------------------------------------

describe("loop guard — session_shutdown", () => {
	test("reset_session_state clears retried_signatures", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);

		expect(state.retried_signatures.size).toBe(1);

		reset_session_state(state);

		expect(state.retried_signatures.size).toBe(0);
		expect(state.detected).toBe(false);
		expect(state.count).toBe(0);
		expect(state.signature).toBeUndefined();
		expect(state.prompt_active).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (e) Non-identical calls reset the counter
// ---------------------------------------------------------------------------

describe("loop guard — non-identical calls reset counter", () => {
	test("a different input resets the count to 1", () => {
		const state = create_loop_guard_state();

		// Two identical calls.
		evaluate_tool_call(state, TOOL, INPUT_A);
		evaluate_tool_call(state, TOOL, INPUT_A);
		expect(state.count).toBe(2);

		// Different input → counter resets.
		const r = evaluate_tool_call(state, TOOL, INPUT_B);
		expect(r.block).toBe(false);
		expect(state.count).toBe(1);
		expect(state.signature).toBe(tool_call_signature(TOOL, INPUT_B));
	});

	test("a different tool name resets the count to 1", () => {
		const state = create_loop_guard_state();

		evaluate_tool_call(state, TOOL, INPUT_A);
		evaluate_tool_call(state, TOOL, INPUT_A);
		expect(state.count).toBe(2);

		const r = evaluate_tool_call(state, "edit", INPUT_A);
		expect(r.block).toBe(false);
		expect(state.count).toBe(1);
	});

	test("alternating inputs never trip the guard", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < 10; i++) {
			const input = i % 2 === 0 ? INPUT_A : INPUT_B;
			const r = evaluate_tool_call(state, TOOL, input);
			expect(r.block).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("loop guard — edge cases", () => {
	test("after detection, further calls are blocked without re-tripping", () => {
		const state = create_loop_guard_state();

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}

		// State is detected=true now.
		const r = evaluate_tool_call(state, "grep", { query: "foo" });
		expect(r.block).toBe(true);
		expect(r.tripped).toBe(false);
	});

	test("prompt_active blocks all calls", () => {
		const state = create_loop_guard_state();
		state.prompt_active = true;

		const r = evaluate_tool_call(state, TOOL, INPUT_A);
		expect(r.block).toBe(true);
		expect(r.tripped).toBe(false);
	});

	test("retry outcome keeps the signature in retried_signatures", () => {
		const state = create_loop_guard_state();
		const sig = tool_call_signature(TOOL, INPUT_A);

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);
		reset_run_state(state);

		evaluate_tool_call(state, TOOL, INPUT_A);
		const settled = resolve_settled_action(state);
		apply_quiz_outcome(state, "retry", settled.signature);

		expect(state.retried_signatures.has(sig)).toBe(true);
		expect(state.detected).toBe(false);
		expect(state.prompt_active).toBe(false);
	});

	test("custom outcome keeps the signature in retried_signatures", () => {
		const state = create_loop_guard_state();
		const sig = tool_call_signature(TOOL, INPUT_A);

		for (let i = 0; i < LOOP_TOOL_CALL_LIMIT; i++) {
			evaluate_tool_call(state, TOOL, INPUT_A);
		}
		resolve_settled_action(state);
		reset_run_state(state);

		evaluate_tool_call(state, TOOL, INPUT_A);
		const settled = resolve_settled_action(state);
		apply_quiz_outcome(state, "custom", settled.signature);

		expect(state.retried_signatures.has(sig)).toBe(true);
	});

	test("no detection → settled action is none", () => {
		const state = create_loop_guard_state();
		evaluate_tool_call(state, TOOL, INPUT_A);

		const settled = resolve_settled_action(state);
		expect(settled.type).toBe("none");
	});
});
