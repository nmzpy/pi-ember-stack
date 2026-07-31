import { describe, expect, test } from "bun:test";
import {
	build_model_families,
	type FamilyModel,
} from "../model-families.ts";
import {
	recent_identities_from_mode_models,
	rank_families_by_recents,
} from "../model-recent.ts";

const MODELS: FamilyModel[] = [
	{ provider: "openai", id: "gpt-5" },
	{ provider: "openai", id: "gpt-5-mini" },
	{ provider: "anthropic", id: "claude-opus-4" },
	{ provider: "anthropic", id: "claude-sonnet-4" },
	{ provider: "devin", id: "devin-coder" },
];

describe("recent_identities_from_mode_models", () => {
	test("collects unique identities, current mode first", () => {
		const modeModels = {
			code: { provider: "openai", modelId: "gpt-5" },
			plan: { provider: "anthropic", modelId: "claude-opus-4" },
			debug: { provider: "openai", modelId: "gpt-5" },
		};
		const recents = recent_identities_from_mode_models(modeModels, "plan");
		expect(recents).toEqual([
			{ provider: "anthropic", id: "claude-opus-4" },
			{ provider: "openai", id: "gpt-5" },
		]);
	});

	test("skips malformed entries", () => {
		const modeModels = {
			code: { provider: "openai", modelId: "gpt-5" },
			bad: { provider: 123, modelId: true } as unknown as { provider: string; modelId: string },
		};
		expect(recent_identities_from_mode_models(modeModels, "code")).toEqual([
			{ provider: "openai", id: "gpt-5" },
		]);
	});

	test("empty map yields empty list", () => {
		expect(recent_identities_from_mode_models(undefined)).toEqual([]);
	});
});

describe("rank_families_by_recents", () => {
	test("puts recently used families at the top", () => {
		const families = build_model_families(MODELS);
		const ranked = rank_families_by_recents(families, [
			{ provider: "devin", id: "devin-coder" },
			{ provider: "anthropic", id: "claude-opus-4" },
		]);
		expect(ranked[0].provider).toBe("anthropic");
		expect(ranked[1].provider).toBe("devin");
	});

	test("drops missing recents and keeps catalog order for the rest", () => {
		const families = build_model_families(MODELS);
		const ranked = rank_families_by_recents(families, [
			{ provider: "missing", id: "no-such" },
		]);
		const providers = ranked.map((f) => f.provider);
		expect(providers).toEqual(families.map((f) => f.provider));
	});
});
