import { describe, expect, test } from "bun:test";
import { format_answers_for_model, type QuizQuestion } from "../quiz-tool.ts";

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
