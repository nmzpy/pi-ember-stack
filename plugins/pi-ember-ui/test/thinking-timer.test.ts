import { describe, expect, test } from "bun:test";
import {
	format_thinking_pass_elapsed_suffix,
	reset_thinking_pass_timer,
	thinking_status_terminal_layout,
} from "../index.ts";

function makeTheme() {
	return {
		fg: (tag: string, text: string) => `[${tag}:${text}]`,
	};
}

describe("thinking pass timer", () => {
	test("thinking_status_terminal_layout keeps one chatbox gap below widget Thinking", () => {
		expect(thinking_status_terminal_layout("widget")).toEqual({ padAbove: 0, padBelow: 0 });
		expect(thinking_status_terminal_layout("in_message")).toEqual({ padAbove: 1, padBelow: 1 });
	});

	test("format_thinking_pass_elapsed_suffix hides under 1s and formats elapsed text", () => {
		const theme = makeTheme();
		const now = performance.now();
		const original = performance.now;
		performance.now = () => now + 500;
		reset_thinking_pass_timer();
		expect(format_thinking_pass_elapsed_suffix(theme)).toBe("");
		performance.now = () => now + 2500;
		expect(format_thinking_pass_elapsed_suffix(theme)).toBe("[dim: 2s]");
		performance.now = original;
	});
});
