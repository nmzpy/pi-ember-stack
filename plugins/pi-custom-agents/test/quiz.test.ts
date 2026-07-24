import { describe, expect, test } from "bun:test";
import {
	format_answers_for_model,
	format_quiz_call_row,
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
});

describe("should_hide_quiz_call_row", () => {
	test("hides only the in-flight quiz call until answers are rendered", () => {
		expect(should_hide_quiz_call_row("quiz-1", false, "quiz-1")).toBe(true);
		expect(should_hide_quiz_call_row("quiz-1", true, "quiz-1")).toBe(false);
		expect(should_hide_quiz_call_row("quiz-1", false, "quiz-2")).toBe(false);
		expect(should_hide_quiz_call_row("quiz-1", false, undefined)).toBe(false);
	});
});
