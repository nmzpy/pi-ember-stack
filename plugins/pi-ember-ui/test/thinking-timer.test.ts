import { describe, expect, test } from "bun:test";
import { CompactRenderer } from "../../pi-compact-tools/renderer.ts";
import { setThinkingBlocksHidden } from "../mode-colors.ts";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	format_thinking_pass_elapsed_suffix,
	is_thinking_pass_timer_armed,
	reset_thinking_pass_timer,
	set_thinking_pass_started_at_for_tests,
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

function makeTheme() {
	return {
		fg: (tag: string, text: string) => `[${tag}:${text}]`,
		bold: (s: string) => `*${s}*`,
	};
}

describe("thinking pass timer", () => {
	test("thinking_status_terminal_layout keeps one row for each host", () => {
		expect(thinking_status_terminal_layout("widget")).toEqual({ padAbove: 0, padBelow: 0 });
		expect(thinking_status_terminal_layout("in_message")).toEqual({ padAbove: 1, padBelow: 0 });
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

	test("arm_thinking_stream_status does not reset an armed pass timer", () => {
		const pinned = 1_000_000;
		set_thinking_pass_started_at_for_tests(pinned);
		expect(is_thinking_pass_timer_armed()).toBe(true);
		try {
			arm_thinking_stream_status();
			expect(is_thinking_pass_timer_armed()).toBe(true);
			set_thinking_pass_started_at_for_tests(pinned);
			const theme = makeTheme();
			const original = performance.now;
			performance.now = () => pinned + 2500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("[dim: 2s]");
			performance.now = original;
		} finally {
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("arm_pre_token_thinking_status still starts a fresh pass timer", () => {
		const pinned = 1_000_000;
		set_thinking_pass_started_at_for_tests(pinned);
		const original = performance.now;
		const fresh = 2_000_000;
		performance.now = () => fresh;
		try {
			arm_pre_token_thinking_status();
			performance.now = () => fresh + 500;
			expect(format_thinking_pass_elapsed_suffix(makeTheme())).toBe("");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});

	test("noteThinking resets the pass timer when the in-group lane appears", () => {
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

		const pinned = 1_000_000;
		set_thinking_pass_started_at_for_tests(pinned);
		const original = performance.now;
		const fresh = 2_000_000;
		performance.now = () => fresh;
		try {
			r.noteThinking();
			performance.now = () => fresh + 500;
			expect(format_thinking_pass_elapsed_suffix(theme)).toBe("");
		} finally {
			performance.now = original;
			reset_thinking_pass_timer();
			set_thinking_pass_started_at_for_tests(0);
		}
	});
});
