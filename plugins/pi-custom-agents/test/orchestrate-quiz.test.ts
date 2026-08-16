import { describe, expect, test } from "bun:test";
import {
	mode_tools_for_provider,
	ORCHESTRATE_TOOLS,
	ORCHESTRATOR_PROMPT,
	QUIZ_UNCERTAINTY_GUIDANCE,
} from "../index.ts";
import { registerQuizTool } from "../quiz-tool.ts";

/**
 * Quiz-in-Orchestrate guarantee (SSOT): Orchestrate must advertise quiz in its
 * canonical allowlist, permit quiz through the same allowlist in the tool_call
 * guard, consume the one QUIZ_UNCERTAINTY_GUIDANCE constant in its prompt, and
 * register the quiz tool exactly once. These tests pin those invariants so a
 * future change cannot silently drop quiz from Orchestrate or fork the
 * guidance text.
 */
describe("Quiz-in-Orchestrate guarantee (SSOT)", () => {
	test("ORCHESTRATE_TOOLS is the canonical Orchestrate allowlist and includes quiz", () => {
		expect(ORCHESTRATE_TOOLS).toContain("quiz");
		expect(ORCHESTRATE_TOOLS).toContain("subagent");
		// Orchestrate is read-only: no mutation tools, so quiz is the way to
		// resolve material uncertainty before delegating.
		expect(ORCHESTRATE_TOOLS).not.toContain("edit");
		expect(ORCHESTRATE_TOOLS).not.toContain("write");
		expect(ORCHESTRATE_TOOLS).not.toContain("apply_patch");
	});

	test("orchestrate tool resolution returns the same canonical allowlist", () => {
		for (const provider of ["devin", "openai-codex", undefined]) {
			expect(mode_tools_for_provider("orchestrate", provider)).toBe(ORCHESTRATE_TOOLS);
		}
		// The tool_call guard derives active tools from this resolver, so quiz is
		// permitted in Orchestrate (not just advertised) via the same source.
		expect(mode_tools_for_provider("orchestrate", "devin")).toContain("quiz");
	});

	test("ORCHESTRATOR_PROMPT consumes the one QUIZ_UNCERTAINTY_GUIDANCE constant", () => {
		expect(ORCHESTRATOR_PROMPT).toContain(QUIZ_UNCERTAINTY_GUIDANCE);
	});

	test("ORCHESTRATOR_PROMPT advertises the canonical Orchestrate allowlist", () => {
		const advertised = [...ORCHESTRATE_TOOLS].sort().join(", ");
		expect(ORCHESTRATOR_PROMPT).toContain(`Available tools: ${advertised}`);
	});

	test("quiz tool registers exactly once", () => {
		const registered: string[] = [];
		const fakePi = {
			registerTool: (definition: { name: string }): void => {
				registered.push(definition.name);
			},
			on: (): void => {},
		};
		registerQuizTool(fakePi as never);
		expect(registered.filter((name) => name === "quiz")).toEqual(["quiz"]);
	});
});
