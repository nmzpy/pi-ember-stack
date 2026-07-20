import { describe, expect, test } from "bun:test";
import { model_name_has_thinking_variant } from "../footer.ts";

describe("model_name_has_thinking_variant", () => {
	test("returns true for model names that already contain a known variant", () => {
		expect(model_name_has_thinking_variant("Grok 4.5 High")).toBe(true);
		expect(model_name_has_thinking_variant("grok-4.5-high")).toBe(true);
		expect(model_name_has_thinking_variant("Claude 4 Max")).toBe(true);
		expect(model_name_has_thinking_variant("claude_4_xhigh")).toBe(true);
		expect(model_name_has_thinking_variant("o3-mini-low")).toBe(true);
		expect(model_name_has_thinking_variant("o3-mini-medium")).toBe(true);
		expect(model_name_has_thinking_variant("o1 Minimal")).toBe(true);
	});

	test("returns false when no known variant token is present", () => {
		expect(model_name_has_thinking_variant("Grok 4.5")).toBe(false);
		expect(model_name_has_thinking_variant("Claude 4")).toBe(false);
		expect(model_name_has_thinking_variant("gpt-4o")).toBe(false);
		expect(model_name_has_thinking_variant("sonnet-4.6-thinking")).toBe(false);
	});

	test("avoids false positives for partial matches", () => {
		expect(model_name_has_thinking_variant("maximally")).toBe(false);
		expect(model_name_has_thinking_variant("highlight")).toBe(false);
		expect(model_name_has_thinking_variant("lowercase")).toBe(false);
		expect(model_name_has_thinking_variant("mediumwell")).toBe(false);
		expect(model_name_has_thinking_variant("highland")).toBe(false);
	});
});
