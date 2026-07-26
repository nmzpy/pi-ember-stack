import { describe, expect, test } from "bun:test";
import {
	arm_pre_token_thinking_status,
	arm_thinking_stream_status,
	format_thinking_pass_elapsed_suffix,
	is_thinking_pass_timer_armed,
	reset_thinking_pass_timer,
	set_thinking_pass_started_at_for_tests,
	thinking_status_terminal_layout,
} from "../index.ts";

function makeTheme() {
	return {
		fg: (tag: string, text: string) => `[${tag}:${text}]`,
	};
}

describe("thinking pass timer", () => {
	test("thinking_status_terminal_layout keeps one row for each host", () => {
		expect(thinking_status_terminal_layout("widget")).toEqual({ padAbove: 0, padBelow: 1 });
		expect(thinking_status_terminal_layout("in_message")).toEqual({ padAbove: 0, padBelow: 0 });
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
});
