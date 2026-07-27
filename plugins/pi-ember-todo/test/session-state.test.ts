import { describe, expect, test } from "bun:test";
import { __reset_state, replay_from_branch } from "../index.ts";

describe("todo session state after compaction", () => {
	test("replay_from_branch ignores pre-compaction todo results", () => {
		__reset_state();
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "todo-old",
					details: {
						tasks: [
							{ id: 1, subject: "Module 1", status: "completed" },
							{ id: 2, subject: "Module 2", status: "completed" },
						],
						nextId: 21,
					},
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-old" },
		];

		const ctx = {
			sessionManager: {
				getSessionId: () => "compact-test",
				getBranch: () => branch,
			},
		};

		const state = replay_from_branch(ctx as never);
		expect(state.tasks).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	test("replay_from_branch keeps post-compaction todo results", () => {
		__reset_state();
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "todo-old",
					details: { tasks: [{ id: 1, subject: "Old", status: "completed" }], nextId: 2 },
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-old" },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					toolCallId: "todo-new",
					details: {
						tasks: [{ id: 1, subject: "Fresh task", status: "pending" }],
						nextId: 2,
					},
				},
			},
		];

		const ctx = {
			sessionManager: {
				getSessionId: () => "compact-test-2",
				getBranch: () => branch,
			},
		};

		const state = replay_from_branch(ctx as never);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("Fresh task");
		expect(state.nextId).toBe(2);
	});
});
