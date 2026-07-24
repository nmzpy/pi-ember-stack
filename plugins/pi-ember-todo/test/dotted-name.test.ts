import { describe, expect, test } from "bun:test";
import { rewrite_dotted_todo_calls } from "../index.ts";

function assistant_message(parts: unknown[]) {
	return {
		role: "assistant" as const,
		content: parts,
		api: "openai-codex" as const,
		provider: "openai-codex" as const,
		model: "o3",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

describe("rewrite_dotted_todo_calls", () => {
	test("todo.create becomes todo + action: create", () => {
		const msg = assistant_message([{ type: "toolCall", id: "1", name: "todo.create", arguments: { subject: "X" } }]);
		const out = rewrite_dotted_todo_calls(msg);
		expect(out).not.toBeNull();
		const tool = (out?.content as { type: string; name: string; arguments: Record<string, unknown> }[])[0];
		expect(tool.name).toBe("todo");
		expect(tool.arguments).toEqual({ subject: "X", action: "create" });
		expect(out?.role).toBe("assistant");
	});

	test("todo.update preserves other fields", () => {
		const msg = assistant_message([
			{ type: "toolCall", id: "2", name: "todo.update", arguments: { id: 1, status: "completed" } },
		]);
		const out = rewrite_dotted_todo_calls(msg);
		const tool = (out?.content as { name: string; arguments: Record<string, unknown> }[])[0];
		expect(tool.name).toBe("todo");
		expect(tool.arguments).toEqual({ id: 1, status: "completed", action: "update" });
	});

	test("todo.batch with batch array", () => {
		const msg = assistant_message([
			{ type: "toolCall", id: "3", name: "todo.batch", arguments: { batch: [{ id: 1, status: "completed" }] } },
		]);
		const out = rewrite_dotted_todo_calls(msg);
		const tool = (out?.content as { name: string; arguments: Record<string, unknown> }[])[0];
		expect(tool.name).toBe("todo");
		expect(tool.arguments).toEqual({ batch: [{ id: 1, status: "completed" }], action: "batch" });
	});

	test("plain todo call is untouched", () => {
		const msg = assistant_message([{ type: "toolCall", id: "4", name: "todo", arguments: { action: "create", subject: "X" } }]);
		expect(rewrite_dotted_todo_calls(msg)).toBeNull();
	});

	test("non-todo tool call is untouched", () => {
		const msg = assistant_message([{ type: "toolCall", id: "5", name: "bash", arguments: { command: "ls" } }]);
		expect(rewrite_dotted_todo_calls(msg)).toBeNull();
	});

	test("text-only assistant message is untouched", () => {
		const msg = assistant_message([{ type: "text", text: "hello" }]);
		expect(rewrite_dotted_todo_calls(msg)).toBeNull();
	});

	test("invalid todo.foo is untouched", () => {
		const msg = assistant_message([{ type: "toolCall", id: "6", name: "todo.foo", arguments: {} }]);
		expect(rewrite_dotted_todo_calls(msg)).toBeNull();
	});

	test("mixed tool calls only rewrite todo.*", () => {
		const msg = assistant_message([
			{ type: "text", text: "ok" },
			{ type: "toolCall", id: "7", name: "todo.list", arguments: {} },
			{ type: "toolCall", id: "8", name: "bash", arguments: { command: "pwd" } },
			{ type: "toolCall", id: "9", name: "todo.delete", arguments: { id: 1 } },
		]);
		const out = rewrite_dotted_todo_calls(msg);
		expect(out).not.toBeNull();
		const content = out?.content as { type: string; name?: string; arguments?: Record<string, unknown> }[];
		expect(content[0]).toEqual({ type: "text", text: "ok" });
		expect(content[1].name).toBe("todo");
		expect(content[1].arguments).toEqual({ action: "list" });
		expect(content[2]).toEqual({ type: "toolCall", id: "8", name: "bash", arguments: { command: "pwd" } });
		expect(content[3].name).toBe("todo");
		expect(content[3].arguments).toEqual({ id: 1, action: "delete" });
	});

	test("original message is not mutated", () => {
		const parts = [{ type: "toolCall", id: "10", name: "todo.create", arguments: { subject: "X" } }];
		const msg = assistant_message(parts);
		rewrite_dotted_todo_calls(msg);
		expect(parts[0].name).toBe("todo.create");
		expect(msg.content).toBe(parts);
	});
});
