import { describe, expect, test } from "bun:test";
import {
	bind_mode_model,
	bound_identity_uses_baked_effort,
	bound_model_matches_live,
	canonical_model_identity,
	canonicalize_persisted_identity,
	identities_equal,
	model_identity_of,
	model_identity_from_user_selection,
	normalize_mode_models,
	normalize_thinking_level,
} from "../mode-models.ts";

describe("mode-models persistence", () => {
	test("normalize_mode_models reads optional thinkingLevel", () => {
		const models = normalize_mode_models({
			code: { provider: "openai-codex", modelId: "gpt-5", thinkingLevel: "high" },
			plan: { provider: "cursor", modelId: "auto" },
		});
		expect(models.code).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5",
			thinkingLevel: "high",
		});
		expect(models.plan).toEqual({ provider: "cursor", modelId: "auto" });
	});

	test("normalize_thinking_level rejects unknown values", () => {
		expect(normalize_thinking_level("HIGH")).toBe("high");
		expect(normalize_thinking_level("bogus")).toBeUndefined();
	});

	test("identities_equal compares thinkingLevel", () => {
		const base = { provider: "p", modelId: "m" };
		expect(identities_equal(base, { ...base, thinkingLevel: "high" })).toBe(false);
		expect(
			identities_equal(
				{ ...base, thinkingLevel: "high" },
				{ ...base, thinkingLevel: "high" },
			),
		).toBe(true);
	});

	test("bound_model_matches_live includes thinking level", () => {
		const bound = { provider: "p", modelId: "m", thinkingLevel: "medium" };
		const model = { provider: "p", id: "m", name: "M" } as any;
		expect(bound_model_matches_live(bound, model, "medium")).toBe(true);
		expect(bound_model_matches_live(bound, model, "low")).toBe(false);
	});

	test("bind_mode_model preserves thinkingLevel", () => {
		const next = bind_mode_model({}, "code", {
			provider: "p",
			modelId: "m",
			thinkingLevel: "xhigh",
		});
		expect(next.code?.thinkingLevel).toBe("xhigh");
	});

	test("model_identity_of attaches normalized thinking level", () => {
		expect(
			model_identity_of({ provider: "p", id: "m" } as any, "MAX"),
		).toEqual({ provider: "p", modelId: "m", thinkingLevel: "max" });
	});

	test("baked catalog variants persist exact id without thinkingLevel", () => {
		const fast = {
			provider: "cursor",
			id: "cursor-grok-4.5-high-fast",
			name: "Cursor Grok 4.5 Fast",
		} as any;
		expect(model_identity_of(fast, "high")).toEqual({
			provider: "cursor",
			modelId: "cursor-grok-4.5-high-fast",
		});
		expect(bound_identity_uses_baked_effort({ provider: "cursor", modelId: fast.id })).toBe(
			true,
		);
	});

	test("normalize strips redundant thinkingLevel from baked variant bindings", () => {
		const models = normalize_mode_models({
			code: {
				provider: "cursor",
				modelId: "cursor-grok-4.5-high-fast",
				thinkingLevel: "high",
			},
			plan: {
				provider: "cursor",
				modelId: "cursor-grok-4.5-medium",
				thinkingLevel: "medium",
			},
		});
		expect(models.code).toEqual({
			provider: "cursor",
			modelId: "cursor-grok-4.5-high-fast",
		});
		expect(models.plan).toEqual({
			provider: "cursor",
			modelId: "cursor-grok-4.5-medium",
		});
	});

	test("bound_model_matches_live ignores spurious thinkingLevel on baked variants", () => {
		const bound = {
			provider: "cursor",
			modelId: "cursor-grok-4.5-high-fast",
			thinkingLevel: "high",
		};
		const live = {
			provider: "cursor",
			id: "cursor-grok-4.5-high-fast",
			name: "Cursor Grok 4.5 Fast",
		} as any;
		expect(bound_model_matches_live(bound, live, "off")).toBe(true);
		expect(
			identities_equal(
				canonicalize_persisted_identity(bound),
				canonical_model_identity({ provider: "cursor", id: live.id, name: live.name }, "off"),
			),
		).toBe(true);
	});

	test("different baked variants do not match across modes", () => {
		const codeBound = { provider: "cursor", modelId: "cursor-grok-4.5-high-fast" };
		const planLive = {
			provider: "cursor",
			id: "cursor-grok-4.5-medium",
			name: "Cursor Grok 4.5 Medium",
		} as any;
		expect(bound_model_matches_live(codeBound, planLive, "medium")).toBe(false);
	});

	test("model_identity_from_user_selection keeps xhigh for thinkingLevelMap picks", () => {
		expect(
			model_identity_from_user_selection(
				{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
				{ thinkingLevel: "xhigh", syncThinkingLevelToPi: true },
			),
		).toEqual({
			provider: "openai",
			modelId: "gpt-5.6-luna",
			thinkingLevel: "xhigh",
		});
		expect(
			model_identity_from_user_selection(
				{ provider: "openai", id: "gpt-5.6-luna-xhigh", name: "GPT-5.6 Luna xHigh" },
				{ thinkingLevel: "xhigh", syncThinkingLevelToPi: false },
			),
		).toEqual({
			provider: "openai",
			modelId: "gpt-5.6-luna-xhigh",
		});
	});
});
