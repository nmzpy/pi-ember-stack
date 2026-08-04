import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	clear_stale_thinking_wait_blockers,
	compact_thinking_lane_owns_status,
	is_in_message_thinking_status_target,
	lingering_tool_children_visible_for_tests,
	render_thinking_status_lines_for_tests,
	reset_thinking_header_state_for_tests,
	resolve_thinking_status_host,
	set_thinking_status_host_fixtures_for_tests,
	should_suppress_thinking_header_for_stream_event,
	suppress_thinking_header_for_work,
	thinking_status_should_show,
} from "../index.ts";
import { set_gradient_colorizer, reset_gradient_colorizer } from "../gradient.ts";

function forcedColorizer(rgb: [number, number, number], text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}
import {
	bind_thinking_status_tick_host_resolver,
	bind_thinking_status_tick_should_paint,
	bind_thinking_widget_host,
	sync_thinking_status_tick,
	unbind_thinking_status_hosts,
} from "../thinking-status-tick.ts";
import {
	dispatch_gradient_tick,
	gradient_clock_is_idle,
	gradient_reason_active,
	set_gradient_render_request,
	shutdown_gradient_clock,
	stop_all_gradient_animation,
} from "../gradient.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import {
	isCurrentTurnAssistantTimestamp,
	isInterRunGap,
	isLatestSubagentRunning,
	is_agent_thinking_wait,
	markSubagentDelegationEnded,
	markSubagentDelegationStarted,
	resetSubagentDelegation,
	setAgentRunPending,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	isGroupThinkingChildActive,
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
	setToolGroupActive,
	setTurnToolTranscriptActive,
	setUserTurnAnchorTimestamp,
	setUserTurnCommitted,
	resetToolExecutionInFlight,
	markToolExecutionStarted,
	markToolExecutionEnded,
	setLatestSubagentRunning,
} from "../mode-colors.ts";
import {
	is_planning_style_text_delta,
	bind_thinking_wait_handlers,
	reconcile_thinking_wait_ui,
} from "../thinking-wait.ts";

function stripAnsi(s: string): string {
	return s.replace(/\[[0-9;]*m/g, "");
}

function makeContext(id: string, state: Record<string, any> = {}) {
	return { args: {}, toolCallId: id, invalidate: () => {}, state };
}


function bind_thinking_reconcile_handlers(): void {
	bind_thinking_wait_handlers({
		armPreTokenThinkingStatus: arm_pre_token_thinking_status,
		refreshThinkingStatus: () => {},
		getThinkingActive: () => false,
		clearStaleBlockers: clear_stale_thinking_wait_blockers,
	});
}

afterEach(() => {
	unbind_thinking_status_hosts();
	shutdown_gradient_clock();
});

describe("is_agent_thinking_wait", () => {
	test("requires user turn committed when agent is idle", () => {
		setUserTurnCommitted(false);
		setAgentRunPending(false);
		expect(is_agent_thinking_wait()).toBe(false);
		setUserTurnCommitted(true);
		setAgentRunPending(true);
		expect(is_agent_thinking_wait()).toBe(true);
		setUserTurnCommitted(false);
		setAgentRunPending(false);
	});

	test("allows agentRunPending without userTurnCommitted (compact-and-continue)", () => {
		setUserTurnCommitted(false);
		setAgentRunPending(true);
		resetToolExecutionInFlight();
		try {
			expect(is_agent_thinking_wait()).toBe(true);
		} finally {
			setAgentRunPending(false);
		}
	});
});

describe("is_planning_style_text_delta", () => {
	test("detects markdown headings and labeled lines", () => {
		expect(is_planning_style_text_delta("## Investigation")).toBe(true);
		expect(is_planning_style_text_delta("Task: verify auth")).toBe(true);
		expect(is_planning_style_text_delta("final answer text")).toBe(false);
	});
});

describe("thinking header visibility", () => {
	beforeEach(() => {
		reset_thinking_header_state_for_tests();
		getSharedRenderer().resetForSession();
	});

	test("shows when thinking blocks are hidden and a settled group is only reopenable", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			setGroupReopenableActive(true);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			setGroupReopenableActive(false);
			setUserTurnCommitted(false);
			setAgentRunPending(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("shows during pre-tool gap when thinking blocks are visible", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setAgentRunPending(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hides when thinking blocks are visible and tools are already on screen", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
		} finally {
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setAgentRunPending(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hides external header while model streams thinking when blocks are visible", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		set_thinking_status_host_fixtures_for_tests({ assistantThinkingHostReady: true });
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_thinking_stream_status();
			expect(thinking_status_should_show()).toBe(false);
		} finally {
			set_thinking_status_host_fixtures_for_tests({ assistantThinkingHostReady: false });
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("text_start during pre-tool gap does not suppress the header", () => {
		setTurnToolTranscriptActive(false);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		try {
			expect(
				should_suppress_thinking_header_for_stream_event({ type: "text_start" }),
			).toBe(false);
			arm_pre_token_thinking_status();
			suppress_thinking_header_for_work();
			expect(thinking_status_should_show()).toBe(false);
			expect(
				should_suppress_thinking_header_for_stream_event({ type: "text_start" }),
			).toBe(false);
		} finally {
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
		}
	});

	test("hides external host when a running tool group is active", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = { fg: (tag: string, text: string) => `[${tag}:${text}]`, bold: (s: string) => `*${s}*` };
		const owner_ctx = { args: {}, toolCallId: "running-owner", invalidate: () => {}, state: {} as Record<string, unknown> };
		const child_ctx = { args: {}, toolCallId: "running-child", invalidate: () => {}, state: {} as Record<string, unknown> };
		try {
			renderer.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
			renderer.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
			expect(renderer.hasActiveGroups()).toBe(true);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
		} finally {
			renderer.resetForSession();
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setAgentRunPending(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("shows during inter-run gap even when reopenable group flag is set", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			setGroupReopenableActive(true);
			arm_pre_token_thinking_status();
			expect(isInterRunGap()).toBe(true);
			if (!isInterRunGap()) suppress_thinking_header_for_work();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			setGroupReopenableActive(false);
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hides while delegated subagents are active and restores after the last one", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		try {
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			markToolExecutionStarted("call-scout-a");
			expect(thinking_status_should_show()).toBe(false);
			markToolExecutionEnded("call-scout-a");
			markSubagentDelegationStarted("call-scout-a");
			markSubagentDelegationStarted("call-scout-b");
			expect(thinking_status_should_show()).toBe(false);
			// The branch can lag concurrent lifecycle events. Clearing stale
			// blockers must preserve the active delegation ids and keep the
			// external Thinking header hidden alongside the Subagents block.
			clear_stale_thinking_wait_blockers();
			expect(thinking_status_should_show()).toBe(false);
			markSubagentDelegationEnded("call-scout-a");
			expect(thinking_status_should_show()).toBe(false);
			markSubagentDelegationEnded("call-scout-b");
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			resetSubagentDelegation();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("shows after last subagent finishes while agent run is still pending", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		suppress_thinking_header_for_work();
		markSubagentDelegationStarted("call-finished");
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			markSubagentDelegationEnded("call-finished");
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			resetSubagentDelegation();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("user send shows Thinking via arm before agent_start", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("pre-tool gap uses widget host before assistant bubble exists", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});
	test("widget host renders the label at the in-message row (blank below, no pad above)", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		set_gradient_colorizer(forcedColorizer);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
			const lines = render_thinking_status_lines_for_tests(80);
			// Pi's widget container supplies the leading blank; the widget adds
			// the trailing blank (padBelow) so the label occupies the exact row
			// the in-message host will use — no 1-row jump on assistant mount.
			expect(lines.length).toBe(2);
			const stripped = (lines[0] ?? "").replace(/\[[0-9;]*m/g, "");
			expect(stripped).toContain("Thinking");
			expect(lines[1]).toBe("");
		} finally {
			reset_gradient_colorizer();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("gradient tick schedules render through thinking host invalidate", () => {
		const render_calls: number[] = [];
		const mock_tui = { requestRender: () => render_calls.push(1) };
		set_gradient_render_request(() => mock_tui.requestRender());
		bind_thinking_status_tick_host_resolver(() => "widget");
		bind_thinking_status_tick_should_paint(() => thinking_status_should_show() || isGroupThinkingChildActive());
		bind_thinking_widget_host({ invalidate: () => mock_tui.requestRender() });
		setUserTurnCommitted(true);
		setAgentRunPending(true);
		arm_pre_token_thinking_status();
		try {
			expect(thinking_status_should_show()).toBe(true);
			dispatch_gradient_tick();
			expect(render_calls.length).toBe(1);
		} finally {
			unbind_thinking_status_hosts();
			set_gradient_render_request(undefined);
			setAgentRunPending(false);
			setUserTurnCommitted(false);
		}
	});

	test("isCurrentTurnAssistantTimestamp excludes pre-turn assistants", () => {
		setUserTurnAnchorTimestamp(200);
		try {
			expect(isCurrentTurnAssistantTimestamp(100)).toBe(false);
			expect(isCurrentTurnAssistantTimestamp(200)).toBe(true);
			expect(isCurrentTurnAssistantTimestamp(250)).toBe(true);
			expect(isCurrentTurnAssistantTimestamp(undefined)).toBe(false);
		} finally {
			setUserTurnAnchorTimestamp(undefined);
		}
	});

	test("isCurrentTurnAssistantTimestamp is false for historical assistants when idle", () => {
		setUserTurnCommitted(false);
		setAgentRunPending(false);
		setUserTurnAnchorTimestamp(undefined);
		try {
			expect(isCurrentTurnAssistantTimestamp(100)).toBe(false);
			expect(isCurrentTurnAssistantTimestamp(999)).toBe(false);
		} finally {
			setUserTurnCommitted(false);
			setAgentRunPending(false);
		}
	});

	test("user send after session idle arms widget Thinking via reconcile SSOT", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		reset_thinking_header_state_for_tests();
		bind_thinking_reconcile_handlers();
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			setUserTurnCommitted(true);
			reconcile_thinking_wait_ui({ force_arm: true, clear_blockers: true });
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			reset_thinking_header_state_for_tests();
			setTurnToolTranscriptActive(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("pre-tool thinking stream keeps widget host when assistant bubble exists", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			arm_thinking_stream_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("pre-tool thinking stream ignores stale in-group flag", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(true);
			arm_pre_token_thinking_status();
			arm_thinking_stream_status();
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setGroupThinkingChildActive(false);
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("post-tool in-group lane suppresses external host when tools are on screen", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = { fg: (tag: string, text: string) => `[${tag}:${text}]`, bold: (s: string) => `*${s}*` };
		const owner_ctx = { args: {}, toolCallId: "lane-owner", invalidate: () => {}, state: {} as Record<string, unknown> };
		const child_ctx = { args: {}, toolCallId: "lane-child", invalidate: () => {}, state: {} as Record<string, unknown> };
		try {
			renderer.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
			renderer.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
			renderer.renderResult(
				"read",
				{ path: "a.ts" },
				{ content: [{ type: "text", text: "a" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			renderer.renderResult(
				"grep",
				{ pattern: "x", path: "b.ts" },
				{ content: [{ type: "text", text: "b" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...child_ctx, isError: false },
			);
			renderer.noteThinking();
			expect(renderer.hasGroupThinkingChild()).toBe(true);
			expect(compact_thinking_lane_owns_status()).toBe(true);
			arm_thinking_stream_status();
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
		} finally {
			renderer.resetForSession();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("post-tool hidden blocks fall back to external host when in-group lane is not painted", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		try {
			setGroupThinkingChildActive(false);
			arm_thinking_stream_status();
			expect(renderer.hasGroupThinkingChild()).toBe(false);
			expect(compact_thinking_lane_owns_status()).toBe(false);
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			renderer.resetForSession();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("post-tool hidden blocks show external Thinking during inter-run wait", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		try {
			suppress_thinking_header_for_work();
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			renderer.resetForSession();
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("inter-run gap keeps tool children until real thinking stream", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
		const owner_ctx = {
			args: {},
			toolCallId: "ir-owner",
			invalidate: () => {},
			state: {} as Record<string, unknown>,
		};
		const child_ctx = {
			args: {},
			toolCallId: "ir-child",
			invalidate: () => {},
			state: {},
		};
		try {
			renderer.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
			renderer.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
			renderer.renderResult(
				"read",
				{ path: "a.ts" },
				{ content: [{ type: "text", text: "a" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			renderer.renderResult(
				"grep",
				{ pattern: "x", path: "b.ts" },
				{ content: [{ type: "text", text: "b" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...child_ctx, isError: false },
			);
			expect(isInterRunGap()).toBe(true);
			expect(renderer.hasVisibleGroupChildren()).toBe(true);
			expect(renderer.hasGroupThinkingChild()).toBe(false);
			arm_pre_token_thinking_status();
			expect(lingering_tool_children_visible_for_tests()).toBe(true);
			expect(thinking_status_should_show()).toBe(false);
			renderer.noteThinking();
			setGroupThinkingChildActive(renderer.hasGroupThinkingChild());
			expect(renderer.hasGroupThinkingChild()).toBe(true);
			// Thinking never folds prior tool children — they linger beside the
			// in-group `└ Thinking` lane.
			expect(renderer.hasVisibleGroupChildren()).toBe(true);
			expect(compact_thinking_lane_owns_status()).toBe(true);
		} finally {
			renderer.resetForSession();
			setGroupThinkingChildActive(false);
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("inter-run planning text arms in-group Thinking so external header stays hidden", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
		const owner_ctx = {
			args: {},
			toolCallId: "plan-owner",
			invalidate: () => {},
			state: {} as Record<string, unknown>,
		};
		const child_ctx = {
			args: {},
			toolCallId: "plan-child",
			invalidate: () => {},
			state: {},
		};
		try {
			renderer.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
			renderer.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
			renderer.renderResult(
				"read",
				{ path: "a.ts" },
				{ content: [{ type: "text", text: "a" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			renderer.renderResult(
				"grep",
				{ pattern: "x", path: "b.ts" },
				{ content: [{ type: "text", text: "b" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...child_ctx, isError: false },
			);
			expect(isInterRunGap()).toBe(true);
			expect(renderer.hasVisibleGroupChildren()).toBe(true);
			// Pre-token arm requests a fold for the next real thinking stream.
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
			// Planning text arrives: arm the in-group lane without folding.
			renderer.armInGroupThinkingForPlanning();
			setGroupThinkingChildActive(renderer.hasGroupThinkingChild());
			expect(renderer.hasGroupThinkingChild()).toBe(true);
			// Children linger (soft boundary — no fold).
			expect(renderer.hasVisibleGroupChildren()).toBe(true);
			expect(compact_thinking_lane_owns_status()).toBe(true);
			// External Thinking header must not duplicate the in-group lane.
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
		} finally {
			renderer.resetForSession();
			setGroupThinkingChildActive(false);
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("compact-and-continue arms Thinking with agentRunPending only", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(false);
		setAgentRunPending(true);
		resetToolExecutionInFlight();
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(is_agent_thinking_wait()).toBe(true);
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("post-tool wait arms Thinking inside a settled work group", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
		const owner_state: Record<string, any> = {};
		const owner_ctx = {
			args: {},
			toolCallId: "settled-owner",
			invalidate: () => {},
			state: owner_state,
		};
		try {
			renderer.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
			renderer.renderResult(
				"bash",
				{ command: "npm test" },
				{ content: [{ type: "text", text: "ok" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			renderer.settleAllGroups();
			arm_pre_token_thinking_status();
			expect(renderer.hasGroupThinkingChild()).toBe(true);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			const row = owner_state.callText?.text?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
			expect(row).toContain("Thinking");
			expect(row).toContain("npm test");
		} finally {
			renderer.resetForSession();
			setGroupThinkingChildActive(false);
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			resetToolExecutionInFlight();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("in-message Thinking attaches only to the latest current-turn assistant", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(true);
		resetToolExecutionInFlight();
		setUserTurnAnchorTimestamp(100);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: 250,
				assistantThinkingHostReady: true,
			});
			arm_pre_token_thinking_status();
			expect(resolve_thinking_status_host()).toBe("in_message");
			expect(is_in_message_thinking_status_target(100)).toBe(false);
			expect(is_in_message_thinking_status_target(200)).toBe(false);
			expect(is_in_message_thinking_status_target(250)).toBe(true);
		} finally {
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: undefined,
				assistantThinkingHostReady: false,
			});
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});
});

describe("reconcile_thinking_wait_ui", () => {
	beforeEach(() => {
		reset_thinking_header_state_for_tests();
		bind_thinking_reconcile_handlers();
	});

	test("clears stale toolExecutionInFlight and arms Thinking", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		markToolExecutionStarted();
		try {
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
			reconcile_thinking_wait_ui({ clear_blockers: true, force_arm: true });
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			reset_thinking_header_state_for_tests();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("post-compaction reconcile clears blockers on active turn", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		setAgentRunPending(true);
		markToolExecutionStarted();
		setLatestSubagentRunning(true);
		try {
			expect(thinking_status_should_show()).toBe(false);
			reconcile_thinking_wait_ui({ clear_blockers: true, force_arm: true });
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			reset_thinking_header_state_for_tests();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("compact-and-continue force_arm after rebuild with agentRunPending only", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(false);
		setAgentRunPending(true);
		markToolExecutionStarted();
		try {
			reconcile_thinking_wait_ui({ clear_blockers: true, force_arm: true });
			expect(is_agent_thinking_wait()).toBe(true);
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("widget");
		} finally {
			reset_thinking_header_state_for_tests();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("in-message Thinking adds one leading blank row and gradient label", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(false);
		resetToolExecutionInFlight();
		setUserTurnAnchorTimestamp(100);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		set_gradient_colorizer(forcedColorizer);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: 250,
				assistantThinkingHostReady: true,
			});
			arm_pre_token_thinking_status();
			expect(resolve_thinking_status_host()).toBe("in_message");
			const lines = render_thinking_status_lines_for_tests(80);
			expect(lines.length).toBeGreaterThanOrEqual(2);
			expect(lines[0]).toBe("");
			const stripped = lines[1]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
			expect(stripped).toContain("Thinking");
			expect(lines[1]).toMatch(/\x1b\[/);
		} finally {
			reset_gradient_colorizer();
			renderer.resetForSession();
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: undefined,
				assistantThinkingHostReady: false,
			});
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("render_thinking_status_lines activates gradient clock when stopped (safety net)", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(false);
		resetToolExecutionInFlight();
		setUserTurnAnchorTimestamp(100);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		set_gradient_colorizer(forcedColorizer);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: 250,
				assistantThinkingHostReady: true,
			});
			arm_pre_token_thinking_status();
			expect(resolve_thinking_status_host()).toBe("in_message");
			// Stop the gradient clock to simulate a race where the clock was
			// deactivated but the host still resolves on the next render.
			stop_all_gradient_animation();
			sync_thinking_status_tick(false);
			expect(gradient_clock_is_idle()).toBe(true);
			const lines = render_thinking_status_lines_for_tests(80);
			expect(lines.length).toBeGreaterThanOrEqual(2);
			// Safety net should have reactivated the gradient clock.
			expect(gradient_reason_active("thinking")).toBe(true);
		} finally {
			reset_gradient_colorizer();
			stop_all_gradient_animation();
			sync_thinking_status_tick(false);
			renderer.resetForSession();
			set_thinking_status_host_fixtures_for_tests({
				latestAssistantMessageTimestamp: undefined,
				assistantThinkingHostReady: false,
			});
			setAgentRunPending(false);
			setTurnToolTranscriptActive(false);
			setUserTurnCommitted(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("clear_stale_thinking_wait_blockers drops the stale editor-border flag", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		setLatestSubagentRunning(true);
		try {
			clear_stale_thinking_wait_blockers();
			expect(isLatestSubagentRunning()).toBe(false);
		} finally {
			reset_thinking_header_state_for_tests();
			setThinkingBlocksHidden(prev_hidden);
		}
	});



	test("hidden assistant text_delta does not hard-exit compact work group", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hidden-delta-owner", owner_state) as any;
		const child_state: Record<string, any> = {};
		const child_ctx = makeContext("hidden-delta-child", child_state) as any;
		const theme = { fg: (tag: string, text: string) => `[${tag}:${text}]`, bold: (s: string) => `*${s}*` } as any;
		try {
			renderer.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
			renderer.renderResult(
				"read",
				{ path: "a.ts" },
				{ content: [{ type: "text", text: "a" }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			renderer.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
			renderer.renderResult(
				"grep",
				{ pattern: "x", path: "b.ts" },
				{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
				{ expanded: false, isPartial: false },
				theme,
				{ ...child_ctx, isError: false },
			);
			renderer.settleAllGroups();
			const before = stripAnsi((owner_state.callText as any)?.text ?? "");
			expect(before).toContain("Explored 1 file");
			expect(before).toContain("1 search");
			// Simulate a hidden assistant text hard-exit: should fold.
			renderer.noteVisibleText();
			renderer.settleAllGroups();
			const after = stripAnsi((owner_state.callText as any)?.text ?? "");
			expect(after).toContain("Explored 1 file");
			expect(after).toContain("1 search");
		} finally {
			renderer.resetForSession();
			setThinkingBlocksHidden(prev_hidden);
		}
	});

});
