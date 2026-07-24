import { describe, expect, test } from "bun:test";
import {
	build_model_families,
	efforts_from_thinking_level_map,
	family_contains_model,
	initial_effort_for_family,
	nearest_effort,
	resolve_family_selection,
} from "../model-families.ts";

describe("build_model_families", () => {
	test("collapses Devin Thinking / Thinking Fast label variants", () => {
		const families = build_model_families([
			{
				provider: "devin",
				id: "gpt-5-2-high-thinking-fast",
				name: "GPT-5.2 High Thinking Fast",
			},
			{
				provider: "devin",
				id: "gpt-5-2-low-thinking-fast",
				name: "GPT-5.2 Low Thinking Fast",
			},
			{
				provider: "devin",
				id: "gpt-5-2-medium-thinking",
				name: "GPT-5.2 Medium Thinking",
			},
			{
				provider: "devin",
				id: "gpt-5-2-medium-thinking-fast",
				name: "GPT-5.2 Medium Thinking Fast",
			},
			{
				provider: "devin",
				id: "gpt-5-2-no-thinking",
				name: "GPT-5.2 No Thinking",
			},
		]);
		expect(families).toHaveLength(1);
		expect(families[0].kind).toBe("sibling");
		expect(families[0].displayName).toBe("GPT-5.2");
		expect(families[0].efforts).toEqual(["low", "medium", "high"]);
		// Prefer Thinking Fast when both medium variants exist.
		expect(families[0].variants.medium?.id).toBe("gpt-5-2-medium-thinking-fast");
	});

	test("collapses Level Fast speed-tier siblings (e.g. Codex Low/Medium Fast)", () => {
		const families = build_model_families([
			{
				provider: "devin",
				id: "gpt-5-2-codex",
				name: "GPT-5.2-Codex",
			},
			{
				provider: "devin",
				id: "gpt-5-2-codex-low-fast",
				name: "GPT-5.2-Codex Low Fast",
			},
			{
				provider: "devin",
				id: "gpt-5-2-codex-medium-fast",
				name: "GPT-5.2-Codex Medium Fast",
			},
			{
				provider: "devin",
				id: "gpt-5-2",
				name: "GPT-5.2",
			},
			{
				provider: "devin",
				id: "gpt-5-1",
				name: "GPT-5.1",
			},
		]);
		const codex = families.find((f) => f.displayName === "GPT-5.2-Codex");
		expect(codex).toBeDefined();
		expect(codex?.kind).toBe("sibling");
		expect(codex?.efforts).toEqual(["low", "medium"]);
		expect(codex?.variants.low?.id).toBe("gpt-5-2-codex-low-fast");
		expect(codex?.variants.medium?.id).toBe("gpt-5-2-codex-medium-fast");
		// Bare GPT-5.2 and GPT-5.1 stay separate rows.
		expect(families.filter((f) => f.displayName === "GPT-5.2")).toHaveLength(1);
		expect(families.filter((f) => f.displayName === "GPT-5.1")).toHaveLength(1);
	});

	test("keeps Fast as a separate model class from Grok 4.5", () => {
		const families = build_model_families([
			{ provider: "cursor", id: "grok-4.5", name: "Grok 4.5" },
			{ provider: "cursor", id: "grok-4.5-low", name: "Grok 4.5 Low" },
			{ provider: "cursor", id: "grok-4.5-high", name: "Grok 4.5 High" },
			{ provider: "cursor", id: "grok-4.5-fast", name: "Grok 4.5" },
			{ provider: "cursor", id: "grok-4.5-fast-low", name: "Grok 4.5 Low" },
			{ provider: "cursor", id: "grok-4.5-fast-high", name: "Grok 4.5 High" },
		]);
		const standard = families.find((f) => f.displayName === "Grok 4.5");
		const fast = families.find((f) => f.displayName === "Grok 4.5 Fast");
		expect(standard).toBeDefined();
		expect(fast).toBeDefined();
		expect(standard?.kind).toBe("sibling");
		expect(fast?.kind).toBe("sibling");
		expect(standard?.efforts).toEqual(["low", "high"]);
		expect(fast?.efforts).toEqual(["low", "high"]);
		expect(family_contains_model(fast!, "cursor", "grok-4.5-fast")).toBe(true);
		expect(family_contains_model(fast!, "cursor", "grok-4.5-fast-high")).toBe(true);
		expect(family_contains_model(standard!, "cursor", "grok-4.5")).toBe(true);
		expect(family_contains_model(standard!, "cursor", "grok-4.5-fast")).toBe(false);
	});

	test("keeps Cursor Grok 4.5 Fast separate from standard (live id shape)", () => {
		const catalog = [
			{ provider: "cursor", id: "cursor-grok-4.5-low", name: "Cursor Grok 4.5 Low" },
			{ provider: "cursor", id: "cursor-grok-4.5-medium", name: "Cursor Grok 4.5 Medium" },
			{ provider: "cursor", id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5" },
			{
				provider: "cursor",
				id: "cursor-grok-4.5-low-fast",
				name: "Cursor Grok 4.5 Low Fast",
			},
			{
				provider: "cursor",
				id: "cursor-grok-4.5-medium-fast",
				name: "Cursor Grok 4.5 Medium Fast",
			},
			{
				provider: "cursor",
				id: "cursor-grok-4.5-high-fast",
				name: "Cursor Grok 4.5 Fast",
			},
		];
		const families = build_model_families(catalog);
		expect(families).toHaveLength(2);
		const standard = families.find((f) => f.displayName === "Cursor Grok 4.5");
		const fast = families.find((f) => f.displayName === "Cursor Grok 4.5 Fast");
		expect(standard?.kind).toBe("sibling");
		expect(fast?.kind).toBe("sibling");
		expect(standard?.efforts).toEqual(["low", "medium", "high"]);
		expect(fast?.efforts).toEqual(["low", "medium", "high"]);
		expect(family_contains_model(fast!, "cursor", "cursor-grok-4.5-high-fast")).toBe(true);
		expect(family_contains_model(standard!, "cursor", "cursor-grok-4.5-high")).toBe(true);
		expect(family_contains_model(standard!, "cursor", "cursor-grok-4.5-high-fast")).toBe(
			false,
		);
		expect(
			initial_effort_for_family(fast!, {
				provider: "cursor",
				id: "cursor-grok-4.5-high-fast",
			}),
		).toBe("high");
	});

	test("collapses same-provider baked effort siblings into one family", () => {
		const families = build_model_families([
			{
				provider: "devin",
				id: "claude-opus-4-7-medium",
				name: "Claude Opus 4.7 Medium",
			},
			{
				provider: "devin",
				id: "claude-opus-4-7-high",
				name: "Claude Opus 4.7 High",
			},
			{
				provider: "devin",
				id: "claude-opus-4-7-low",
				name: "Claude Opus 4.7 Low",
			},
			{
				provider: "devin",
				id: "claude-opus-4-7-xhigh",
				name: "Claude Opus 4.7 xHigh",
			},
		]);
		expect(families).toHaveLength(1);
		expect(families[0].kind).toBe("sibling");
		expect(families[0].displayName).toBe("Claude Opus 4.7");
		expect(families[0].efforts).toEqual(["low", "medium", "high", "xhigh"]);
	});

	test("does not cross providers when collapsing", () => {
		const families = build_model_families([
			{ provider: "a", id: "gpt-oss-medium", name: "GPT OSS Medium" },
			{ provider: "a", id: "gpt-oss-high", name: "GPT OSS High" },
			{ provider: "b", id: "gpt-oss-medium", name: "GPT OSS Medium" },
			{ provider: "b", id: "gpt-oss-high", name: "GPT OSS High" },
		]);
		expect(families).toHaveLength(2);
		expect(families.every((f) => f.kind === "sibling")).toBe(true);
	});

	test("leaves singleton models without variants as kind none", () => {
		const families = build_model_families([
			{ provider: "google", id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
		]);
		expect(families).toHaveLength(1);
		expect(families[0].kind).toBe("none");
		expect(families[0].efforts).toEqual([]);
		expect(families[0].displayName).toBe("Gemini 3.5 Flash");
	});

	test("standalone Thinking model class is not an Effort slider family", () => {
		const families = build_model_families(
			[
				{
					provider: "cursor",
					id: "claude-4.5-sonnet-thinking",
					name: "Sonnet 4.5 Thinking",
					reasoning: true,
				},
			],
			{ availableThinkingLevels: ["low", "medium", "high"] },
		);
		expect(families).toHaveLength(1);
		expect(families[0].kind).toBe("none");
		expect(families[0].displayName).toBe("Sonnet 4.5 Thinking");
		expect(families[0].efforts).toEqual([]);
	});

	test("promotes single model with thinkingLevelMap to kind thinking", () => {
		const families = build_model_families([
			{
				provider: "openai",
				id: "o3-mini",
				name: "o3-mini",
				reasoning: true,
				thinkingLevelMap: {
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				},
			},
		]);
		expect(families).toHaveLength(1);
		expect(families[0].kind).toBe("thinking");
		expect(families[0].efforts).toEqual(["low", "medium", "high", "xhigh"]);
	});

	test("ignores null thinkingLevelMap entries", () => {
		expect(
			efforts_from_thinking_level_map({
				low: "low",
				medium: null,
				high: "high",
				xhigh: undefined,
			}),
		).toEqual(["low", "high"]);
	});
});

describe("resolve_family_selection", () => {
	test("sibling resolve picks the matching catalog id", () => {
		const [family] = build_model_families([
			{ provider: "devin", id: "m-low", name: "M Low" },
			{ provider: "devin", id: "m-medium", name: "M Medium" },
			{ provider: "devin", id: "m-high", name: "M High" },
		]);
		const high = resolve_family_selection(family, "high");
		expect(high.model.id).toBe("m-high");
		expect(high.thinkingLevel).toBe("high");
		expect(high.syncThinkingLevelToPi).toBeUndefined();

		const med = resolve_family_selection(family, "medium");
		expect(med.model.id).toBe("m-medium");
		expect(med.thinkingLevel).toBe("medium");
	});

	test("thinking resolve returns base model plus thinkingLevel", () => {
		const [family] = build_model_families([
			{
				provider: "openai",
				id: "o3-mini",
				reasoning: true,
				thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
			},
		]);
		const sel = resolve_family_selection(family, "high");
		expect(sel.model.id).toBe("o3-mini");
		expect(sel.thinkingLevel).toBe("high");
		expect(sel.syncThinkingLevelToPi).toBe(true);
	});

	test("nearest_effort prefers medium then first available", () => {
		expect(nearest_effort(["low", "high"], "medium")).toBe("low");
		expect(nearest_effort(["low", "medium", "high"], undefined)).toBe("medium");
		expect(nearest_effort(["high", "xhigh"], "low")).toBe("high");
	});
});

describe("family_contains_model / initial_effort_for_family", () => {
	test("detects current sibling and seeds effort", () => {
		const [family] = build_model_families([
			{ provider: "devin", id: "m-low", name: "M Low" },
			{ provider: "devin", id: "m-high", name: "M High" },
		]);
		expect(family_contains_model(family, "devin", "m-high")).toBe(true);
		expect(
			initial_effort_for_family(family, {
				provider: "devin",
				id: "m-high",
				name: "M High",
			}),
		).toBe("high");
	});
});
