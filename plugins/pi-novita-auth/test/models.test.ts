import { describe, expect, test } from "bun:test";
import { build_novita_models, __test_only } from "../src/models.ts";
import type { NovitaModelInfo } from "../src/catalog.ts";

const REASONING_MODEL: NovitaModelInfo = {
	id: "deepseek/deepseek-r1",
	title: "DeepSeek: DeepSeek R1",
	context_size: 131_072,
	input_token_price_per_m: 3900,
	output_token_price_per_m: 3900,
};

const PLAIN_MODEL: NovitaModelInfo = {
	id: "meta-llama/llama-3.3-70b-instruct",
	title: "Meta Llama 3.3 70B Instruct",
	context_size: 131_072,
	input_token_price_per_m: 3900,
	output_token_price_per_m: 3900,
};

describe("build_novita_models", () => {
	test("maps catalog fields into ProviderModelConfig", () => {
		const [model] = build_novita_models([PLAIN_MODEL]);
		expect(model.id).toBe("meta-llama/llama-3.3-70b-instruct");
		expect(model.name).toBe("Meta Llama 3.3 70B Instruct");
		expect(model.api).toBe("openai-completions");
		expect(model.reasoning).toBe(false);
		expect(model.contextWindow).toBe(131_072);
		expect(model.maxTokens).toBe(32_768);
		expect(model.input).toEqual(["text"]);
	});

	test("marks reasoning models and maps thinking levels + compat", () => {
		const [model] = build_novita_models([REASONING_MODEL]);
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

	test("builds cost from per-million-token integer prices (1/10k USD units)", () => {
		const [model] = build_novita_models([REASONING_MODEL]);
		expect(model.cost.input).toBeCloseTo(0.39);
		expect(model.cost.output).toBeCloseTo(0.39);
		expect(model.cost.cacheRead). toBe(0);
		expect(model.cost.cacheWrite).toBe(0);
	});

	test("applies defaults when catalog fields are missing", () => {
		const [model] = build_novita_models([{ id: "mystery", title: "Mystery" }]);
		expect(model.contextWindow).toBe(128_000);
		expect(model.maxTokens).toBe(32_768);
		expect(model.cost.input).toBe(0);
		expect(model.reasoning).toBe(false);
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	test("uses id as name fallback and omits thinking map for plain models", () => {
		const [model] = build_novita_models([{ id: "plain" }]);
		expect(model.name).toBe("plain");
		expect(model.reasoning).toBe(false);
	});

	test("detects reasoning models by id marker", () => {
		expect(__test_only.is_reasoning_model({ id: "qwen/qwq-32b" })).toBe(true);
		expect(__test_only.is_reasoning_model({ id: "qwen/qwen3-235b-thinking" })).toBe(true);
		expect(__test_only.is_reasoning_model({ id: "meta-llama/llama-3.3-70b-instruct" })).toBe(false);
	});
});

describe("parse_cost", () => {
	test("converts integer 1/10k-USD prices and clamps junk to zero", () => {
		expect(__test_only.parse_cost(3900)).toBeCloseTo(0.39);
		expect(__test_only.parse_cost(0)).toBe(0);
		expect(__test_only.parse_cost(undefined)).toBe(0);
		expect(__test_only.parse_cost(-3)).toBe(0);
		expect(__test_only.parse_cost(NaN)).toBe(0);
	});
});
