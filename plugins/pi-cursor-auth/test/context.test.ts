import { describe, expect, test } from "bun:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	__test_only,
	build_cursor_prompt,
	normalize_tool_arguments,
	resolve_pi_tool_name,
} from "../src/context.ts";

const TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
	},
	{
		name: "bash",
		description: "Run a command",
		parameters: Type.Object({ command: Type.String() }),
	},
	{
		name: "edit",
		description: "Edit a file",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
		}),
	},
	{
		name: "find",
		description: "Find files",
		parameters: Type.Object({ pattern: Type.String() }),
	},
];

describe("Cursor request mapping", () => {
	test("uses a neutral API envelope without provider persona injection", () => {
		expect(__test_only.REQUEST_PREAMBLE.toLowerCase()).not.toContain("you are");
		expect(__test_only.REQUEST_PREAMBLE.toLowerCase()).not.toContain("composer");
		expect(__test_only.REQUEST_PREAMBLE.toLowerCase()).not.toContain("cursor");
	});

	test("preserves the complete system prompt, history, and tool schema", () => {
		const context: Context = {
			systemPrompt: "SYSTEM EXACT\nDo the work.",
			messages: [
				{ role: "user", content: "Inspect src/index.ts", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 3,
				},
			],
			tools: TOOLS,
		};
		const prompt = build_cursor_prompt(context);
		const json = prompt.match(/<pi_model_request>\n([\s\S]+)\n<\/pi_model_request>/)?.[1];
		expect(json).toBeTruthy();
		const request = JSON.parse(json || "{}") as Record<string, unknown>;
		expect(request.systemPrompt).toBe(context.systemPrompt);
		expect((request.messages as unknown[]).length).toBe(3);
		expect((request.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
			"Read",
			"Shell",
			"Edit",
			"Glob",
		]);
	});

	test("rejects images rather than silently dropping them", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "abc", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
		};
		expect(() => build_cursor_prompt(context)).toThrow("do not support image input");
	});

	test("maps native CLI aliases only onto Pi's active tool list", () => {
		expect(resolve_pi_tool_name("shellToolCall", TOOLS)).toBe("bash");
		expect(resolve_pi_tool_name("readToolCall", TOOLS)).toBe("read");
		expect(resolve_pi_tool_name("globToolCall", TOOLS)).toBe("find");
		expect(resolve_pi_tool_name("deleteToolCall", TOOLS)).toBeUndefined();
	});

	test("repairs Cursor edit arguments to Pi's batch edit schema", () => {
		expect(
			normalize_tool_arguments("edit", {
				filePath: "src/index.ts",
				oldString: "before",
				newString: "after",
			}),
		).toEqual({
			path: "src/index.ts",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	test("maps glob tool call arguments to Pi's find schema", () => {
		expect(
			normalize_tool_arguments("find", {
				pattern: "**/*.ts",
				path: "src",
			}),
		).toEqual({
			pattern: "**/*.ts",
			path: "src",
		});

		expect(
			normalize_tool_arguments("find", {
				glob: "**/*.tsx",
				directory: "plugins",
				limit: 20,
			}),
		).toEqual({
			pattern: "**/*.tsx",
			path: "plugins",
			limit: 20,
		});
	});

	test("advertises Cursor-style tool names and remaps argument names in the schema", () => {
		const context: Context = {
			systemPrompt: "",
			messages: [],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({
						path: Type.String(),
						offset: Type.Optional(Type.Number()),
						limit: Type.Optional(Type.Number()),
					}),
				},
				{
					name: "find",
					description: "Find files",
					parameters: Type.Object({
						pattern: Type.String(),
						path: Type.Optional(Type.String()),
					}),
				},
			],
		};
		const prompt = build_cursor_prompt(context);
		const json = prompt.match(/<pi_model_request>\n([\s\S]+)\n<\/pi_model_request>/)?.[1];
		const request = JSON.parse(json || "{}") as {
			tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
		};
		const read_tool = request.tools.find((t) => t.name === "Read");
		expect(read_tool).toBeDefined();
		expect(read_tool!.parameters.properties).toHaveProperty("file_path");
		expect(read_tool!.parameters.properties).not.toHaveProperty("path");

		const glob_tool = request.tools.find((t) => t.name === "Glob");
		expect(glob_tool).toBeDefined();
		expect(glob_tool!.parameters.properties).toHaveProperty("glob");
		expect(glob_tool!.parameters.properties).not.toHaveProperty("pattern");
	});

	test("maps Cursor grep arguments to Pi's grep schema", () => {
		expect(
			normalize_tool_arguments("grep", {
				pattern: "TODO",
				include: "*.ts",
				limit: 10,
			}),
		).toEqual({
			pattern: "TODO",
			path: "*.ts",
			limit: 10,
		});
	});
});
