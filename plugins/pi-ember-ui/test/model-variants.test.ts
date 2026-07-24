import { describe, expect, test } from "bun:test";
import {
	EFFORT_SLIDER_POINTS,
	append_model_class_if_missing,
	build_fast_line_model_ids,
	effort_description,
	effort_from_fast_line_id,
	format_effort_display_label,
	extract_model_class_token,
	extract_variant_token,
	get_baked_thinking_variant,
	is_effort_slider_point,
	is_fast_line_model_id,
	model_name_has_thinking_variant,
	resolve_model_effort_level,
	strip_effort_preserve_fast_class_name,
	strip_for_family_grouping,
	strip_variant_token,
	variant_to_effort_point,
} from "../model-variants.ts";

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
		expect(model_name_has_thinking_variant("Grok 4.5 Fast")).toBe(false);
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

describe("extract_variant_token / strip_variant_token", () => {
	test("extracts and strips Devin Thinking Fast suffixes", () => {
		expect(extract_variant_token("GPT-5.2 High Thinking Fast")).toBe("high");
		expect(extract_variant_token("GPT-5.2 No Thinking")).toBe("no");
		expect(extract_variant_token("GPT-5.2 Medium Thinking")).toBe("medium");
		expect(strip_variant_token("GPT-5.2 High Thinking Fast")).toBe("GPT-5.2");
		expect(strip_variant_token("GPT-5.2 No Thinking")).toBe("GPT-5.2");
		expect(strip_variant_token("gpt-5-2-high-thinking-fast")).toBe("gpt-5-2");
	});

	test("extracts and strips Level Fast speed-tier suffixes", () => {
		expect(extract_variant_token("GPT-5.2-Codex Low Fast")).toBe("low");
		expect(extract_variant_token("GPT-5.2-Codex Medium Fast")).toBe("medium");
		expect(extract_variant_token("GPT-5.2-Codex High Fast")).toBe("high");
		expect(strip_variant_token("GPT-5.2-Codex Low Fast")).toBe("GPT-5.2-Codex");
		expect(strip_variant_token("GPT-5.2-Codex Medium Fast")).toBe("GPT-5.2-Codex");
		expect(strip_variant_token("gpt-5-2-codex-medium-fast")).toBe("gpt-5-2-codex");
	});

	test("extracts trailing id suffixes", () => {
		expect(extract_variant_token("claude-opus-4-7-medium")).toBe("medium");
		expect(extract_variant_token("claude-opus-4-7-high")).toBe("high");
		expect(extract_variant_token("gpt-oss-120b-xhigh")).toBe("xhigh");
		expect(extract_variant_token("claude-opus-4-max")).toBe("max");
		expect(extract_variant_token("o3_mini_low")).toBe("low");
	});

	test("extracts parenthetical and spaced name variants", () => {
		expect(extract_variant_token("GPT-OSS 120B (Medium)")).toBe("medium");
		expect(extract_variant_token("Grok 4.5 High")).toBe("high");
	});

	test("does not extract mid-string false positives", () => {
		expect(extract_variant_token("highlight")).toBeUndefined();
		expect(extract_variant_token("sonnet-4.6-thinking")).toBeUndefined();
		expect(extract_variant_token("gemini-3.5-flash")).toBeUndefined();
		expect(strip_variant_token("sonnet-4.6-thinking")).toBe("sonnet-4.6-thinking");
	});

	test("strips trailing variants from ids and names", () => {
		expect(strip_variant_token("claude-opus-4-7-medium")).toBe("claude-opus-4-7");
		expect(strip_variant_token("GPT-OSS 120B (Medium)")).toBe("GPT-OSS 120B");
		expect(strip_variant_token("Grok 4.5 High")).toBe("Grok 4.5");
		expect(strip_variant_token("gemini-3.5-flash")).toBe("gemini-3.5-flash");
	});

	test("model class Fast is separate from effort variants", () => {
		expect(extract_model_class_token("Grok 4.5 Fast")).toBe("fast");
		expect(extract_model_class_token("grok-4.5-fast")).toBe("fast");
		expect(extract_model_class_token("Grok 4.5 Fast High")).toBe("fast");
		expect(extract_model_class_token("GPT-5.2-Codex Low Fast")).toBeUndefined();
		expect(extract_model_class_token("gemini-3.5-flash")).toBeUndefined();
		expect(strip_for_family_grouping("Grok 4.5 Fast High")).toBe("Grok 4.5 Fast");
		expect(strip_for_family_grouping("Grok 4.5 High")).toBe("Grok 4.5");
		expect(
			strip_for_family_grouping("Grok 4.5 High", "fast"),
		).toBe("Grok 4.5 Fast");
		expect(append_model_class_if_missing("Grok 4.5", "fast")).toBe("Grok 4.5 Fast");
	});

	test("fast line ids pair with plain effort siblings (Cursor Grok shape)", () => {
		const catalog = [
			{ id: "cursor-grok-4.5-high" },
			{ id: "cursor-grok-4.5-high-fast" },
			{ id: "cursor-grok-4.5-medium-fast" },
		];
		const fastLine = build_fast_line_model_ids(catalog);
		expect(is_fast_line_model_id("cursor-grok-4.5-high-fast", fastLine)).toBe(true);
		expect(is_fast_line_model_id("cursor-grok-4.5-high", fastLine)).toBe(false);
		expect(effort_from_fast_line_id("cursor-grok-4.5-high-fast")).toBe("high");
		expect(strip_effort_preserve_fast_class_name("Cursor Grok 4.5 Medium Fast")).toBe(
			"Cursor Grok 4.5 Fast",
		);
		expect(extract_model_class_token("claude-4.5-sonnet-thinking")).toBe("thinking");
		expect(extract_model_class_token("gpt-5-2-high-thinking-fast")).toBeUndefined();
	});
});

describe("effort helpers", () => {
	test("slider points are low/medium/high/xhigh/max", () => {
		expect([...EFFORT_SLIDER_POINTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	test("variant_to_effort_point maps slider tokens only", () => {
		expect(variant_to_effort_point("high")).toBe("high");
		expect(variant_to_effort_point("max")).toBe("max");
		expect(variant_to_effort_point("minimal")).toBeUndefined();
	});

	test("is_effort_slider_point and descriptions", () => {
		expect(is_effort_slider_point("medium")).toBe(true);
		expect(is_effort_slider_point("max")).toBe(true);
		expect(effort_description("medium")).toContain("Balanced");
		expect(effort_description("max")).toContain("Highest effort");
	});

	test("format_effort_display_label title-cases effort points", () => {
		expect(format_effort_display_label("low")).toBe("Low");
		expect(format_effort_display_label("medium")).toBe("Medium");
		expect(format_effort_display_label("high")).toBe("High");
		expect(format_effort_display_label("xhigh")).toBe("xHigh");
		expect(format_effort_display_label("max")).toBe("Max");
	});

	test("resolve_model_effort_level reads Pi level and catalog siblings", () => {
		expect(resolve_model_effort_level(undefined, "high")).toBe("high");
		expect(
			resolve_model_effort_level(
				{ id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5" },
				"off",
			),
		).toBe("high");
		expect(
			resolve_model_effort_level(
				{ id: "cursor-grok-4.5-medium", name: "Cursor Grok 4.5 Medium" },
				"off",
			),
		).toBe("medium");
		expect(
			resolve_model_effort_level(
				{ id: "cursor-grok-4.5-high-fast", name: "Cursor Grok 4.5 Fast" },
				"off",
			),
		).toBe("high");
		expect(
			resolve_model_effort_level(
				{ id: "claude-opus-4-max", name: "Claude 4 Max" },
				"off",
			),
		).toBe("max");
	});

	test("get_baked_thinking_variant still finds max/minimal", () => {
		expect(get_baked_thinking_variant("Claude 4 Max")).toBe("max");
		expect(get_baked_thinking_variant("o1 Minimal")).toBe("minimal");
	});
});
