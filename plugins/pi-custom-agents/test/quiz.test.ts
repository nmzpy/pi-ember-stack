import { describe, expect, test } from "bun:test";
import {
	buildQuizOptionRow,
	format_answers_for_model,
	format_quiz_call_row,
	format_quiz_transcript_answers,
	finalize_quiz_tool_render,
	should_hide_quiz_call_row,
	type QuizQuestion,
} from "../quiz-tool.ts";

const mock_theme = {
	fg: (_tag: string, text: string) => text,
	bold: (text: string) => text,
};

const questions: QuizQuestion[] = [
	{
		id: "plan-review",
		label: "Plan Review",
		prompt: "Choose what to do with the plan.",
		options: [
			{ value: "implement", label: "Implement Plan" },
			{ value: "copy", label: "Copy Plan" },
		],
	},
	{
		id: "no-label",
		prompt: "Pick a direction.",
		options: [{ value: "left", label: "Left" }],
	},
];

describe("format_answers_for_model", () => {
	test("selected option emits Q(label): prompt → A(selected): answer", () => {
		const out = format_answers_for_model(questions, [
			{ id: "plan-review", value: "implement", label: "Implement Plan", wasCustom: false },
		]);
		expect(out).toBe(
			"Q(Plan Review): Choose what to do with the plan. → A(selected): Implement Plan",
		);
	});

	test("custom answer emits A(custom) marker", () => {
		const out = format_answers_for_model(questions, [
			{ id: "plan-review", value: "do something else", label: "do something else", wasCustom: true },
		]);
		expect(out).toBe(
			"Q(Plan Review): Choose what to do with the plan. → A(custom): do something else",
		);
	});

	test("question with no label falls back to id in the Q() header", () => {
		const out = format_answers_for_model(questions, [
			{ id: "no-label", value: "left", label: "Left", wasCustom: false },
		]);
		expect(out).toBe("Q(no-label): Pick a direction. → A(selected): Left");
	});

	test("multiple answers join with newline", () => {
		const out = format_answers_for_model(questions, [
			{ id: "plan-review", value: "copy", label: "Copy Plan", wasCustom: false },
			{ id: "no-label", value: "left", label: "Left", wasCustom: false },
		]);
		expect(out).toBe(
			"Q(Plan Review): Choose what to do with the plan. → A(selected): Copy Plan\n" +
				"Q(no-label): Pick a direction. → A(selected): Left",
		);
	});
});

describe("format_quiz_call_row", () => {
	test("hidden overlay returns empty string", () => {
		expect(
			format_quiz_call_row({ questions: [questions[0]] }, mock_theme as any, {
				completed: false,
				hidden: true,
			}),
		).toBe("");
	});

	test("streaming row uses uppercase Quiz label", () => {
		const row = format_quiz_call_row({ questions: [questions[0]] }, mock_theme as any, {
			completed: false,
			hidden: false,
		});
		expect(row).toContain("Quiz");
		expect(row).not.toContain("quiz");
		expect(row).toContain("1 question");
	});

	test("completed row uses muted Quiz label and success bullet", () => {
		const theme = {
			fg: (tag: string, text: string) => `[${tag}]${text}`,
			bold: (text: string) => text,
		};
		const row = format_quiz_call_row({ questions: questions }, theme as any, {
			completed: true,
			hidden: false,
		});
		expect(row).toContain("[success]");
		expect(row).toContain("[muted]Quiz ");
		expect(row).toContain("[muted]2 questions");
		expect(row).not.toContain("[dim]Quiz");
	});

	test("cancelled row uses error bullet and Quiz cancelled label only", () => {
		const theme = {
			fg: (tag: string, text: string) => `[${tag}]${text}`,
			bold: (text: string) => text,
		};
		const row = format_quiz_call_row({ questions: [questions[0]] }, theme as any, {
			completed: true,
			hidden: false,
			cancelled: true,
		});
		expect(row).toBe("[error]• [dim]Quiz cancelled");
		expect(row).not.toContain("question");
	});
});

describe("should_hide_quiz_call_row", () => {
	test("hides only the in-flight quiz call until answers are rendered", () => {
		expect(should_hide_quiz_call_row("quiz-1", false, "quiz-1")).toBe(true);
		expect(should_hide_quiz_call_row("quiz-1", true, "quiz-1")).toBe(false);
		expect(should_hide_quiz_call_row("quiz-1", false, "quiz-2")).toBe(false);
		expect(should_hide_quiz_call_row("quiz-1", false, undefined)).toBe(false);
	});
});

describe("finalize_quiz_tool_render", () => {
	test("marks completed and invalidates only on first pass", () => {
		const state: Record<string, unknown> = {};
		let invalidations = 0;
		const invalidate = () => {
			invalidations++;
		};

		finalize_quiz_tool_render("quiz-1", state, invalidate);
		expect(state.quizCompleted).toBe(true);
		expect(invalidations).toBe(1);

		finalize_quiz_tool_render("quiz-1", state, invalidate);
		expect(invalidations).toBe(1);
	});
});

describe("format_quiz_transcript_answers", () => {
	test("emits one dim question arrow text answer line per answer", () => {
		const out = format_quiz_transcript_answers(
			questions,
			[{ id: "plan-review", value: "implement", label: "Implement Plan", wasCustom: false }],
			mock_theme as any,
		);
		expect(out).toBe("Plan Review: Choose what to do with the plan. → Implement Plan");
	});
});

describe("buildQuizOptionRow", () => {
	const theme = {
		fg: (color: string, text: string) => `[${color}:${text}]`,
	};

	test("selected row paints prefix and label with the text token", () => {
		const row = buildQuizOptionRow(theme as any, {
			index: 0,
			label: "Implement Plan",
			selected: true,
		});
		expect(row.prefix).toBe("[text:> ]");
		expect(row.painted).toBe("[text:1. Implement Plan]");
		expect(row.painted).not.toContain("[dim:");
	});

	test("unselected row uses a plain prefix and the dim token for the label", () => {
		const row = buildQuizOptionRow(theme as any, {
			index: 1,
			label: "Copy Plan",
			selected: false,
		});
		expect(row.prefix).toBe("  ");
		expect(row.painted).toBe("[dim:2. Copy Plan]");
		expect(row.painted).not.toContain("[text:");
	});

	test("description follows the same direction as the label", () => {
		const selected = buildQuizOptionRow(theme as any, {
			index: 0,
			label: "Implement Plan",
			selected: true,
			description: "Continue in code mode.",
		});
		expect(selected.descriptionPainted).toBe("[text:Continue in code mode.]");

		const unselected = buildQuizOptionRow(theme as any, {
			index: 0,
			label: "Implement Plan",
			selected: false,
			description: "Continue in code mode.",
		});
		expect(unselected.descriptionPainted).toBe("[dim:Continue in code mode.]");
	});

	test("option numbering is 1-based and preserved", () => {
		expect(buildQuizOptionRow(theme as any, { index: 0, label: "A", selected: true }).painted).toBe(
			"[text:1. A]",
		);
		expect(buildQuizOptionRow(theme as any, { index: 1, label: "B", selected: false }).painted).toBe(
			"[dim:2. B]",
		);
		expect(
			buildQuizOptionRow(theme as any, { index: 11, label: "L", selected: false }).painted,
		).toBe("[dim:12. L]");
	});

	test("regression: the inverted direction is impossible", () => {
		const selected = buildQuizOptionRow(theme as any, {
			index: 0,
			label: "X",
			selected: true,
			description: "desc",
		});
		expect(selected.prefix).toBe("[text:> ]");
		expect(selected.painted).toBe("[text:1. X]");
		expect(selected.descriptionPainted).toBe("[text:desc]");
		expect(selected.prefix).not.toContain("[dim:");
		expect(selected.painted).not.toContain("[dim:");
		expect(selected.descriptionPainted).not.toContain("[dim:");

		const unselected = buildQuizOptionRow(theme as any, {
			index: 1,
			label: "Y",
			selected: false,
			description: "desc",
		});
		expect(unselected.prefix).toBe("  ");
		expect(unselected.painted).toBe("[dim:2. Y]");
		expect(unselected.descriptionPainted).toBe("[dim:desc]");
		expect(unselected.painted).not.toContain("[text:");
		expect(unselected.descriptionPainted).not.toContain("[text:");
	});
});
