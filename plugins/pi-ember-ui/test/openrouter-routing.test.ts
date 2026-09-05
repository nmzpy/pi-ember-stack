import { describe, expect, test } from "bun:test";
import {
	OPENROUTER_PROVIDER_AUTO,
	apply_openrouter_routing,
	build_openrouter_routing,
	fetch_openrouter_upstreams,
	format_upstream_label,
	is_openrouter_model,
	live_openrouter_provider,
	openrouter_endpoints_path,
} from "../openrouter-routing.ts";
import { canonical_model_identity, identities_equal, normalize_mode_models } from "../../pi-custom-agents/mode-models.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

function make_model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "anthropic/claude-haiku-4.5",
		name: "Anthropic: Claude Haiku 4.5",
		api: "openai-completions" as Api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		compat: { thinkingFormat: "openrouter" },
		...overrides,
	} as Model<Api>;
}

describe("openrouter_endpoints_path", () => {
	test("splits author/slug ids", () => {
		expect(openrouter_endpoints_path("anthropic/claude-haiku-4.5")).toBe("anthropic/claude-haiku-4.5");
		expect(openrouter_endpoints_path("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
	});

	test("keeps :variant suffixes in the slug", () => {
		expect(openrouter_endpoints_path("meta-llama/llama-3.3-70b-instruct:free")).toBe(
			"meta-llama/llama-3.3-70b-instruct:free",
		);
		expect(openrouter_endpoints_path("anthropic/claude-opus-4.7:batch")).toBe(
			"anthropic/claude-opus-4.7:batch",
		);
	});

	test("rejects ids without a slash", () => {
		expect(openrouter_endpoints_path("gpt-4o")).toBeUndefined();
		expect(openrouter_endpoints_path("")).toBeUndefined();
		expect(openrouter_endpoints_path("/slug")).toBeUndefined();
		expect(openrouter_endpoints_path("author/")).toBeUndefined();
	});
});

describe("is_openrouter_model", () => {
	test("true only for the openrouter provider", () => {
		expect(is_openrouter_model({ provider: "openrouter" })).toBe(true);
		expect(is_openrouter_model({ provider: "anthropic" })).toBe(false);
		expect(is_openrouter_model(undefined)).toBe(false);
		expect(is_openrouter_model(null)).toBe(false);
	});
});

describe("build_openrouter_routing", () => {
	test("returns undefined for Auto and empty", () => {
		expect(build_openrouter_routing(OPENROUTER_PROVIDER_AUTO)).toBeUndefined();
		expect(build_openrouter_routing("")).toBeUndefined();
	});

	test("pins a single upstream with fallbacks disabled", () => {
		const routing = build_openrouter_routing("amazon-bedrock/us");
		expect(routing).toEqual({ only: ["amazon-bedrock/us"], allow_fallbacks: false });
	});
});

describe("apply_openrouter_routing", () => {
	test("returns the original model for Auto (no churn)", () => {
		const model = make_model();
		expect(apply_openrouter_routing(model, undefined)).toBe(model);
	});

	test("clones with merged compat preserving existing fields", () => {
		const model = make_model();
		const routed = apply_openrouter_routing(model, { only: ["anthropic"], allow_fallbacks: false });
		expect(routed).not.toBe(model);
		expect(routed.compat?.openRouterRouting).toEqual({ only: ["anthropic"], allow_fallbacks: false });
		// Existing compat field preserved.
		expect((routed.compat as { thinkingFormat?: string }).thinkingFormat).toBe("openrouter");
	});

	test("clones with compat when the model had none", () => {
		const model = make_model({ compat: undefined });
		const routed = apply_openrouter_routing(model, { only: ["google-vertex"], allow_fallbacks: false });
		expect(routed.compat?.openRouterRouting).toEqual({ only: ["google-vertex"], allow_fallbacks: false });
	});
});

describe("live_openrouter_provider", () => {
	test("reads the first only entry", () => {
		const model = make_model({
			compat: { openRouterRouting: { only: ["anthropic"], allow_fallbacks: false } } as never,
		});
		expect(live_openrouter_provider(model)).toBe("anthropic");
	});

	test("undefined when no routing override", () => {
		const model = make_model();
		expect(live_openrouter_provider(model)).toBeUndefined();
	});

	test("undefined for non-openrouter models even with routing", () => {
		const model = make_model({
			provider: "anthropic",
			compat: { openRouterRouting: { only: ["anthropic"] } } as never,
		});
		expect(live_openrouter_provider(model)).toBeUndefined();
	});

	test("undefined for empty only array", () => {
		const model = make_model({
			compat: { openRouterRouting: { only: [] } } as never,
		});
		expect(live_openrouter_provider(model)).toBeUndefined();
	});
});

describe("format_upstream_label", () => {
	test("includes provider name, tag, prices, and quantization", () => {
		expect(
			format_upstream_label({
				tag: "amazon-bedrock/us",
				providerName: "Amazon Bedrock",
				quantization: "fp16",
				promptPrice: "0.0000011",
				completionPrice: "0.0000055",
			}),
	).toBe("Amazon Bedrock  (amazon-bedrock/us)  in 0.0000011 out 0.0000055  fp16");
	});

	test("omits tag when it equals provider name", () => {
		expect(
			format_upstream_label({ tag: "anthropic", providerName: "anthropic" }),
		).toBe("anthropic");
	});

	test("omits unknown quantization", () => {
		expect(
			format_upstream_label({
				tag: "anthropic",
				providerName: "Anthropic",
				quantization: "unknown",
			}),
		).toBe("Anthropic  (anthropic)");
	});
});

describe("fetch_openrouter_upstreams", () => {
	test("returns empty for ids without a slash path", async () => {
		expect(await fetch_openrouter_upstreams("gpt-4o")).toEqual([]);
	});

	test("parses and dedupes endpoints from a mocked response", async () => {
		const fetchImpl = (async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					data: {
						endpoints: [
							{ tag: "anthropic", provider_name: "Anthropic", pricing: { prompt: "0.000001", completion: "0.000005" } },
							{ tag: "google-vertex/global", provider_name: "Google", pricing: { prompt: "0.000001" } },
							{ tag: "anthropic", provider_name: "Anthropic" },
							{ provider_name: "No Tag" },
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
		const upstreams = await fetch_openrouter_upstreams("anthropic/claude-haiku-4.5", { fetchImpl });
		expect(upstreams).toEqual([
			{ tag: "anthropic", providerName: "Anthropic", promptPrice: "0.000001", completionPrice: "0.000005" },
			{ tag: "google-vertex/global", providerName: "Google", promptPrice: "0.000001" },
		]);
	});

	test("returns empty on non-200", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		expect(await fetch_openrouter_upstreams("anthropic/claude-haiku-4.5", { fetchImpl })).toEqual([]);
	});

	test("returns empty on network error", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await fetch_openrouter_upstreams("anthropic/claude-haiku-4.5", { fetchImpl })).toEqual([]);
	});
});

describe("ModelIdentity openRouterProvider persistence", () => {
	test("canonical_model_identity preserves openRouterProvider for openrouter models", () => {
		const identity = canonical_model_identity(
			{ provider: "openrouter", id: "anthropic/claude-haiku-4.5" },
			"high",
			"amazon-bedrock/us",
		);
		expect(identity).toEqual({
			provider: "openrouter",
			modelId: "anthropic/claude-haiku-4.5",
			thinkingLevel: "high",
			openRouterProvider: "amazon-bedrock/us",
		});
	});

	test("canonical_model_identity drops openRouterProvider for non-openrouter models", () => {
		const identity = canonical_model_identity(
			{ provider: "anthropic", id: "claude-haiku-4.5" },
			"high",
			"amazon-bedrock/us",
		);
		expect(identity?.openRouterProvider).toBeUndefined();
	});

	test("canonical_model_identity drops the Auto sentinel", () => {
		const identity = canonical_model_identity(
			{ provider: "openrouter", id: "anthropic/claude-haiku-4.5" },
			undefined,
			OPENROUTER_PROVIDER_AUTO,
		);
		expect(identity?.openRouterProvider).toBeUndefined();
	});

	test("identities_equal compares openRouterProvider", () => {
		const base = { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" };
		expect(identities_equal(base, { ...base, openRouterProvider: "anthropic" })).toBe(false);
		expect(
			identities_equal(
				{ ...base, openRouterProvider: "anthropic" },
				{ ...base, openRouterProvider: "anthropic" },
			),
		).toBe(true);
		expect(
			identities_equal(
				{ ...base, openRouterProvider: "anthropic" },
				{ ...base, openRouterProvider: "google-vertex" },
			),
		).toBe(false);
	});

	test("normalize_mode_models reads openRouterProvider", () => {
		const models = normalize_mode_models({
			code: {
				provider: "openrouter",
				modelId: "anthropic/claude-haiku-4.5",
				openRouterProvider: "amazon-bedrock/us",
			},
		});
		expect(models.code?.openRouterProvider).toBe("amazon-bedrock/us");
	});

	test("normalize_mode_models strips openRouterProvider from non-openrouter bindings", () => {
		const models = normalize_mode_models({
			code: {
				provider: "anthropic",
				modelId: "claude-haiku-4.5",
				openRouterProvider: "amazon-bedrock/us",
			},
		});
		expect(models.code?.openRouterProvider).toBeUndefined();
	});
});
