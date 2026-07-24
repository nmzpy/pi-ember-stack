import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { map_context_to_cursor, __test_only } from "../src/context-map.ts";

describe("context-map assistant tool calls", () => {
	test("captures assistant tool calls on the active turn", () => {
		const mapped = map_context_to_cursor({
			messages: [
				{ role: "user", content: "second ask" },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
				},
				{ role: "toolResult", toolCallId: "c1", content: "a.ts", isError: false },
			],
			tools: [],
		});

		expect(mapped.turns).toEqual([
			{
				user_text: "second ask",
				assistant_text: "",
				tool_calls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }],
				embedded_tool_results: [],
			},
		]);
		expect(mapped.tool_results).toEqual([{ tool_call_id: "c1", content: "a.ts" }]);
		expect(mapped.user_text).toBe("");
	});

	test("embeds earlier tool results into completed turns", () => {
		const mapped = map_context_to_cursor({
			messages: [
				{ role: "user", content: "first ask" },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
				},
				{ role: "toolResult", toolCallId: "c1", content: "file body", isError: false },
				{ role: "assistant", content: [{ type: "text", text: "done" }] },
				{ role: "user", content: "next ask" },
			],
			tools: [],
		});

		expect(mapped.turns[0]?.embedded_tool_results).toEqual([
			{ tool_call_id: "c1", content: "file body" },
		]);
		expect(mapped.turns).toHaveLength(1);
		expect(mapped.user_text).toBe("next ask");
		expect(mapped.tool_results).toEqual([]);
	});

	test("keeps the current user message in user_text only for a fresh turn", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "h" }],
			tools: [],
		});

		expect(mapped.turns).toEqual([]);
		expect(mapped.user_text).toBe("h");
	});
});

describe("context-map user message filtering", () => {
	test("skips hidden mode-enter boilerplate when building turns", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "Step blocks must overlap after burst when End Buffer > 0",
				timestamp: 1,
			},
			{
				role: "user",
				content: "Entered Plan mode.",
				display: false,
				customType: "pi-agents-enter-plan",
				timestamp: 2,
			} as Message,
		];

		const mapped = map_context_to_cursor({ messages, tools: [] });
		expect(mapped.turns).toEqual([]);
		expect(mapped.user_text).toBe("Step blocks must overlap after burst when End Buffer > 0");
	});

	test("uses explicit user text over hidden context rows", () => {
		const mapped = map_context_to_cursor(
			{
				messages: [
					{
						role: "user",
						content: "Entered Plan mode.",
						display: false,
						timestamp: 1,
					} as Message,
				],
				tools: [],
			},
			undefined,
			"my real ask",
		);
		expect(mapped.user_text).toBe("my real ask");
	});
});

describe("context-map helpers", () => {
	test("extract_assistant_tool_calls preserves ids and args", () => {
		const calls = __test_only.extract_assistant_tool_calls([
			{ type: "text", text: "working" },
			{ type: "toolCall", id: "x1", name: "grep", arguments: { pattern: "foo" } },
		]);
		expect(calls).toEqual([{ id: "x1", name: "grep", arguments: { pattern: "foo" } }]);
	});
});
