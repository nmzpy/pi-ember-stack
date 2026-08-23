import { describe, expect, test } from "bun:test";
import {
	arm_plan_turn,
	build_plan_implementation_questions,
	build_plan_review_questions,
	resolve_plan_implementation_mode,
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

	test("accepts natural markdown plan sections the ARCHITECT_PROMPT produces", () => {
		// The plan prompt no longer forces labeled-line templates; the model
		// emits natural markdown sections. The detector must recognize them so
		// the Plan Review fires after a quiz-then-plan turn.
		expect(should_show_plan_review("## Summary\n\nShip the guard.")).toBe(true);
		expect(should_show_plan_review("## Problems\n\n- X is broken")).toBe(true);
		expect(should_show_plan_review("## Behavior\n\nNew flow.")).toBe(true);
		expect(should_show_plan_review("## Modules\n\n- Module 1\n- Module 2")).toBe(true);
		expect(should_show_plan_review("### Module 1: caching\n\nAdd cache.")).toBe(true);
		expect(should_show_plan_review("## Investigation\n\nFound X at file:line.")).toBe(true);
		expect(should_show_plan_review("## Test Plan\n\nRun t.gate.sh.")).toBe(true);
		expect(should_show_plan_review("## Working Tree\n\nClean.")).toBe(true);
		expect(should_show_plan_review("## Acceptance Criteria\n\n- Guard fires")).toBe(true);
		expect(should_show_plan_review("## Plan\n\nDo the thing.")).toBe(true);
		expect(should_show_plan_review("Module 1: caching\n\nAdd cache.")).toBe(true);
	});

	test("rejects greetings and empty plan text", () => {
		expect(should_show_plan_review("")).toBe(false);
		expect(should_show_plan_review("Hi — what would you like to work on?")).toBe(false);
		expect(
			should_show_plan_review(
				"The user sent a simple greeting.\n\nHi — what would you like to work on?",
			),
		).toBe(false);
		// A plain prose answer with no plan structure must not trigger the review.
		expect(
			should_show_plan_review(
				"I looked at the code. The function is fine as-is, no changes needed.",
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

describe("plan implementation mode", () => {
	test("uses one Code/Orchestrate picker for both implementation paths", () => {
		const [question] = build_plan_implementation_questions();
		expect(question.options.map((option) => option.value)).toEqual([
			"code",
			"orchestrate",
		]);
		expect(question.options.map((option) => option.label)).toEqual(["Code", "Orchestrate"]);
	});

	test("resolves the selected implementation mode", () => {
		expect(resolve_plan_implementation_mode({ value: "code" })).toBe("code");
		expect(resolve_plan_implementation_mode({ value: "orchestrate" })).toBe("orchestrate");
		expect(resolve_plan_implementation_mode(undefined)).toBeUndefined();
	});
});
