/**
 * Plan-review arming helpers (SSOT).
 *
 * `waitingForPlan` must be true before `agent_settled` so the Plan Review
 * quiz can open. It is armed on every fresh plan agent run — not only on the
 * first mode-enter turn (resume/toggle can leave lastMessagedMode === plan).
 * Output-limit auto-continue uses prompt === "continue" and must not re-arm
 * or clear accumulated plan text.
 */

import type { QuizQuestion } from "./quiz-tool.ts";

/** Labeled `Goal:` / `Task:` lines or the plan-mode `## Task` section header. */
const PLAN_GOAL_LABEL = /^\s*Goal\s*:/im;
const PLAN_TASK_LABEL = /^\s*Task\s*:/im;
const PLAN_TASK_SECTION = /^\s*##\s+Task\b/im;

export type PlanReviewAction =
	| "implement"
	| "implement-fresh"
	| "copy"
	| { action: "refine"; instruction: string };

export type PlanImplementationMode = "code" | "orchestrate";

/** Plan Review quiz screen — SSOT for options and labels. */
export function build_plan_review_questions(): QuizQuestion[] {
	return [
		{
			id: "plan-review",
			label: "Plan Review",
			prompt: "Choose what to do with the plan.",
			options: [
				{ value: "implement", label: "Implement Plan" },
				{
					value: "implement-fresh",
					label: "Implement with fresh context",
					description: "Start a new session with the plan pasted in, then choose Code or Orchestrate.",
				},
				{ value: "copy", label: "Copy Plan" },
			],
		},
	];
}

export function resolve_plan_review_answer(
	answer: { value: string; wasCustom: boolean } | undefined,
): PlanReviewAction | undefined {
	if (!answer) return undefined;
	if (answer.value === "implement") return "implement";
	if (answer.value === "implement-fresh") return "implement-fresh";
	if (answer.value === "copy") return "copy";
	if (answer.wasCustom && answer.value) {
		return { action: "refine", instruction: answer.value };
	}
	return undefined;
}

/** SSOT for the mode picker shared by same-session and fresh-context implementation. */
export function build_plan_implementation_questions(): QuizQuestion[] {
	return [
		{
			id: "implement-via",
			label: "Implement",
			prompt: "Implement the plan via which mode?",
			options: [
				{
					value: "code",
					label: "Code",
					description: "Execute the plan with full tool access.",
				},
				{
					value: "orchestrate",
					label: "Orchestrate",
					description: "Delegate the plan to subagents.",
				},
			],
		},
	];
}

export function resolve_plan_implementation_mode(
	answer: { value: string } | undefined,
): PlanImplementationMode | undefined {
	if (answer?.value === "code") return "code";
	if (answer?.value === "orchestrate") return "orchestrate";
	return undefined;
}

/** True when the assistant produced structured plan output, not casual chat. */
export function should_show_plan_review(plan_text: string): boolean {
	const text = plan_text.trim();
	if (!text) return false;
	return (
		PLAN_GOAL_LABEL.test(text) ||
		PLAN_TASK_LABEL.test(text) ||
		PLAN_TASK_SECTION.test(text)
	);
}

export function arm_plan_turn(
	current_mode: string,
	prompt: string | undefined,
): { armed: boolean; clear_plan_text: boolean } {
	if (current_mode !== "plan" || prompt === "continue") {
		return { armed: false, clear_plan_text: false };
	}
	return { armed: true, clear_plan_text: true };
}
