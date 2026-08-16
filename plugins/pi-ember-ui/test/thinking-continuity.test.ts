import { afterEach, describe, expect, test } from "bun:test";
import piEmberUiPlugin, {
	clear_thinking_pass_timer,
	format_thinking_pass_elapsed_suffix,
	is_thinking_pass_timer_armed,
	reset_thinking_header_state_for_tests,
	resolve_thinking_status_host,
	set_thinking_pass_started_at_for_tests,
	thinking_status_should_show,
} from "../index.ts";
import piCompactToolsPlugin from "../../pi-compact-tools/index.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import { sync_compact_group_flags } from "../../pi-compact-tools/group-flags.ts";
import {
	isGroupThinkingChildActive,
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
} from "../mode-colors.ts";
import { gradient_clock_is_idle, shutdown_gradient_clock } from "../gradient.ts";

/**
 * Deterministic event-order tests for hidden-Thinking continuity. They drive
 * the REAL pi-ember-ui lifecycle handlers through a fake pi bus (in the same
 * registration order as plugins/index.ts: pi-compact-tools first, then
 * pi-ember-ui), so the message_update order is exactly the production path:
 * apply_assistant_stream_boundary -> sync flags -> resume/arm stream ->
 * reconcile wait -> suppression check -> refresh.
 */

type Handler = (event: any, ctx: any) => any;

function makeUi(): Record<string, unknown> {
	const widgets: Record<string, unknown> = {};
	const base: Record<string, unknown> = {
		widgets,
		mode: "tui",
		setWidget(name: string, factory?: (tui: unknown, theme: unknown) => unknown): void {
			if (factory) widgets[name] = factory({ requestRender() {}, invalidate() {} }, { fg: () => "" });
			else delete widgets[name];
		},
		setHeader() {},
		setFooter() {},
		setWorkingVisible() {},
		setHiddenThinkingLabel() {},
		setStatus() {},
		addInputListener() {
			return () => {};
		},
		onTerminalInput() {
			return () => {};
		},
		notify() {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => "",
		editor: async () => "",
		custom: () => ({}),
		requestRender() {},
	};
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => undefined;
		},
	});
}

function makeCtx(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: makeUi(),
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "sess",
			getCwd: () => process.cwd(),
			getEntries: () => [],
			getBranch: () => [],
		},
		model: { id: "test-model", name: "Test Model" },
		modelRegistry: { getAvailable: () => [] },
		isIdle: () => false,
		getContextUsage: () => undefined,
		...extra,
	};
}

function installPlugins(): { handlers: Record<string, Handler[]> } {
	const handlers: Record<string, Handler[]> = {};
	const events: Record<string, Handler[]> = {};
	const pi = {
		on(name: string, h: Handler) {
			(handlers[name] ??= []).push(h);
		},
		events: {
			on(name: string, h: Handler) {
				(events[name] ??= []).push(h);
			},
		},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		registerTool() {},
		sendMessage() {},
		setActiveTools() {},
		setModel() {},
		setThinkingLevel() {},
	};
	piCompactToolsPlugin(pi as never, { excludeTools: [] });
	piEmberUiPlugin(pi as never);
	return { handlers };
}

function fire(handlers: Record<string, Handler[]>, name: string, event: any, ctx: any): void {
	for (const h of handlers[name] ?? []) h(event, ctx);
}

/** Drive the shared compact renderer's tool row for group scenarios. */
function renderToolRow(toolName: string, toolCallId: string, state: Record<string, unknown>): void {
	const renderer = getSharedRenderer();
	const theme = {
		fg: (tag: string, text: string) => `[${tag}:${text}]`,
		bold: (s: string) => s,
	} as never;
	const ctx = { args: {}, toolCallId, invalidate: () => {}, state };
	renderer.renderCall(toolName, { path: "a.ts", command: "git diff" }, theme, ctx as never);
	renderer.renderResult(
		toolName,
		{ path: "a.ts", command: "git diff" },
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: false } as never,
	);
}

function makeTheme() {
	return { fg: (tag: string, text: string) => `[${tag}:${text}]` };
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const SEND_TIME = 5_000_000;

afterEach(() => {
	shutdown_gradient_clock();
	getSharedRenderer().resetForSession();
	setThinkingBlocksHidden(false);
	reset_thinking_header_state_for_tests();
});

describe("hidden Thinking continuity (real handler event order)", () => {
	test("existing startup transcripts keep the top logo static", () => {
		const { handlers } = installPlugins();
		const base_ctx = makeCtx();
		const ctx = makeCtx({
			sessionManager: {
				...base_ctx.sessionManager,
				getEntries: () => [{ type: "user", id: "old" }],
			},
		});

		fire(handlers, "session_start", { reason: "startup" }, ctx);
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("pre-token arm -> hidden thinking_start/deltas keeps status and elapsed start", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);

			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("in_message");

			// The model begins hidden reasoning: status must persist.
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_start" } },
				ctx,
			);
			performance.now = () => SEND_TIME + 2500;
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("in_message");
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 2s]",
			);

			// Repeated deltas must NOT reset the pass timer.
			for (const delta of ["one", "two", "three"]) {
				performance.now = () => SEND_TIME + 2500;
				fire(
					handlers,
					"message_update",
					{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta } },
					ctx,
				);
				expect(thinking_status_should_show()).toBe(true);
				expect(resolve_thinking_status_host()).toBe("in_message");
				expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
					"[dim: 2s]",
				);
			}
			// A fresh pass timer at send + 1s of stream = 3s total, still continuous.
			performance.now = () => SEND_TIME + 3500;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 3s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("no group means the external/in-message host remains the one surface", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			// Before the assistant bubble mounts the widget owns the slot.
			expect(resolve_thinking_status_host()).toBe("widget");
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			expect(resolve_thinking_status_host()).toBe("in_message");

			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			// No compact group exists: no in-group lane, external host stays.
			expect(getSharedRenderer().hasAnyGroupThinkingChild()).toBe(false);
			expect(isGroupThinkingChildActive()).toBe(false);
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).toBe("in_message");
		} finally {
			performance.now = originalNow;
		}
	});

	test("active group yields exactly one group lane and no external duplicate", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			// One tool wave forms a settled work group.
			fire(handlers, "tool_call", { toolName: "bash", toolCallId: "t1" }, ctx);
			fire(handlers, "tool_execution_start", { toolCallId: "t1" }, ctx);
			renderToolRow("bash", "t1", {});
			fire(handlers, "tool_execution_end", { toolCallId: "t1", toolName: "bash" }, ctx);
			fire(handlers, "agent_end", {}, ctx);

			// Hidden reasoning: the group arms the ONE in-group `└ Thinking`
			// lane; the external hosts must not duplicate it.
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			expect(getSharedRenderer().hasAnyGroupThinkingChild()).toBe(true);
			expect(isGroupThinkingChildActive()).toBe(true);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			sync_compact_group_flags(getSharedRenderer());
			expect(resolve_thinking_status_host()).toBe(null);
		} finally {
			performance.now = originalNow;
		}
	});

	test("visible text still clears the header and a later hidden stream starts a fresh pass", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			expect(thinking_status_should_show()).toBe(true);

			// Non-empty answer text is a hard boundary: header clears, timer zeroed.
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "text_delta", delta: "The answer is" } },
				ctx,
			);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe("");

			// A later hidden thinking stream (inter-run) re-shows the header and
			// starts a fresh pass — the text boundary legitimately changed it.
			performance.now = () => SEND_TIME + 10_000;
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "more reasoning" } },
				ctx,
			);
			performance.now = () => SEND_TIME + 10_500;
			expect(thinking_status_should_show()).toBe(true);
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe("");
			performance.now = () => SEND_TIME + 12_500;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 2s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("tool boundary still clears the header; a later hidden stream re-shows it", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			expect(thinking_status_should_show()).toBe(true);

			// Streamed tool call: deterministic work intent hides the header.
			fire(
				handlers,
				"message_update",
				{
					message: { role: "assistant", timestamp: 200 },
					assistantMessageEvent: {
						type: "toolcall_start",
						partial: { content: [{ type: "toolCall", id: "tc1" }] },
						contentIndex: 0,
					},
				},
				ctx,
			);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);

			// The announced call starts and completes: pending/execution state is
			// consumed exactly like the production lifecycle.
			fire(handlers, "tool_execution_start", { toolCallId: "tc1" }, ctx);
			fire(handlers, "tool_execution_end", { toolCallId: "tc1", toolName: "read" }, ctx);
			expect(thinking_status_should_show()).toBe(false);

			// A later hidden thinking stream re-shows the header. The pass timer
			// was NOT cleared by the tool boundary (only visible text / visible
			// thinking / agent_settled are hard boundaries), so the elapsed
			// continues from the original user-send arm.
			performance.now = () => SEND_TIME + 10_000;
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "again" } },
				ctx,
			);
			performance.now = () => SEND_TIME + 12_500;
			expect(thinking_status_should_show()).toBe(true);
			expect(resolve_thinking_status_host()).not.toBe(null);
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 12s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("agent_settled still clears everything (timer, flags, host)", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			expect(thinking_status_should_show()).toBe(true);

			fire(handlers, "agent_settled", {}, ctx);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe("");
			expect(getSharedRenderer().hasAnyGroupThinkingChild()).toBe(false);
		} finally {
			performance.now = originalNow;
		}
	});

	test("visible thinking blocks remain transcript-owned (external header hidden on stream)", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(false);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			// Pre-tool placeholder still shows while blocks are visible.
			expect(thinking_status_should_show()).toBe(true);

			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);
			// The visible reasoning block owns the transcript slot.
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			expect(getSharedRenderer().hasAnyGroupThinkingChild()).toBe(false);
		} finally {
			performance.now = originalNow;
		}
	});
});

describe("Thinking pass timer lifecycle (idempotent arm / single clear)", () => {
	test("user-send timestamp preserved through before_agent_start", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			// User send arms the pass timer.
			expect(is_thinking_pass_timer_armed()).toBe(true);
			const armed_at = performance.now();
			// before_agent_start must NOT restart the timer.
			performance.now = () => SEND_TIME + 500;
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);
			// Elapsed continues from the original arm (500ms ago).
			performance.now = () => SEND_TIME + 2500;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 2s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("hidden thinking_delta preserves the armed pass timer", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);

			// Hidden thinking stream arrives — timer must NOT restart.
			performance.now = () => SEND_TIME + 1000;
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" } },
				ctx,
			);
			expect(is_thinking_pass_timer_armed()).toBe(true);
			performance.now = () => SEND_TIME + 3000;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 3s]",
			);

			// Repeated deltas must also preserve.
			performance.now = () => SEND_TIME + 4000;
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "more" } },
				ctx,
			);
			performance.now = () => SEND_TIME + 5000;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 5s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("message_end / agent_end preserves timer across inter-run gap", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);

			// message_end fires for the assistant message — timer must survive.
			performance.now = () => SEND_TIME + 2000;
			fire(handlers, "message_end", { message: { role: "assistant", timestamp: 200 } }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// agent_end fires (inter-run gap) — timer must still survive.
			performance.now = () => SEND_TIME + 3000;
			fire(handlers, "agent_end", {}, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// Elapsed continues from the original arm.
			performance.now = () => SEND_TIME + 5000;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 5s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("compaction rebuild preserves an already-armed pass timer", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } },
				ctx,
			);

			// session_compact fires — reconcile re-arms, but timer must persist.
			performance.now = () => SEND_TIME + 2000;
			fire(handlers, "session_compact", {}, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// Elapsed continues from the original arm.
			performance.now = () => SEND_TIME + 4000;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 4s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("visible thinking blocks suppress the external header (no duplicate)", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(false);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			// Pre-tool placeholder shows while blocks are visible.
			expect(thinking_status_should_show()).toBe(true);

			// Visible thinking_delta suppresses the external header.
			fire(
				handlers,
				"message_update",
				{ message: { role: "assistant", timestamp: 200 }, assistantMessageEvent: { type: "thinking_delta", delta: "visible reasoning" } },
				ctx,
			);
			expect(thinking_status_should_show()).toBe(false);
			expect(resolve_thinking_status_host()).toBe(null);
			// The pass timer is cleared by the visible-thinking hard boundary.
			expect(is_thinking_pass_timer_armed()).toBe(false);
		} finally {
			performance.now = originalNow;
		}
	});

	test("tool boundaries suppress header but preserve pass timer", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// Tool call suppresses the header but must NOT clear the timer.
			performance.now = () => SEND_TIME + 1000;
			fire(handlers, "tool_call", { toolName: "read", toolCallId: "t1" }, ctx);
			expect(thinking_status_should_show()).toBe(false);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// tool_execution_start also suppresses but preserves timer.
			performance.now = () => SEND_TIME + 2000;
			fire(handlers, "tool_execution_start", { toolCallId: "t1", toolName: "read" }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// tool_execution_end preserves timer too.
			performance.now = () => SEND_TIME + 3000;
			fire(handlers, "tool_execution_end", { toolCallId: "t1", toolName: "read" }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			// Elapsed continues from the original arm.
			performance.now = () => SEND_TIME + 5000;
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe(
				"[dim: 5s]",
			);
		} finally {
			performance.now = originalNow;
		}
	});

	test("agent_settled clears the pass timer (hard boundary)", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		setThinkingBlocksHidden(true);
		const originalNow = performance.now;
		performance.now = () => SEND_TIME;
		try {
			fire(handlers, "session_start", { reason: "startup" }, ctx);
			fire(handlers, "message_start", { message: { role: "user", timestamp: 100 } }, ctx);
			fire(handlers, "before_agent_start", { prompt: "hello" }, ctx);
			fire(handlers, "agent_start", {}, ctx);
			fire(handlers, "message_start", { message: { role: "assistant", timestamp: 200 } }, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(true);

			fire(handlers, "agent_settled", {}, ctx);
			expect(is_thinking_pass_timer_armed()).toBe(false);
			expect(stripAnsi(format_thinking_pass_elapsed_suffix(makeTheme() as never))).toBe("");
		} finally {
			performance.now = originalNow;
		}
	});
});
