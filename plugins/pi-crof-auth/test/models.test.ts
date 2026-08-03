import { describe, expect, test } from "bun:test";
import { build_crof_models, __test_only } from "../src/models.ts";
import type { CrofModelInfo } from "../src/catalog.ts";

const REASONING_MODEL: CrofModelInfo = {
	id: "deepseek-v4-flash",
	name: "DeepSeek: DeepSeek V4 Flash",
	context_length: 1_000_000,
	max_completion_tokens: 131_072,
	reasoning_effort: true,
	custom_reasoning: true,
	pricing: { prompt: "0.12", completion: "0.21", cache_prompt: "0.003" },
};

const PLAIN_MODEL: CrofModelInfo = {
	id: "deepseek-v3.2",
	name: "DeepSeek: DeepSeek V3.2",
	context_length: 163_840,
	max_completion_tokens: 163_840,
	pricing: { prompt: "0.18", completion: "0.35", cache_prompt: "0.04" },
};

describe("build_crof_models", () => {
	test("maps catalog fields into ProviderModelConfig", () => {
		const [model] = build_crof_models([PLAIN_MODEL]);
		expect(model.id).toBe("deepseek-v3.2");
		expect(model.name).toBe("DeepSeek: DeepSeek V3.2");
		expect(model.api).toBe("openai-completions");
		expect(model.reasoning).toBe(false);
		expect(model.contextWindow).toBe(163_840);
		expect(model.maxTokens).toBe(163_840);
		expect(model.input).toEqual(["text"]);
	});

	test("marks reasoning models and maps thinking levels + compat", () => {
		const [model] = build_crof_models([REASONING_MODEL]);
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
			max: "high",
		});
		expect(model.compat?.supportsReasoningEffort).toBe(true);
		expect(model.compat?.maxTokensField).toBe("max_tokens");
	});

	test("builds cost from per-million-token pricing strings", () => {
		const [model] = build_crof_models([REASONING_MODEL]);
		expect(model.cost.input).toBeCloseTo(0.12);
		expect(model.cost.output).toBeCloseTo(0.21);
		expect(model.cost.cacheRead).toBeCloseTo(0.003);
		expect(model.cost.cacheWrite).toBe(0);
	});

	test("applies defaults when catalog fields are missing", () => {
		const [model] = build_crof_models([{ id: "mystery", name: "Mystery" }]);
		expect(model.contextWindow).toBe(200_000);
		expect(model.maxTokens).toBe(32_000);
		expect(model.cost.input).toBe(0);
		expect(model.reasoning).toBe(false);
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	test("uses id as name fallback and omits thinking map for non-reasoning custom_reasoning=false", () => {
		const [model] = build_crof_models([
			{ id: "plain", custom_reasoning: false },
		]);
		expect(model.name).toBe("plain");
		expect(model.reasoning).toBe(false);
	});
});

describe("parse_cost", () => {
	test("parses positive decimals and clamps junk to zero", () => {
		expect(__test_only.parse_cost("1.5")).toBe(1.5);
		expect(__test_only.parse_cost("0")).toBe(0);
		expect(__test_only.parse_cost(undefined)).toBe(0);
		expect(__test_only.parse_cost("-3")).toBe(0);
		expect(__test_only.parse_cost("abc")).toBe(0);
		expect(__test_only.parse_cost("")).toBe(0);
	});
});
