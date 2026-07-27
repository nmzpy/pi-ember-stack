import { describe, expect, test, afterEach } from "bun:test";
import { ORANGE, PAGE_BG, blendToHex } from "../mode-colors.ts";
import { bind_select_list_theme_resolver } from "../select-list-theme.ts";
import { render_model_picker_rows, __test_only } from "../model-selector.ts";

const SAMPLE_MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
	{ provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
	{ provider: "xai", id: "grok-4.5", name: "Grok 4.5" },
];

const mock_theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as const;

afterEach(() => {
	__test_only.close_model_picker();
});

describe("model picker navigation", () => {
	test("moves selection with tui.select.up/down bindings", () => {
		bind_select_list_theme_resolver(() => mock_theme as never);
		const editor = {
			getText: () => "",
			setText() {},
			cancelAutocomplete() {},
			tui: { requestRender() {} },
		};
		__test_only.open_model_picker_in_editor(
			editor,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => SAMPLE_MODELS },
				model: SAMPLE_MODELS[0],
			} as never,
			{ getThinkingLevel: () => "off" } as never,
		);
		expect(__test_only.is_model_picker_active()).toBe(true);

		const down = "\x1b[B";
		const up = "\x1b[A";
		expect(__test_only.is_picker_select_down(down)).toBe(true);
		expect(__test_only.is_picker_select_up(up)).toBe(true);

		const first_selected = render_model_picker_rows(80).find((line) => line.includes(">"));
		expect(first_selected).toContain("Claude Sonnet 4");

		expect(__test_only.handle_model_picker_input(down, editor)).toBe(true);
		const second_selected = render_model_picker_rows(80).find((line) => line.includes(">"));
		expect(second_selected).toContain("GPT-4.1");

		expect(__test_only.handle_model_picker_input(up, editor)).toBe(true);
		const back_selected = render_model_picker_rows(80).find((line) => line.includes(">"));
		expect(back_selected).toContain("Claude Sonnet 4");
	});

	test("provider/id seed selects the family instead of showing no matches", () => {
		bind_select_list_theme_resolver(() => mock_theme as never);
		const editor = {
			getText: () => "",
			setText(value: string) {
				this.getText = () => value;
			},
			cancelAutocomplete() {},
			tui: { requestRender() {} },
		};
		__test_only.open_model_picker_in_editor(
			editor,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => SAMPLE_MODELS },
				model: SAMPLE_MODELS[0],
			} as never,
			{ getThinkingLevel: () => "off" } as never,
			{ initialSearch: "/model anthropic/claude-sonnet-4" },
		);
		const rows = render_model_picker_rows(80);
		expect(rows.some((line) => line.includes("No matching models"))).toBe(false);
		expect(rows.some((line) => line.includes("Claude Sonnet 4"))).toBe(true);
		expect(editor.getText()).toBe("");
	});

	// Enter confirms the highlighted model in one step.
	test("enter confirms the selected family", () => {
		bind_select_list_theme_resolver(() => mock_theme as never);
		let confirmed: { provider: string; id: string } | undefined;
		const editor = {
			getText: () => "",
			setText() {},
			cancelAutocomplete() {},
			tui: { requestRender() {} },
		};
		__test_only.open_model_picker_in_editor(
			editor,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => SAMPLE_MODELS },
				model: SAMPLE_MODELS[0],
			} as never,
			{ getThinkingLevel: () => "off" } as never,
			{
				onConfirm: (result) => {
					confirmed = result;
				},
			},
		);
		expect(__test_only.handle_model_picker_input("\r", editor)).toBe(true);
		expect(confirmed).toEqual({ provider: "anthropic", id: "claude-sonnet-4" });
	});

	test("normalize_picker_filter strips slash prefix and current suffix", () => {
		expect(__test_only.normalize_picker_filter("/model grok-4.5")).toBe("grok-4.5");
		expect(__test_only.normalize_picker_filter("Grok 4.5 (current)")).toBe("Grok 4.5");
	});

	test("renders effort slider inline on the same row as each family", () => {
		bind_select_list_theme_resolver(() => mock_theme as never);
		const editor = {
			getText: () => "",
			setText() {},
			cancelAutocomplete() {},
			tui: { requestRender() {} },
		};
		const effort_models = [
			{ provider: "openai-codex", id: "gpt-5.6-luna-low", name: "GPT-5.6 Luna Low" },
			{ provider: "openai-codex", id: "gpt-5.6-luna-medium", name: "GPT-5.6 Luna Medium" },
			{ provider: "openai-codex", id: "gpt-5.6-luna-high", name: "GPT-5.6 Luna High" },
			{ provider: "openai-codex", id: "gpt-5.6-luna-xhigh", name: "GPT-5.6 Luna xHigh" },
			{ provider: "openai-codex", id: "gpt-5.6-luna-max", name: "GPT-5.6 Luna Max" },
			{ provider: "devin", id: "swe-1-7", name: "Devin SWE" },
		];
		__test_only.open_model_picker_in_editor(
			editor,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => effort_models },
				model: effort_models[2],
			} as never,
			{ getThinkingLevel: () => "high" } as never,
		);
		const rows = render_model_picker_rows(120);
		const selected_row = rows.find((line) => line.includes(">"));
		expect(selected_row).toBeDefined();
		expect(selected_row).toContain("GPT-5.6 Luna");
		expect(selected_row).toContain("<");
		expect(selected_row).toContain("High");
		expect(selected_row).not.toContain("Effort");
		expect(rows.filter((line) => line.includes("GPT-5.6 Luna"))).toHaveLength(1);
	});

	test("pins current model family first when currentModel override is set", () => {
		bind_select_list_theme_resolver(() => mock_theme as never);
		const editor = {
			getText: () => "",
			setText() {},
			cancelAutocomplete() {},
			tui: { requestRender() {} },
		};
		const models = [
			{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
			{ provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
			{ provider: "devin", id: "swe-1-7-medium", name: "Devin SWE" },
		];
		__test_only.open_model_picker_in_editor(
			editor,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: { getAvailable: () => models },
				model: models[0],
			} as never,
			{ getThinkingLevel: () => "off" } as never,
			{ currentModel: { provider: "devin", id: "swe-1-7-medium", name: "Devin SWE" } },
		);
		const selected_row = render_model_picker_rows(80).find((line) => line.includes(">"));
		expect(selected_row).toContain("swe-1-7");
		expect(selected_row).toContain("(current)");
	});
});

describe("model selector effort colors", () => {
	test("effort_point_color uses four-step ladder when xhigh is available", () => {
		const efforts = ["low", "medium", "high", "xhigh"] as const;
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.25),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.5),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.75),
		);
		expect(__test_only.effort_point_color("xhigh", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 1),
		);
	});

	test("effort_point_color uses three-step ladder when high is the max", () => {
		const efforts = ["low", "medium", "high"] as const;
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.33),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.66),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 1),
		);
	});

	test("effort_point_color uses five-step ladder when max is available", () => {
		const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.2),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.4),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.6),
		);
		expect(__test_only.effort_point_color("xhigh", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 0.8),
		);
		expect(__test_only.effort_point_color("max", [...efforts])).toBe(
			blendToHex(ORANGE, PAGE_BG, 1),
		);
	});
});
