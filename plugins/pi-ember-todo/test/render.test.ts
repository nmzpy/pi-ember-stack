import { describe, expect, test } from "bun:test";
import {
	format_todo_block,
	TodoRenderer,
	TodoTranscriptComponent,
	seed_todo_renderer_from_branch,
} from "../render.ts";

const mock_theme = {
	fg(tag: string, text: string): string {
		return `[${tag}]${text}[/${tag}]`;
	},
	strikethrough(text: string): string {
		return `~~${text}~~`;
	},
	bold(text: string): string {
		return text;
	},
};

describe("todo transcript render", () => {
	test("header matches compact tool styling (muted bullet and label)", () => {
		const comp = new TodoTranscriptComponent([], mock_theme);
		const lines = comp.render(80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[muted]");
		expect(lines[0]).not.toContain("[dim]");
		expect(lines[0]).not.toContain("[text]");
		expect(lines[0]).not.toContain("[accent]");
		expect(lines[0]).toContain("• ");
		expect(lines[0]).toContain("Todo");
	});

	test("header bullet turns green when all visible tasks are completed", () => {
		const text = format_todo_block(
			[
				{ id: 1, subject: "Create release notes for v1.37.3", status: "completed" },
				{ id: 2, subject: "Fix failing test assertions for v1.37.3 release", status: "completed" },
			],
			mock_theme,
		);
		const header = text.split("\n")[0];
		expect(header).toContain("[success]• [");
		expect(header).not.toMatch(/\[success\].*\[success\]/);
	});

	test("header bullet stays muted while any task is incomplete", () => {
		const text = format_todo_block(
			[
				{ id: 1, subject: "Done", status: "completed" },
				{ id: 2, subject: "Pending", status: "pending" },
			],
			mock_theme,
		);
		const header = text.split("\n")[0];
		expect(header).toContain("[muted]• [");
		expect(header).not.toContain("[success]");
	});

	test("renders task subjects without parenthetical details", () => {
		const comp = new TodoTranscriptComponent(
			[
				{ id: 1, subject: "First", status: "pending" },
				{ id: 2, subject: "Second", status: "in_progress", activeForm: "Working on it" },
				{ id: 3, subject: "Done", status: "completed" },
				{ id: 4, subject: "Gone", status: "deleted" },
			],
			mock_theme,
		);
		const lines = comp.render(120);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Todo");
		expect(lines[1]).toContain("[dim]    ├─[/dim]");
		expect(lines[1]).toContain("First");
		expect(lines[2]).toContain("[dim]    ├─[/dim]");
		expect(lines[2]).toContain("Second");
		expect(lines[2]).not.toContain("(Working on it)");
		expect(lines[3]).toContain("[dim]    └─[/dim]");
		expect(lines[3]).toContain("Done");
	});

	test("consecutive todo calls fold into one header at the latest call position", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		const state_a: Record<string, unknown> = {};
		const state_b: Record<string, unknown> = {};
		const mk_ctx = (id: string, state: Record<string, unknown>) => ({
			toolCallId: id,
			invalidate: () => {},
			state,
		});

		renderer.renderCall([], theme, mk_ctx("a", state_a));
		renderer.renderResult([{ id: 1, subject: "Module 1", status: "pending" }], theme, mk_ctx("a", state_a));

		const second = renderer.renderCall([], theme, mk_ctx("b", state_b));
		expect(second.render(80).length).toBe(2);

		renderer.renderResult(
			[
				{ id: 1, subject: "Module 1", status: "pending" },
				{ id: 2, subject: "Module 2", status: "pending" },
			],
			theme,
			mk_ctx("b", state_b),
		);

		const first = renderer.renderCall([], theme, mk_ctx("a", state_a));
		expect(first.render(80)).toHaveLength(0);

		const lines = second.render(120);
		expect(lines.filter((l) => l.includes("Todo"))).toHaveLength(1);
		expect(lines).toHaveLength(3);
	});

	test("todos interleaved with other tools stay in one group at the latest todo", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		const mk_ctx = (id: string) => ({
			toolCallId: id,
			invalidate: () => {},
			state: {} as Record<string, unknown>,
		});

		renderer.renderCall([], theme, mk_ctx("todo-a"));
		renderer.renderResult([{ id: 1, subject: "One", status: "pending" }], theme, mk_ctx("todo-a"));
		// Simulates edit/grep/bash between todos without settling the todo group.
		const latest = renderer.renderCall([], theme, mk_ctx("todo-b"));
		renderer.renderResult(
			[
				{ id: 1, subject: "One", status: "completed" },
				{ id: 2, subject: "Two", status: "pending" },
			],
			theme,
			mk_ctx("todo-b"),
		);

		expect(renderer.renderCall([], theme, mk_ctx("todo-a")).render(80)).toHaveLength(0);
		const lines = latest.render(120);
		expect(lines.filter((l) => l.includes("Todo"))).toHaveLength(1);
	});

	test("rebuild does not duplicate grouped todo headers", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		const state_a: Record<string, unknown> = {};
		const state_b: Record<string, unknown> = {};
		const mk_ctx = (id: string, state: Record<string, unknown>) => ({
			toolCallId: id,
			invalidate: () => {},
			state,
		});

		renderer.renderCall([], theme, mk_ctx("a", state_a));
		renderer.renderResult([{ id: 1, subject: "One", status: "pending" }], theme, mk_ctx("a", state_a));
		renderer.renderCall([], theme, mk_ctx("b", state_b));
		renderer.renderResult(
			[
				{ id: 1, subject: "One", status: "completed" },
				{ id: 2, subject: "Two", status: "pending" },
			],
			theme,
			mk_ctx("b", state_b),
		);

		renderer.settleGroup();

		const rebuilt_a = renderer.renderCall([], theme, mk_ctx("a", state_a));
		const rebuilt_b = renderer.renderCall([], theme, mk_ctx("b", state_b));
		expect(rebuilt_a.render(80)).toHaveLength(0);

		const lines = rebuilt_b.render(120);
		expect(lines.filter((l) => l.includes("Todo"))).toHaveLength(1);
		expect(lines).toHaveLength(3);
	});

	test("non-todo boundary starts a fresh todo group", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		const mk_ctx = (id: string) => ({
			toolCallId: id,
			invalidate: () => {},
			state: {} as Record<string, unknown>,
		});

		renderer.renderCall([], theme, mk_ctx("a"));
		renderer.renderResult([{ id: 1, subject: "One", status: "pending" }], theme, mk_ctx("a"));
		renderer.settleGroup();

		renderer.renderCall([], theme, mk_ctx("b"));
		const lines = renderer.renderCall([], theme, mk_ctx("b")).render(120);
		expect(lines.filter((l) => l.includes("Todo"))).toHaveLength(1);
		expect(lines).toHaveLength(1);
	});

	test("error row uses error token only", () => {
		const comp = new TodoTranscriptComponent([], mock_theme, "subject required for create");
		const lines = comp.render(80);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Todo");
		expect(lines[1]).toContain("[error]");
	});

	test("renderCall alone restores tasks from stored snapshot after renderResult", () => {
		const renderer = new TodoRenderer();
		const state: Record<string, unknown> = {};
		const mk_ctx = (id: string) => ({
			toolCallId: id,
			invalidate: () => {},
			state,
		});
		const tasks = [
			{ id: 1, subject: "Module 1", status: "pending" as const },
			{ id: 2, subject: "Module 2", status: "in_progress" as const },
		];

		renderer.renderCall([], mock_theme, mk_ctx("todo-1"));
		renderer.renderResult(tasks, mock_theme, mk_ctx("todo-1"));

		const rebuilt_state: Record<string, unknown> = {};
		const rebuilt = renderer.renderCall([], mock_theme, {
			toolCallId: "todo-1",
			invalidate: () => {},
			state: rebuilt_state,
		});
		expect(rebuilt.render(120)).toHaveLength(3);
	});

	test("renderResult before renderCall on rebuild still paints full block", () => {
		const renderer = new TodoRenderer();
		const tasks = [{ id: 1, subject: "Ship", status: "pending" as const }];
		const state: Record<string, unknown> = {};
		const ctx = { toolCallId: "todo-1", invalidate: () => {}, state };

		renderer.renderResult(tasks, mock_theme, ctx);
		const call = renderer.renderCall([], mock_theme, ctx);
		expect(call.render(120)).toHaveLength(2);
	});

	test("previous todo owner invalidates when a newer todo joins the group", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		let invalidates_a = 0;
		const state_a: Record<string, unknown> = {};
		const state_b: Record<string, unknown> = {};
		const mk_ctx = (id: string, state: Record<string, unknown>, invalidate?: () => void) => ({
			toolCallId: id,
			invalidate: invalidate ?? (() => {}),
			state,
		});

		renderer.renderCall([], theme, mk_ctx("a", state_a, () => invalidates_a++));
		renderer.renderResult(
			[{ id: 1, subject: "One", status: "pending" }],
			theme,
			mk_ctx("a", state_a, () => invalidates_a++),
		);

		renderer.renderCall([], theme, mk_ctx("b", state_b));
		expect(invalidates_a).toBe(1);

		renderer.renderResult(
			[
				{ id: 1, subject: "One", status: "pending" },
				{ id: 2, subject: "Two", status: "pending" },
			],
			theme,
			mk_ctx("b", state_b),
		);

		expect(renderer.renderCall([], theme, mk_ctx("a", state_a)).render(80)).toHaveLength(0);
		const lines = renderer.renderCall([], theme, mk_ctx("b", state_b)).render(120);
		expect(lines.filter((l) => l.includes("Todo"))).toHaveLength(1);
	});

	test("seed from branch restores grouped snapshots before chat rebuild", () => {
		const renderer = new TodoRenderer();
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "todo-a", name: "todo" },
						{ type: "toolCall", id: "todo-b", name: "todo" },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "todo-a",
					toolName: "todo",
					details: {
						tasks: [{ id: 1, subject: "One", status: "pending" }],
					},
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "todo-b",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "One", status: "completed" },
							{ id: 2, subject: "Two", status: "pending" },
						],
					},
				},
			},
		] as never;

		renderer.resetForSession();
		seed_todo_renderer_from_branch(branch, renderer);

		const owner = renderer.renderCall([], mock_theme, {
			toolCallId: "todo-b",
			invalidate: () => {},
			state: {},
		});
		expect(owner.render(120)).toHaveLength(3);
		expect(renderer.renderCall([], mock_theme, { toolCallId: "todo-a", invalidate: () => {}, state: {} }).render(80)).toHaveLength(0);
	});

	test("seed from branch ignores pre-compaction todo snapshots", () => {
		const renderer = new TodoRenderer();
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "todo-old", name: "todo" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "todo-old",
					toolName: "todo",
					details: {
						tasks: [
							{ id: 1, subject: "Old task", status: "completed" },
							{ id: 2, subject: "Also old", status: "pending" },
						],
					},
				},
			},
			{ type: "compaction", firstKeptEntryId: "todo-old" },
		] as never;

		renderer.resetForSession();
		seed_todo_renderer_from_branch(branch, renderer);

		const call = renderer.renderCall([], mock_theme, { toolCallId: "todo-old", invalidate: () => {}, state: {} });
		const lines = call.render(80);
		// Pre-compaction todo calls are not replayed into a TodoGroup, so the
		// renderer falls back to a single empty row for an unregistered id.
		expect(lines.length).toBeLessThanOrEqual(1);
	});
});
