import { describe, expect, test } from "bun:test";
import { beforeEach } from "bun:test";
import { CompactRenderer } from "../../pi-compact-tools/renderer.ts";
import { setThinkingBlocksHidden } from "../mode-colors.ts";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	format_thinking_pass_elapsed_suffix,
	is_thinking_pass_timer_armed,
	reset_thinking_header_state_for_tests,
	reset_thinking_pass_timer,
	set_thinking_pass_started_at_for_tests,
	status_can_update_previous_line,
	status_requires_leading_spacer,
	thinking_status_terminal_layout,
} from "../index.ts";
import { format_in_group_thinking_row, render_thinking_gradient_label } from "../thinking-status-render.ts";
import {
	activate_gradient,
	reset_gradient_colorizer,
	set_gradient_colorizer,
	shutdown_gradient_clock,
} from "../gradient.ts";

function forcedColorizer(rgb: [number, number, number], text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

function strip_ansi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme() {
	return {
		fg: (tag: string, text: string) => `[${tag}:${text}]`,
		bold: (s: string) => `*${s}*`,
	};
}

describe("thinking pass timer", () => {
	beforeEach(() => {
		// Each timer test starts from a clean thinking-header state so leaked
		// stream-active flags from a prior test cannot change arm semantics.
		reset_thinking_header_state_for_tests();
	});

	test("thinking_status_terminal_layout renders identical row structures per host", () => {
		// Widget lives below Pi's widget-container leading spacer, so it must not
		// add a second blank above (that extra row is the visible 1-row jump on
		// send); it adds the blank below to mirror the empty container spacer in
		// the in-message case. Both hosts end up [blank][Thinking][blank].
		expect(thinking_status_terminal_layout("widget")).toEqual({ padAbove: 0, padBelow: 1 });
		expect(thinking_status_terminal_layout("in_message")).toEqual({ padAbove: 1, padBelow: 0 });
	});

	test("final turn status stays distinct with exactly one leading spacer", () => {
		expect(status_can_update_previous_line(true, false)).toBe(true);
		expect(status_can_update_previous_line(true, true)).toBe(false);
		expect(status_requires_leading_spacer(true)).toBe(false);
		expect(status_requires_leading_spacer(false)).toBe(true);
	});

	test("Thinking label is gradient-colored", () => {
		set_gradient_colorizer(forcedColorizer);
		try {
			const label = render_thinking_gradient_label();
			expect(label).toMatch(/\x1b\[/);
			expect(label.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Thinking");
		} finally {
			reset_gradient_colorizer();
		}
	});

	test("in-group Thinking uses the normal clock phase on every render", () => {
		const original_now = performance.now;
		set_gradient_colorizer(forcedColorizer);
		shutdown_gradient_clock();
		performance.now = () => 1_000_000;
		try {
			activate_gradient("thinking");
			const first = format_in_group_thinking_row();
			const second = format_in_group_thinking_row();
			expect(second).toBe(first);
		} finally {
			performance.now = original_now;
			shutdown_gradient_clock();
			reset_gradient_colorizer();
		}
	});

	test("format_thinking_pass_elapsed_suffix hides under 1s and formats elapsed text", () => {
		const theme = makeTheme();
		const base = 1_000_000;
		const original = performance.now;
		set_thinking_pass_started_at_for_tests(base);
		performance.now = () => base + 500;
		expect(format_thinking_pass_elapsed_suffix(theme)).toBe("");
		performance.now = () => base + 2500;
		expect(format_thinking_pass_elapsed_suffix(theme)).toBe("[dim: 2s]");
		performance.now = original;
		reset_thinking_pass_timer();
		set_thinking_pass_started_at_for_tests(0);
	});

	test("arm_thinking_stream_status continues an already-armed pass timer", () => {
		const pinned = 1_000_000;
		set_thinking_pass_started_at_for_tests(pinned);
		expect(is_thinking_pass_timer_armed()).toBe(true);
		try {
			arm_thinking_stream_status();
			// A real thinking stream that CONTINUES an armed pre-token wait keeps
			// the same pass timer — hidden reasoning never restarts the pre-answer
			// elapsed (the boundary that hid the header already zeroed it).
			expect(is_thinking_pass_timer_armed()).toBe(true);
			const theme = makeTheme();
			const original = performance.now;
			performance.now = () => pinned + 500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("");
			performance.now = () => pinned + 2500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("[dim: 2s]");
			performance.now = original;
		} finally {
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("arm_thinking_stream_status starts a fresh timer when no pass is armed", () => {
		reset_thinking_pass_timer();
		set_thinking_pass_started_at_for_tests(0);
		const original = performance.now;
		const start = 3_000_000;
		performance.now = () => start;
		try {
			expect(is_thinking_pass_timer_armed()).toBe(false);
			arm_thinking_stream_status();
			// No live pass exists (post-boundary / post-agent_end re-arm): the
			// stream start opens a fresh pass.
			expect(is_thinking_pass_timer_armed()).toBe(true);
			const theme = makeTheme();
			performance.now = () => start + 500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("");
			performance.now = () => start + 2500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("[dim: 2s]");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("arm_pre_token_thinking_status preserves an already-armed pass timer", () => {
		const original = performance.now;
		const fresh = 2_000_000;
		const original_start = fresh - 2_500;
		set_thinking_pass_started_at_for_tests(original_start);
		performance.now = () => fresh;
		try {
			arm_pre_token_thinking_status();
			expect(is_thinking_pass_timer_armed()).toBe(true);
			// The idempotent arm preserves the already-live timestamp — no restart.
			// The elapsed continues from the original arm (2.5s ago).
			performance.now = () => fresh + 500;
			expect(format_thinking_pass_elapsed_suffix(makeTheme())).toBe("[dim: 3s]");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("arm_pre_token_thinking_status starts a fresh timer when no pass is armed", () => {
		const original = performance.now;
		const fresh = 2_000_000;
		set_thinking_pass_started_at_for_tests(0);
		performance.now = () => fresh;
		try {
			arm_pre_token_thinking_status();
			expect(is_thinking_pass_timer_armed()).toBe(true);
			// No prior pass: the arm starts fresh from now.
			performance.now = () => fresh + 500;
			expect(format_thinking_pass_elapsed_suffix(makeTheme())).toBe("");
			performance.now = () => fresh + 2500;
			expect(format_thinking_pass_elapsed_suffix(makeTheme())).toBe("[dim: 2s]");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("noteThinking does not reset the pass timer when the in-group lane appears", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme();
		const owner_state: Record<string, unknown> = {};
		const owner_ctx = {
			toolCallId: "thinking-timer-owner",
			state: owner_state,
			invalidate() {},
		};
		const child_ctx = {
			toolCallId: "thinking-timer-child",
			state: {},
			invalidate() {},
		};
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx as never);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx as never);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx as never);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false } as never,
		);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false } as never,
		);

		const original = performance.now;
		const fresh = 2_000_000;
		set_thinking_pass_started_at_for_tests(fresh - 2_500);
		performance.now = () => fresh;
		try {
			r.noteThinking();
			// The in-group lane appears, but the SHARED turn pass timer (started on
			// the user message) is NOT reset — the lane elapsed suffix continues the
			// full wait instead of restarting when the thinking stream arrives.
			expect(is_thinking_pass_timer_armed()).toBe(true);
			const row = strip_ansi((owner_state.callText as { text?: string }).text ?? "");
			expect(row).toContain("Thinking");
			expect(row).toContain("2s");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});
});
