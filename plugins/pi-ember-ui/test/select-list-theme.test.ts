import { describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { buildSelectListTheme, buildSettingsListTheme } from "../select-list-theme.ts";
import { ORANGE, buildThemeBgColors, buildThemeFgColors } from "../mode-colors.ts";

function make_theme(): Theme {
	const accent = "#808080";
	return new Theme(
		buildThemeFgColors(accent) as any,
		buildThemeBgColors(accent) as any,
		"truecolor",
		{ name: "ember-test" },
	);
}

describe("select list theme SSOT", () => {
	test("buildSelectListTheme uses orange for selected and dim for unselected", () => {
		const theme = make_theme();
		const list = buildSelectListTheme(theme);
		const selected = list.selectedText("→ settings");
		const unselected = list.unselectedText("  model");
		expect(selected).toContain("\x1b[");
		expect(unselected).toContain("\x1b[");
		expect(selected).not.toBe(unselected);
	});

	test("buildSettingsListTheme brightens only the selected row", () => {
		const theme = make_theme();
		const settings = buildSettingsListTheme(theme);
		const on = settings.label("Theme", true);
		const off = settings.label("Theme", false);
		expect(on).not.toBe(off);
		expect(settings.cursor).toContain("→");
	});
});
