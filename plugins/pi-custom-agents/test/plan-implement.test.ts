import { describe, expect, test } from "bun:test";
import { build_plan_implement_message_content } from "../plan-implement.ts";

describe("build_plan_implement_message_content", () => {
	test("embeds the approved plan after the directive", () => {
		const out = build_plan_implement_message_content(
			"Task: ship compaction-safe implement",
			"Execute the approved plan now.",
		);
		expect(out).toContain("Execute the approved plan now.");
		expect(out).toContain("Approved plan:");
		expect(out).toContain("Task: ship compaction-safe implement");
	});

	test("returns directive only when plan text is empty", () => {
		expect(build_plan_implement_message_content("", "Directive only.")).toBe("Directive only.");
		expect(build_plan_implement_message_content("   ", "Directive only.")).toBe("Directive only.");
	});
});
