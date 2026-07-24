import { describe, expect, test } from "bun:test";
import {
	format_todo_block,
	format_transcript_task_line,
	task_subject_token,
	TodoRenderer,
	TodoTranscriptComponent,
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
	test("task_subject_token mapping", () => {
		expect(task_subject_token("pending")).toBe("dim");
		expect(task_subject_token("in_progress")).toBe("text");
		expect(task_subject_token("completed")).toBe("muted");
		expect(task_subject_token("deleted")).toBe("muted");
	});

	test("format_transcript_task_line uses neutral tokens only", () => {
		const line = format_transcript_task_line(
			{ id: 1, subject: "Ship feature", status: "in_progress" },
			mock_theme,
			true,
		);
		expect(line).toContain("[text]");
		expect(line).not.toContain("[accent]");
		expect(line).not.toContain("[success]");
		expect(line).not.toContain("[warning]");
	});

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

	test("renders one row per visible task plus header", () => {
		const comp = new TodoTranscriptComponent(
			[
				{ id: 1, subject: "First", status: "pending" },
				{ id: 2, subject: "Second", status: "in_progress" },
				{ id: 3, subject: "Done", status: "completed" },
				{ id: 4, subject: "Gone", status: "deleted" },
			],
			mock_theme,
		);
		expect(comp.render(120)).toHaveLength(4);
	});

	test("tree rows align under Todo label with glyph on the branch", () => {
		const text = format_todo_block(
			[
				{ id: 1, subject: "First", status: "pending" },
				{ id: 2, subject: "Second", status: "pending" },
			],
			mock_theme,
		);
		const lines = text.split("\n");
		expect(lines[1]).toContain("  ├─");
		expect(lines[2]).toContain("  └─");
		expect(lines[1]).not.toContain("├─ ○");
		expect(lines[2]).not.toContain("└─ ○");
	});

	test("consecutive todo calls fold into one header block", () => {
		const renderer = new TodoRenderer();
		const theme = mock_theme;
		const mk_ctx = (id: string) => ({
			toolCallId: id,
			invalidate: () => {},
			state: {} as Record<string, unknown>,
		});

		renderer.renderCall([], theme, mk_ctx("a"));
		renderer.renderResult([{ id: 1, subject: "Module 1", status: "pending" }], theme, mk_ctx("a"));

		const second = renderer.renderCall([], theme, mk_ctx("b"));
		expect(second.render(80)).toHaveLength(0);

		renderer.renderResult(
			[
				{ id: 1, subject: "Module 1", status: "pending" },
				{ id: 2, subject: "Module 2", status: "pending" },
			],
			theme,
			mk_ctx("b"),
		);

		const first = renderer.renderCall([], theme, mk_ctx("a"));
		const lines = first.render(120);
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
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[error]");
	});
});
