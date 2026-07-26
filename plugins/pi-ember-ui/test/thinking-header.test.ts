import { beforeEach, describe, expect, test } from "bun:test";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	compact_thinking_lane_owns_status,
	is_in_message_thinking_status_target,
	lingering_tool_children_visible_for_tests,
	reset_thinking_header_state_for_tests,
	resolve_thinking_status_host,
	set_thinking_status_host_fixtures_for_tests,
	should_suppress_thinking_header_for_stream_event,
	suppress_thinking_header_for_work,
	thinking_status_should_show,
} from "../index.ts";
import {
	activate_gradient,
	deactivate_gradient,
	dispatch_gradient_tick,
	set_gradient_render_request,
} from "../gradient.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import {
	isCurrentTurnAssistantTimestamp,
	isInterRunGap,
	is_agent_thinking_wait,
	markSubagentActivityEnded,
	markSubagentActivityStarted,
	noteSubagentDelegating,
	resetSubagentActivity,
	resetSubagentDelegating,
	clearSubagentDelegating,
	setAgentRunPending,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
	setToolGroupActive,
	setTurnToolTranscriptActive,
	setUserTurnAnchorTimestamp,
	setUserTurnCommitted,
	resetToolExecutionInFlight,
} from "../mode-colors.ts";
import { is_planning_style_text_delta } from "../thinking-wait.ts";

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

	test("shows during pre-tool gap even when thinking blocks are visible", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		setTurnToolTranscriptActive(false);
		setUserTurnCommitted(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
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

	test("stays visible while model streams thinking even with blocks visible post-tool", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		setTurnToolTranscriptActive(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			arm_thinking_stream_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
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

	test("hides while subagent Delegating is visible (streaming before tool_call)", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setTurnToolTranscriptActive(true);
		setUserTurnCommitted(true);
		resetToolExecutionInFlight();
		try {
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
			noteSubagentDelegating("call-delegating");
			expect(thinking_status_should_show()).toBe(false);
			clearSubagentDelegating("call-delegating");
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			resetSubagentDelegating();
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
		markSubagentActivityStarted();
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			markSubagentActivityEnded();
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			resetSubagentActivity();
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

	test("gradient tick schedules render through the live TUI requestRender", () => {
		const render_calls: number[] = [];
		const mock_tui = { requestRender: () => render_calls.push(1) };
		set_gradient_render_request(() => mock_tui.requestRender());
		setUserTurnCommitted(true);
		setAgentRunPending(true);
		arm_pre_token_thinking_status();
		activate_gradient("thinking");
		try {
			expect(thinking_status_should_show()).toBe(true);
			dispatch_gradient_tick();
			expect(render_calls.length).toBe(1);
		} finally {
			deactivate_gradient("thinking");
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
			expect(renderer.hasVisibleGroupChildren()).toBe(false);
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
