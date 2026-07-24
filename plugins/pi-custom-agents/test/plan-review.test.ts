import { describe, expect, test } from "bun:test";
import {
	arm_plan_turn,
	build_plan_review_questions,
	resolve_plan_review_answer,
	should_show_plan_review,
} from "../plan-review.ts";

describe("arm_plan_turn", () => {
	test("arms every fresh plan agent run", () => {
		expect(arm_plan_turn("plan", undefined)).toEqual({
			armed: true,
			clear_plan_text: true,
		});
		expect(arm_plan_turn("plan", "user")).toEqual({
			armed: true,
			clear_plan_text: true,
		});
	});

	test("does not arm output-limit auto-continue", () => {
		expect(arm_plan_turn("plan", "continue")).toEqual({
			armed: false,
			clear_plan_text: false,
		});
	});

	test("does not arm non-plan modes", () => {
		expect(arm_plan_turn("code", undefined)).toEqual({
			armed: false,
			clear_plan_text: false,
		});
	});
});

describe("should_show_plan_review", () => {
	test("accepts Goal, Task labels, and ## Task section headers", () => {
		expect(should_show_plan_review("Goal: ship plan review guard")).toBe(true);
		expect(should_show_plan_review("Task: add caching layer")).toBe(true);
		expect(should_show_plan_review("## Task\n\nAdd caching.")).toBe(true);
	});

	test("rejects greetings and empty plan text", () => {
		expect(should_show_plan_review("")).toBe(false);
		expect(should_show_plan_review("Hi — what would you like to work on?")).toBe(false);
		expect(
			should_show_plan_review(
				"The user sent a simple greeting.\n\nHi — what would you like to work on?",
			),
		).toBe(false);
	});
});

describe("build_plan_review_questions", () => {
	test("includes implement with fresh context option", () => {
		const [question] = build_plan_review_questions();
		expect(question.options.map((option) => option.value)).toEqual([
			"implement",
			"implement-fresh",
			"copy",
		]);
		expect(question.options[1]?.label).toBe("Implement with fresh context");
	});
});

describe("resolve_plan_review_answer", () => {
	test("maps quiz answers to plan review actions", () => {
		expect(resolve_plan_review_answer({ value: "implement", wasCustom: false })).toBe(
			"implement",
		);
		expect(resolve_plan_review_answer({ value: "implement-fresh", wasCustom: false })).toBe(
			"implement-fresh",
		);
		expect(resolve_plan_review_answer({ value: "copy", wasCustom: false })).toBe("copy");
		expect(
			resolve_plan_review_answer({ value: "tighten scope", wasCustom: true }),
		).toEqual({
			action: "refine",
			instruction: "tighten scope",
		});
	});
});
