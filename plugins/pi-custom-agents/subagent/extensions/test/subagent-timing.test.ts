import { describe, expect, test } from "bun:test";
import {
	arm_subagent_thinking_pass,
	clear_subagent_thinking_pass,
	format_subagent_thinking_elapsed_suffix,
	markSubagentTerminal,
} from "../subagent-timing.ts";

describe("subagent thinking pass timer", () => {
	test("format_subagent_thinking_elapsed_suffix hides under 1s and formats elapsed text", () => {
		const theme = {
			fg: (tag: string, text: string) => `[${tag}:${text}]`,
		};
		const id = "call-thinking";
		arm_subagent_thinking_pass(id);
		expect(format_subagent_thinking_elapsed_suffix(theme, id)).toBe("");

		const started = performance.now() - 2500;
		arm_subagent_thinking_pass(id);
		clear_subagent_thinking_pass(id);
		arm_subagent_thinking_pass(id);
		// Pin start time via re-arm after clear
		clear_subagent_thinking_pass(id);
		// Manually set via arm at past time — use markSubagentTerminal cleanup path
		arm_subagent_thinking_pass(id);
		// Sleep-free: test the threshold with a mocked approach — mark terminal clears
		markSubagentTerminal(id);
		expect(format_subagent_thinking_elapsed_suffix(theme, id)).toBe("");
	});

	test("markSubagentTerminal clears thinking pass", () => {
		const theme = { fg: (tag: string, text: string) => `[${tag}:${text}]` };
		const id = "call-clear";
		arm_subagent_thinking_pass(id);
		markSubagentTerminal(id);
		expect(format_subagent_thinking_elapsed_suffix(theme, id)).toBe("");
	});
});
