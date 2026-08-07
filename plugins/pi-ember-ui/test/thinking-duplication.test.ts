import { afterEach, describe, expect, test } from "bun:test";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	clear_stale_thinking_wait_blockers,
	compact_thinking_lane_owns_status,
	reset_thinking_header_state_for_tests,
	resolve_thinking_status_host,
	suppress_thinking_header_for_work,
	thinking_status_should_show,
} from "../index.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import { sync_compact_group_flags } from "../../pi-compact-tools/group-flags.ts";
import {
	isGroupThinkingChildActive,
	isThinkingBlocksHidden,
	isUserTurnCommitted,
	markToolCallAnnounced,
	markToolExecutionEnded,
	markToolExecutionStarted,
	resetToolExecutionInFlight,
	setAgentRunPending,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	setThinkingBlocksHidden,
	setToolGroupActive,
	setTurnToolTranscriptActive,
	setUserTurnAnchorTimestamp,
	setUserTurnCommitted,
} from "../mode-colors.ts";
import {
	dispatch_gradient_tick,
	shutdown_gradient_clock,
	set_gradient_colorizer,
} from "../gradient.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme(): { fg: (t: string, s: string) => string; bold: (s: string) => string } {
	return { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
}

function makeContext(
	id: string,
	state: Record<string, unknown>,
): {
	args: Record<string, never>;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
} {
	return { args: {}, toolCallId: id, invalidate: () => {}, state };
}

// ---------------------------------------------------------------------------
// Simulated Pi event bus with pi-compact-tools handlers FIRST (registration
// order in plugins/index.ts), then pi-ember-ui handlers.
// ---------------------------------------------------------------------------

type SimEvents = {
	agent_end(): void;
	agent_settled(): void;
	message_start_user(): void;
	message_update(type: string, delta?: string): void;
	tool_call(name: string, id: string): void;
	tool_execution_start(id: string): void;
	tool_execution_end(id: string): void;
	before_agent_start(): void;
};

function makeSim(renderer: ReturnType<typeof getSharedRenderer>): SimEvents {
	// --- pi-compact-tools handlers (registered first) ---
	const compact = {
		agent_end(): void {
			renderer.settleAllGroups();
			sync_compact_group_flags(renderer);
		},
		agent_settled(): void {
			renderer.clearGroupThinkingChild();
			renderer.resyncGroupGradientTick();
			sync_compact_group_flags(renderer);
		},
		message_start_user(): void {
			renderer.noteUserMessage();
			sync_compact_group_flags(renderer);
		},
		tool_call(name: string, id: string): void {
			renderer.announceToolCall();
			renderer.registerCall(name, id, { command: "git diff" });
			sync_compact_group_flags(renderer);
		},
		tool_execution_end(): void {
			sync_compact_group_flags(renderer);
		},
	};

	// --- pi-ember-ui handlers (registered second) ---
	const ui = {
		message_start_user(): void {
			reset_thinking_pass_timer_sim();
			setTurnToolTranscriptActive(false);
			setUserTurnAnchorTimestamp(Date.now());
			setUserTurnCommitted(true);
			arm_pre_token_thinking_status();
		},
		before_agent_start(): void {
			if (!isUserTurnCommitted()) setUserTurnCommitted(true);
			arm_pre_token_thinking_status();
		},
		agent_end(): void {
			// stopThinkingAnimation equivalent
			arm_pre_token_thinking_status();
		},
		agent_settled(): void {
			setAgentRunPending(false);
			setUserTurnCommitted(false);
			setTurnToolTranscriptActive(false);
			resetToolExecutionInFlight();
		},
		message_update(type: string, delta?: string): void {
			if (type === "toolcall_start") {
				markToolCallAnnounced("call-x");
				setTurnToolTranscriptActive(true);
				suppress_thinking_header_for_work();
				renderer.announceToolCall();
				sync_compact_group_flags(renderer);
				return;
			}
			if (type === "thinking_delta") {
				arm_thinking_stream_status();
				renderer.noteHiddenThinking();
				sync_compact_group_flags(renderer);
				return;
			}
			if (type === "text_delta" && delta?.trim()) {
				suppress_thinking_header_for_work();
				renderer.noteVisibleText();
				sync_compact_group_flags(renderer);
			}
		},
		tool_call(): void {
			setTurnToolTranscriptActive(true);
			suppress_thinking_header_for_work();
		},
		tool_execution_start(id: string): void {
			markToolExecutionStarted(id);
			suppress_thinking_header_for_work();
			setTurnToolTranscriptActive(true);
		},
		tool_execution_end(id: string): void {
			markToolExecutionEnded(id);
			arm_pre_token_thinking_status();
		},
	};

	return {
		agent_end(): void {
			compact.agent_end();
			ui.agent_end();
		},
		agent_settled(): void {
			compact.agent_settled();
			ui.agent_settled();
		},
		message_start_user(): void {
			compact.message_start_user();
			ui.message_start_user();
		},
		message_update(type: string, delta?: string): void {
			ui.message_update(type, delta);
		},
		tool_call(name: string, id: string): void {
			compact.tool_call(name, id);
			ui.tool_call();
		},
		tool_execution_start(id: string): void {
			ui.tool_execution_start(id);
		},
		tool_execution_end(id: string): void {
			compact.tool_execution_end();
			ui.tool_execution_end(id);
		},
		before_agent_start(): void {
			ui.before_agent_start();
		},
	};
}

function reset_thinking_pass_timer_sim(): void {
	// no-op in sim
}

afterEach(() => {
	shutdown_gradient_clock();
	resetToolExecutionInFlight();
	setAgentRunPending(false);
	setTurnToolTranscriptActive(false);
	setUserTurnCommitted(false);
	setThinkingBlocksHidden(false);
	getSharedRenderer().resetForSession();
});

describe("full event sequence: duplicate Thinking hunt", () => {
	test("15 bash + inter-run gap + thinking stream: no external host while lane painted", () => {
		setThinkingBlocksHidden(true);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const sim = makeSim(renderer);
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("t1", owner_state) as any;

		sim.message_start_user();
		sim.before_agent_start();

		for (let i = 1; i <= 15; i++) {
			const id = `t${i}`;
			const ctx = makeContext(id, i === 1 ? owner_state : {}) as any;
			sim.message_update("toolcall_start");
			sim.tool_call("bash", id);
			sim.tool_execution_start(id);
			renderer.renderCall("bash", { command: "git diff" }, theme, ctx);
			renderer.renderResult(
				"bash",
				{ command: "git diff" },
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...ctx, isError: false },
			);
			sim.tool_execution_end(id);
		}

		// agent_end (inter-run gap): no thinking stream yet — the settled group
		// HOLDS the tool lane (gradient `-ing` verb) instead of painting a
		// premature `└ Thinking` lane.
		sim.agent_end();
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row.includes("Thinking")).toBe(false);
		expect(renderer.hasAnyGroupThinkingChild()).toBe(false);
		expect(isGroupThinkingChildActive()).toBe(false);
		expect(thinking_status_should_show()).toBe(false);
		expect(resolve_thinking_status_host()).toBe(null);

		// A hidden thinking stream arms the lane as the ONE surface
		sim.message_update("thinking_delta");
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);
		expect(resolve_thinking_status_host()).toBe(null);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");

		// Gradient ticks never open the external host
		for (let i = 0; i < 20; i++) dispatch_gradient_tick();
		expect(resolve_thinking_status_host()).toBe(null);
	});

	test("auto-continue window: agent_settled then re-arm; no duplicate", () => {
		setThinkingBlocksHidden(true);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const sim = makeSim(renderer);
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("a1", owner_state) as any;

		sim.message_start_user();
		sim.before_agent_start();
		for (let i = 1; i <= 3; i++) {
			const id = `a${i}`;
			const ctx = makeContext(id, i === 1 ? owner_state : {}) as any;
			sim.message_update("toolcall_start");
			sim.tool_call("bash", id);
			sim.tool_execution_start(id);
			renderer.renderCall("bash", { command: "x" }, theme, ctx);
			renderer.renderResult(
				"bash",
				{ command: "x" },
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...ctx, isError: false },
			);
			sim.tool_execution_end(id);
		}
		sim.agent_settled();
		// Auto-continue re-arms before the next agent_start
		sim.before_agent_start();
		// No thinking stream yet: the group HOLDS the tool lane; the external
		// host must still stay hidden (hasReopenableGroup owns the slot).
		expect(renderer.hasAnyGroupThinkingChild()).toBe(false);
		expect(resolve_thinking_status_host()).toBe(null);
		// A real thinking stream arms the lane — still the ONE surface.
		sim.message_update("thinking_delta");
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);
		expect(resolve_thinking_status_host()).toBe(null);
	});

	test("lane group survives renderer rebuild (registerCall rebind) and stays the ONE surface", () => {
		setThinkingBlocksHidden(true);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("r1", owner_state) as any;
		const child_ctx = makeContext("r2", {}) as any;

		renderer.renderCall("bash", { command: "git diff" }, theme, owner_ctx);
		renderer.renderCall("bash", { command: "git log" }, theme, child_ctx);
		renderer.renderResult(
			"bash",
			{ command: "git diff" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		renderer.renderResult(
			"bash",
			{ command: "git log" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		renderer.settleAllGroups();
		renderer.armInGroupThinking();
		sync_compact_group_flags(renderer);
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);
		expect(resolve_thinking_status_host()).toBe(null);

		// Pi rebuild: registerCall with existing ids rebinds invalidate
		renderer.registerCall("bash", "r1", { command: "git diff" }, () => {});
		renderer.registerCall("bash", "r2", { command: "git log" }, () => {});
		renderer.settleAllGroups();
		sync_compact_group_flags(renderer);
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);
		expect(resolve_thinking_status_host()).toBe(null);
		// Lane row still painted
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Thinking");
	});

	test("stale synced flag (jiti module duplication) can never open the external host beside a painted lane", () => {
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(false);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("s1", owner_state) as any;
		const child_ctx = makeContext("s2", {}) as any;

		renderer.renderCall("bash", { command: "git diff" }, theme, owner_ctx);
		renderer.renderCall("bash", { command: "git log" }, theme, child_ctx);
		renderer.renderResult(
			"bash",
			{ command: "git diff" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		renderer.renderResult(
			"bash",
			{ command: "git log" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		renderer.settleAllGroups();
		renderer.armInGroupThinking();
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);
		// Simulate the reader-side module instance seeing the flag as false
		// (module-level `let` desync) while the renderer really paints the lane.
		setGroupThinkingChildActive(false);
		setToolGroupActive(false);
		setGroupReopenableActive(false);
		// The LIVE renderer O(1) counter is authoritative: the external hosts
		// must stay suppressed no matter how stale the synced flags are.
		expect(compact_thinking_lane_owns_status()).toBe(true);
		expect(thinking_status_should_show()).toBe(false);
		expect(resolve_thinking_status_host()).toBe(null);
	});

	test("gradient tick output equals full formatGroup output (static-prefix cache is faithful)", () => {
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("c1", owner_state) as any;

		for (let i = 1; i <= 15; i++) {
			const ctx = makeContext(`c${i}`, i === 1 ? owner_state : {}) as any;
			renderer.renderCall("bash", { command: `git diff -- f${i}.py` }, theme, ctx);
			renderer.renderResult(
				"bash",
				{ command: `git diff -- f${i}.py` },
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...ctx, isError: false },
			);
		}
		renderer.settleAllGroups();
		renderer.armInGroupThinking();

		// Force the tick path: subscribe the group tick and run one dispatch.
		renderer.resyncGroupGradientTick();
		dispatch_gradient_tick();

		// The tick wrote through the static-prefix cache; the row must still be
		// byte-identical to a full formatGroup rebuild (cache is faithful).
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Ran 15 commands");
		expect(row).toContain("Thinking");
		expect(row.split("\n")).toHaveLength(17); // header + 15 children + lane
	});
});
