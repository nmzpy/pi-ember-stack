import { describe, expect, test } from "bun:test";
import { build_cursor_user_prompt, cursor_serialize_tool, resolve_pi_tool_name, __test_only } from "../src/context.ts";
import { Type } from "typebox";
import type { Context, Message } from "@earendil-works/pi-ai";

function make_context(messages: Message[]): Context {
	return {
		systemPrompt: "default system prompt",
		messages,
		tools: [],
	};
}

describe("Cursor user prompt builder", () => {
	test("extracts the last user message text", () => {
		const context = make_context([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "cursor-cli", provider: "cursor", model: "auto", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "second", timestamp: 3 },
		]);

		expect(build_cursor_user_prompt(context, "code", true)).toContain("second");
		expect(build_cursor_user_prompt(context, "code", true)).toContain("You are in code mode");
	});

	test("omits mode directive when requested", () => {
		const context = make_context([
			{ role: "user", content: "hello", timestamp: 1 },
		]);

		expect(build_cursor_user_prompt(context, "plan", false)).toBe("hello");
	});

	test("uses code directive as default", () => {
		const context = make_context([
			{ role: "user", content: "hello", timestamp: 1 },
		]);

		expect(build_cursor_user_prompt(context, undefined, true)).toContain("You are in code mode");
	});

	test("includes plan mode directive", () => {
		const context = make_context([
			{ role: "user", content: "plan this", timestamp: 1 },
		]);

		expect(build_cursor_user_prompt(context, "plan", true)).toContain(
			"You are in plan mode",
		);
	});

	test("skips empty tip user messages and keeps walking", () => {
		const context = make_context([
			{ role: "user", content: "real ask", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "cursor-cli", provider: "cursor", model: "auto", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
			{ role: "user", content: "   ", timestamp: 3 },
		]);

		expect(build_cursor_user_prompt(context, "code", false)).toBe("real ask");
	});

	test("skips mode-enter boilerplate and finds the visible task", () => {
		const context = make_context([
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
		]);

		expect(build_cursor_user_prompt(context, "plan", true)).toContain(
			"Step blocks must overlap",
		);
		expect(build_cursor_user_prompt(context, "plan", true)).not.toContain("Entered Plan mode.");
	});

	test("does not forward directive-only when boilerplate is the only context row", () => {
		const context = make_context([
			{
				role: "user",
				content: "Entered Plan mode.",
				display: false,
				timestamp: 1,
			} as Message,
		]);

		expect(build_cursor_user_prompt(context, "plan", false)).toBe("");
	});

	test("explicit before_agent_start prompt wins over hidden context rows", () => {
		const context = make_context([
			{
				role: "user",
				content: "Entered Plan mode.",
				display: false,
				timestamp: 1,
			} as Message,
		]);

		expect(build_cursor_user_prompt(context, "code", false, "my real ask")).toBe("my real ask");
	});

	test("handles content arrays with images", () => {
		const context = make_context([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		]);

		expect(build_cursor_user_prompt(context, "code", true)).toContain("describe");
		expect(build_cursor_user_prompt(context, "code", true)).toContain("[image/image/png]");
	});
});

describe("Cursor tool serialization", () => {
	test("serializes a tool with cursor-style names", () => {
		const tool = {
			name: "edit",
			description: "Edit a file",
			parameters: Type.Object({
				path: Type.String(),
				oldText: Type.String(),
				newText: Type.String(),
			}),
		};

		const serialized = cursor_serialize_tool(tool);
		expect(serialized.name).toBe("Edit");
		expect(serialized.description).toBe("Edit a file");
		expect(serialized.parameters).toMatchObject({
			type: "object",
			properties: {
				file_path: { type: "string" },
				old_string: { type: "string" },
				new_string: { type: "string" },
			},
		});
	});

	test("resolve_pi_tool_name maps Cursor names without a Pi tool registry", () => {
		expect(resolve_pi_tool_name("shellToolCall", [])).toBe("bash");
		expect(resolve_pi_tool_name("readFileToolCall", [])).toBe("read");
		expect(resolve_pi_tool_name("grepToolCall", [])).toBe("grep");
		expect(resolve_pi_tool_name("globFileSearchToolCall", [])).toBe("find");
		expect(resolve_pi_tool_name("unknownThing", [])).toBeUndefined();
	});

	test("serializes extended tools with cursor arg remaps", () => {
		const tool = {
			name: "web_search",
			description: "Search the web",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string" },
				},
				required: ["query"],
			},
		};

		const serialized = cursor_serialize_tool(tool);
		expect(serialized.name).toBe("web_search");
		expect(serialized.parameters).toMatchObject({
			type: "object",
			properties: {
				search_term: { type: "string" },
			},
			required: ["search_term"],
		});
	});

	test("resolve_pi_tool_name maps Cursor web and todo aliases", () => {
		expect(resolve_pi_tool_name("webSearchToolCall", [])).toBe("web_search");
		expect(resolve_pi_tool_name("updateTodosToolCall", [])).toBe("todo");
		expect(resolve_pi_tool_name("askQuestionToolCall", [])).toBe("quiz");
	});
});

describe("Mode directive builder", () => {
	test("maps debug mode to a directive", () => {
		expect(__test_only.build_mode_directive("debug")).toContain("debug mode");
	});

	test("falls back to code directive for unknown modes", () => {
		expect(__test_only.build_mode_directive("unknown")).toContain("You are in code mode");
	});
});
