import { describe, expect, test } from "bun:test";
import { prepare_todo_arguments } from "../normalize.ts";

describe("prepare_todo_arguments", () => {
	test("passes through canonical update with status", () => {
		const out = prepare_todo_arguments({ action: "update", id: 1, status: "in_progress" });
		expect(out).toEqual({ action: "update", id: 1, status: "in_progress" });
	});

	test("unwraps Cursor-style todos array with nested status", () => {
		const out = prepare_todo_arguments({
			todos: [{ id: "1", content: "Module 1", status: "in_progress" }],
			merge: true,
		});
		expect(out.action).toBe("update");
		expect(out.id).toBe(1);
		expect(out.status).toBe("in_progress");
		expect(out.subject).toBe("Module 1");
		expect(out).not.toHaveProperty("todos");
	});

	test("normalizes hyphenated and numeric status values", () => {
		expect(prepare_todo_arguments({ action: "update", id: 1, status: "in-progress" }).status).toBe(
			"in_progress",
		);
		expect(prepare_todo_arguments({ action: "update", id: 1, status: 2 }).status).toBe("in_progress");
		expect(prepare_todo_arguments({ action: "update", id: 1, state: "completed" }).status).toBe(
			"completed",
		);
	});

	test("maps taskId alias and infers update action", () => {
		const out = prepare_todo_arguments({ taskId: 3, status: "completed" });
		expect(out).toEqual({ id: 3, status: "completed", action: "update" });
	});

	test("unwraps nested data.status", () => {
		const out = prepare_todo_arguments({
			action: "update",
			id: 1,
			data: { status: "in_progress" },
		});
		expect(out.status).toBe("in_progress");
		expect(out).not.toHaveProperty("data");
	});

	test("batch action for multi-item todos array", () => {
		const out = prepare_todo_arguments({
			todos: [
				{ id: 1, status: "completed" },
				{ id: 2, status: "in_progress" },
			],
		});
		expect(out.action).toBe("batch");
		expect(out.batch).toHaveLength(2);
		expect(out.batch?.[0]).toMatchObject({ id: 1, status: "completed" });
		expect(out.batch?.[1]).toMatchObject({ id: 2, status: "in_progress" });
	});
});
