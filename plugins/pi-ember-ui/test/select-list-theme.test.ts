import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	bind_select_list_theme_resolver,
	buildSelectListTheme,
	buildSettingsListTheme,
	format_selector_option_row,
	format_selector_option_row_with_description,
	install_select_list_theme_patches,
	resolve_coding_agent_dist_dir,
} from "../select-list-theme.ts";
import { buildThemeBgColors, buildThemeFgColors } from "../mode-colors.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
	test("buildSelectListTheme uses text for selected and dim for unselected", () => {
		const theme = make_theme();
		const list = buildSelectListTheme(theme);
		const selected = list.selectedText("→ settings");
		const unselected = list.unselectedText("  model");
		const selected_desc = list.selectedDescription("hint");
		const unselected_desc = list.description("hint");
		expect(selected).toContain("\x1b[");
		expect(unselected).toContain("\x1b[");
		expect(selected).not.toBe(unselected);
		expect(selected_desc).toBe(theme.fg("text", "hint"));
		expect(unselected_desc).toBe(theme.fg("dim", "hint"));
		expect(selected_desc).not.toBe(unselected_desc);
	});

	test("format_selector_option_row matches select list tokens", () => {
		const theme = make_theme();
		const on = format_selector_option_row(theme, "Coder", true);
		const off = format_selector_option_row(theme, "Scout", false);
		expect(on).toBe(buildSelectListTheme(theme).selectedText("→ Coder"));
		expect(off).toBe(buildSelectListTheme(theme).unselectedText("  Scout"));
	});

	test("format_selector_option_row_with_description uses text for selected and dim for unselected", () => {
		const theme = make_theme();
		const on = format_selector_option_row_with_description(
			theme,
			"Coder",
			true,
			"devin/swe-1-7-medium",
		);
		const off = format_selector_option_row_with_description(
			theme,
			"Scout",
			false,
			"inherits parent",
		);
		expect(on).toBe(
			`${theme.fg("text", "→ Coder")} ${theme.fg("text", "devin/swe-1-7-medium")}`,
		);
		expect(off).toBe(
			`${theme.fg("dim", "  Scout")} ${theme.fg("dim", "inherits parent")}`,
		);
	});

	test("buildSettingsListTheme brightens only the selected row", () => {
		const theme = make_theme();
		const settings = buildSettingsListTheme(theme);
		const on = settings.label("Theme", true);
		const off = settings.label("Theme", false);
		expect(on).not.toBe(off);
		expect(settings.cursor).toContain("→");
	});

	test("extension selector updateList paints selected rows with text token", () => {
		const theme = make_theme();
		bind_select_list_theme_resolver(() => theme);
		install_select_list_theme_patches(() => theme);

		const dist_dir = resolve_coding_agent_dist_dir();
		if (!dist_dir) throw new Error("pi-coding-agent dist dir not found");
		const req = createRequire(import.meta.url);
		const { ExtensionSelectorComponent } = req(
			join(dist_dir, "modes/interactive/components/extension-selector.js"),
		) as {
			ExtensionSelectorComponent: {
				prototype: {
					updateList: () => void;
					listContainer: { clear: () => void; addChild: (component: unknown) => void };
					options: string[];
					selectedIndex: number;
				};
			};
		};

		const rows: string[] = [];
		const instance = Object.create(ExtensionSelectorComponent.prototype) as {
			updateList: () => void;
			listContainer: { clear: () => void; addChild: (component: unknown) => void };
			options: string[];
			selectedIndex: number;
		};
		instance.listContainer = {
			clear: () => {
				rows.length = 0;
			},
			addChild: (component: unknown) => {
				const row = (component as { render: (width: number) => string[] }).render(80)[0] ?? "";
				rows.push(stripAnsi(row.trim()));
			},
		};
		instance.options = ["Coder", "Scout"];
		instance.selectedIndex = 1;
		instance.updateList();

		expect(rows[0]).toBe(stripAnsi(format_selector_option_row(theme, "Coder", false)));
		expect(rows[1]).toBe(stripAnsi(format_selector_option_row(theme, "Scout", true)));
		expect(rows[1]).toContain("Scout");
		expect(rows[0]).toContain("Coder");
	});

	test("resolve_coding_agent_dist_dir prefers the process.argv[1] runtime entry", () => {
		const original_argv1 = process.argv[1];
		const tmp = mkdtempSync(join(tmpdir(), "pi-ember-select-list-"));
		try {
			const dist_dir = join(tmp, "dist");
			mkdirSync(join(dist_dir, "modes/interactive/components"), { recursive: true });
			writeFileSync(
				join(dist_dir, "modes/interactive/components/extension-selector.js"),
				"export class ExtensionSelectorComponent {}\n",
			);
			process.argv[1] = join(dist_dir, "cli.js");
			expect(resolve_coding_agent_dist_dir()).toBe(dist_dir);
		} finally {
			if (original_argv1 === undefined) {
				delete process.argv[1];
			} else {
				process.argv[1] = original_argv1;
			}
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
