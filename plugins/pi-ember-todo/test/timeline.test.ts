import { describe, expect, test } from "bun:test";
import { flatten_todo_timeline, todo_group_boundary_before } from "../timeline.ts";

describe("todo timeline", () => {
	test("flatten_todo_timeline preserves transcript order", () => {
		const timeline = flatten_todo_timeline([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read-1", name: "read" },
						{ type: "toolCall", id: "todo-1", name: "todo" },
					],
				},
			},
			{
				type: "message",
				message: { role: "user", content: "continue" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-2", name: "todo" }],
				},
			},
		] as never);

		expect(timeline).toEqual([
			{ kind: "tool", id: "read-1", name: "read" },
			{ kind: "tool", id: "todo-1", name: "todo" },
			{ kind: "user" },
			{ kind: "tool", id: "todo-2", name: "todo" },
		]);
	});

	test("todo_group_boundary_before is false across non-todo tools", () => {
		const timeline = flatten_todo_timeline([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "todo-1", name: "todo" },
						{ type: "toolCall", id: "edit-1", name: "edit" },
						{ type: "toolCall", id: "todo-2", name: "todo" },
					],
				},
			},
		] as never);

		expect(todo_group_boundary_before(timeline, "todo-1")).toBe(false);
		expect(todo_group_boundary_before(timeline, "todo-2")).toBe(false);
	});

	test("todo_group_boundary_before is true after a user message", () => {
		const timeline = flatten_todo_timeline([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-1", name: "todo" }],
				},
			},
			{
				type: "message",
				message: { role: "user", content: "go" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-2", name: "todo" }],
				},
			},
		] as never);

		expect(todo_group_boundary_before(timeline, "todo-1")).toBe(false);
		expect(todo_group_boundary_before(timeline, "todo-2")).toBe(true);
	});

	test("hidden user messages do not split todo groups", () => {
		const timeline = flatten_todo_timeline([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-1", name: "todo" }],
				},
			},
			{
				type: "message",
				message: { role: "user", content: "continue", display: false },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-2", name: "todo" }],
				},
			},
		] as never);

		expect(timeline).toEqual([
			{ kind: "tool", id: "todo-1", name: "todo" },
			{ kind: "tool", id: "todo-2", name: "todo" },
		]);
		expect(todo_group_boundary_before(timeline, "todo-2")).toBe(false);
	});
});
