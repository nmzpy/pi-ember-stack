import { describe, expect, test } from "bun:test";
import { apply_subagent_stream_event, type SubAgentResult } from "../runner.ts";

function make_running_result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
	return {
		agent: "Coder A",
		task: "do stuff",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		reasoning: true,
		isThinking: false,
		...overrides,
	};
}

describe("apply_subagent_stream_event", () => {
	test("turn_start arms Thinking when no tool is active", () => {
		const result = make_running_result();
		let notify_count = 0;
		apply_subagent_stream_event(result, { type: "turn_start" }, () => {
			notify_count += 1;
		});
		expect(result.isThinking).toBe(true);
		expect(result.latestToolCall).toBeUndefined();
		expect(notify_count).toBe(1);
	});

	test("tool_execution_start captures latest tool and clears thinking", () => {
		const result = make_running_result({ isThinking: true });
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } },
			() => {},
		);
		expect(result.isThinking).toBe(false);
		expect(result.latestToolCall).toEqual({ name: "read", args: { path: "src/a.ts" } });
	});

	test("tool_execution_update refreshes args without clearing the preview row", () => {
		const result = make_running_result({
			latestToolCall: { name: "edit", args: { path: "a.ts", oldText: "a" } },
		});
		apply_subagent_stream_event(
			result,
			{
				type: "tool_execution_update",
				toolName: "edit",
				args: { path: "a.ts", oldText: "alpha", newText: "beta" },
			},
			() => {},
		);
		expect(result.latestToolCall?.args).toEqual({
			path: "a.ts",
			oldText: "alpha",
			newText: "beta",
		});
	});

	test("tool_execution_end keeps latestToolCall visible until the next activity", () => {
		const result = make_running_result({
			latestToolCall: { name: "grep", args: { pattern: "auth", path: "." } },
		});
		apply_subagent_stream_event(result, { type: "tool_execution_end" }, () => {});
		expect(result.latestToolCall).toEqual({ name: "grep", args: { pattern: "auth", path: "." } });
	});

	test("thinking_start clears stale tool preview and arms Thinking", () => {
		const result = make_running_result({
			latestToolCall: { name: "read", args: { path: "a.ts" } },
		});
		let notify_count = 0;
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			() => {
				notify_count += 1;
			},
		);
		expect(result.latestToolCall).toBeUndefined();
		expect(result.isThinking).toBe(true);
		expect(notify_count).toBe(1);
	});

	test("text_delta clears thinking without removing the lingering tool preview", () => {
		const result = make_running_result({
			isThinking: true,
			latestToolCall: { name: "bash", args: { command: "ls" } },
		});
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta" } },
			() => {},
		);
		expect(result.isThinking).toBe(false);
		expect(result.latestToolCall).toEqual({ name: "bash", args: { command: "ls" } });
	});
});
