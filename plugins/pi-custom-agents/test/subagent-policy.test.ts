import { describe, expect, test } from "bun:test";
import {
	infer_bare_agent_name,
	is_scout_agent_name,
	validate_plan_mode_subagent,
} from "../subagent-policy.ts";
import { LEGACY_SUBAGENT_RESUME_TOOL_NAME, SUBAGENT_RESUME_TOOL_NAME } from "../edit-tools.ts";

describe("infer_bare_agent_name", () => {
	test("strips letter suffix from display names", () => {
		expect(infer_bare_agent_name("Coder A")).toBe("Coder");
		expect(infer_bare_agent_name("Scout B")).toBe("Scout");
	});

	test("returns trimmed bare name when no suffix", () => {
		expect(infer_bare_agent_name("  Scout  ")).toBe("Scout");
	});
});

describe("is_scout_agent_name", () => {
	test("accepts Scout and lettered Scout names case-insensitively", () => {
		expect(is_scout_agent_name("Scout")).toBe(true);
		expect(is_scout_agent_name("scout")).toBe(true);
		expect(is_scout_agent_name("Scout A")).toBe(true);
	});

	test("rejects Coder and other agents", () => {
		expect(is_scout_agent_name("Coder")).toBe(false);
		expect(is_scout_agent_name("Coder A")).toBe(false);
		expect(is_scout_agent_name("Reviewer")).toBe(false);
	});
});

describe("validate_plan_mode_subagent", () => {
	test("allows Scout single, parallel, and chain calls", () => {
		expect(
			validate_plan_mode_subagent("subagent", { agent: "Scout", task: "find auth" }),
		).toBeUndefined();
		expect(
			validate_plan_mode_subagent("subagent", {
				tasks: [{ agent: "Scout", task: "a" }, { agent: "scout", task: "b" }],
			}),
		).toBeUndefined();
		expect(
			validate_plan_mode_subagent("subagent", {
				chain: [{ agent: "Scout", task: "a" }, { agent: "Scout", task: "b" }],
			}),
		).toBeUndefined();
		expect(
			validate_plan_mode_subagent(SUBAGENT_RESUME_TOOL_NAME, {
				agent: "Scout A",
				task: "continue",
			}),
		).toBeUndefined();
		expect(
			validate_plan_mode_subagent(LEGACY_SUBAGENT_RESUME_TOOL_NAME, {
				agent: "Scout A",
				task: "continue",
			}),
		).toBeUndefined();
	});

	test("blocks Coder and mixed parallel batches", () => {
		const coder = validate_plan_mode_subagent("subagent", { agent: "Coder", task: "fix" });
		expect(coder?.block).toBe(true);
		expect(coder?.reason).toContain("Coder");

		const mixed = validate_plan_mode_subagent("subagent", {
			tasks: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }],
		});
		expect(mixed?.block).toBe(true);
		expect(mixed?.reason).toContain("Coder");

		const resume = validate_plan_mode_subagent(SUBAGENT_RESUME_TOOL_NAME, {
			agent: "Coder A",
			task: "continue",
		});
		expect(resume?.block).toBe(true);
	});

	test("ignores unrelated tools", () => {
		expect(validate_plan_mode_subagent("read", { path: "x" })).toBeUndefined();
	});
});
