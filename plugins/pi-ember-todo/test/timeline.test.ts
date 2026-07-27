import { describe, expect, test } from "bun:test";
import {
	branch_entries_after_last_compaction,
	branch_had_compaction,
	flatten_todo_timeline,
	is_post_compaction_todo_call,
	todo_group_boundary_before,
} from "../timeline.ts";

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

	test("flatten_todo_timeline emits compact markers", () => {
		const timeline = flatten_todo_timeline([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-1", name: "todo" }],
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-1" },
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
			{ kind: "compact" },
			{ kind: "tool", id: "todo-2", name: "todo" },
		]);
		expect(todo_group_boundary_before(timeline, "todo-2")).toBe(true);
	});

	test("branch_entries_after_last_compaction slices post-compact entries", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "todo-1",
					details: { tasks: [{ id: 1, subject: "Old", status: "completed" }], nextId: 2 },
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-1" },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "todo-2",
					details: { tasks: [{ id: 1, subject: "New", status: "pending" }], nextId: 2 },
				},
			},
		] as never;

		expect(branch_entries_after_last_compaction(branch)).toHaveLength(1);
		expect(branch_entries_after_last_compaction(branch)[0]).toMatchObject({ type: "message" });
	});

	test("is_post_compaction_todo_call rejects pre-compaction todo ids", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-old", name: "todo" }],
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-old" },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-new", name: "todo" }],
				},
			},
		] as never;

		expect(branch_had_compaction(branch)).toBe(true);
		expect(is_post_compaction_todo_call(branch, "todo-old")).toBe(false);
		expect(is_post_compaction_todo_call(branch, "todo-new")).toBe(true);
	});
});
