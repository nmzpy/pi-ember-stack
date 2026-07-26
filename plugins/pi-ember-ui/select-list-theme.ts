import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SELECT_LIST_RENDER_PATCH = Symbol.for("pi-ember-ui:select-list-render");
const SELECT_LIST_THEME_PATCH = Symbol.for("pi-ember-ui:select-list-theme");
const EXTENSION_SELECTOR_PATCH = Symbol.for("pi-ember-ui:extension-selector-patch");

const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

let resolve_theme_for_select_lists: () => Theme = () => {
	throw new Error("select-list theme resolver not bound");
};

export function bind_select_list_theme_resolver(resolver: () => Theme): void {
	resolve_theme_for_select_lists = resolver;
}

export function resolve_select_list_theme(): Theme {
	return resolve_theme_for_select_lists();
}

export type EmberSelectListTheme = {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	unselectedText: (text: string) => string;
};

/** SSOT for slash/autocomplete and overlay SelectList rows. */
export function buildSelectListTheme(live: Theme): EmberSelectListTheme {
	const selected = (text: string) => live.fg("text", text);
	return {
		selectedPrefix: selected,
		selectedText: selected,
		description: (text: string) => live.fg("dim", text),
		scrollInfo: (text: string) => live.fg("dim", text),
		noMatch: (text: string) => live.fg("dim", text),
		unselectedText: (text: string) => live.fg("dim", text),
	};
}

/** SSOT row paint for ctx.ui.select and other arrow-prefix pickers. */
export function format_selector_option_row(live: Theme, label: string, is_selected: boolean): string {
	const prefix = is_selected ? "→ " : "  ";
	const row = `${prefix}${label}`;
	return is_selected ? live.fg("text", row) : live.fg("dim", row);
}

/** SSOT for Pi settings menus (SettingsList). */
export function buildSettingsListTheme(live: Theme) {
	return {
		label: (text: string, selected: boolean) =>
			selected ? live.fg("text", text) : live.fg("dim", text),
		value: (text: string, selected: boolean) =>
			selected ? live.fg("text", text) : live.fg("dim", text),
		description: (text: string) => live.fg("dim", text),
		cursor: live.fg("text", "→ "),
		hint: (text: string) => live.fg("dim", text),
	};
}

type HintStripContainer = {
	children: unknown[];
	removeChild: (component: unknown) => void;
};

/** Remove Pi extension-selector navigate hint row (+ adjacent spacers). */
export function strip_extension_selector_hint(container: HintStripContainer): void {
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i] as {
			constructor?: { name?: string };
			render?: (width: number) => string[];
		};
		if (child?.constructor?.name !== "Text") continue;
		const line = child.render?.(256)?.[0] ?? "";
		if (!line.includes("navigate") || !line.includes("select")) continue;
		const spacers: unknown[] = [];
		const prev = container.children[i - 1] as { constructor?: { name?: string } } | undefined;
		const next = container.children[i + 1] as { constructor?: { name?: string } } | undefined;
		if (prev?.constructor?.name === "Spacer") spacers.push(prev);
		if (next?.constructor?.name === "Spacer") spacers.push(next);
		container.removeChild(child);
		for (const spacer of spacers) container.removeChild(spacer);
		break;
	}
}

function install_extension_selector_patch(get_theme: () => Theme): void {
	const g = globalThis as Record<symbol, boolean>;
	if (g[EXTENSION_SELECTOR_PATCH]) return;

	let selector_url: string | undefined;
	try {
		const req = createRequire(import.meta.url);
		const main_path = req.resolve("@earendil-works/pi-coding-agent");
		const dist_dir = dirname(main_path);
		selector_url = pathToFileURL(
			join(dist_dir, "modes", "interactive", "components", "extension-selector.js"),
		).href;
	} catch {
		// Non-interactive loads may not resolve the component module.
		return;
	}

	void import(selector_url)
		.then((mod) => {
			const exported = mod as {
				ExtensionSelectorComponent: new (...args: unknown[]) => HintStripContainer & {
					listContainer: { clear: () => void; addChild: (component: unknown) => void };
					options: string[];
					selectedIndex: number;
					updateList: () => void;
				};
			};
			const proto = exported.ExtensionSelectorComponent.prototype as {
				[EXTENSION_SELECTOR_PATCH]?: boolean;
				updateList: () => void;
				listContainer: { clear: () => void; addChild: (component: unknown) => void };
				options: string[];
				selectedIndex: number;
			};
			if (proto[EXTENSION_SELECTOR_PATCH]) return;
			proto[EXTENSION_SELECTOR_PATCH] = true;

			proto.updateList = function update_list_patched(this: typeof proto) {
				const live = get_theme();
				this.listContainer.clear();
				for (let i = 0; i < this.options.length; i++) {
					const is_selected = i === this.selectedIndex;
					const row = format_selector_option_row(live, this.options[i], is_selected);
					this.listContainer.addChild(new Text(row, 1, 0));
				}
			};

			const Original = exported.ExtensionSelectorComponent;
			exported.ExtensionSelectorComponent = class ExtensionSelectorComponentPatched extends Original {
				constructor(...args: unknown[]) {
					super(...args);
					strip_extension_selector_hint(this);
				}
			} as typeof exported.ExtensionSelectorComponent;
			g[EXTENSION_SELECTOR_PATCH] = true;
		})
		.catch(() => {
			// Non-interactive loads may not resolve the component module.
		});
}

type SelectListItem = { value: string; label?: string; description?: string };

function install_select_list_render_patch(get_theme: () => Theme): void {
	const proto = SelectList.prototype as unknown as {
		[SELECT_LIST_RENDER_PATCH]?: boolean;
		renderItem: (
			item: SelectListItem,
			isSelected: boolean,
			width: number,
			descriptionSingleLine: string | undefined,
			primaryColumnWidth: number,
		) => string;
		truncatePrimary: (
			item: SelectListItem,
			isSelected: boolean,
			maxWidth: number,
			columnWidth: number,
		) => string;
		getDisplayValue: (item: SelectListItem) => string;
		theme: EmberSelectListTheme;
	};
	if (proto[SELECT_LIST_RENDER_PATCH]) return;
	proto[SELECT_LIST_RENDER_PATCH] = true;

	proto.renderItem = function render_item_patched(
		item: SelectListItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const theme = this.theme ?? buildSelectListTheme(get_theme());
		const prefix = isSelected ? "→ " : "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(
				1,
				Math.min(primaryColumnWidth, width - prefixWidth - 4),
			);
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2;
			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				const primary = isSelected
					? theme.selectedText(`${prefix}${truncatedValue}`)
					: theme.unselectedText(`${prefix}${truncatedValue}`);
				return primary + theme.description(spacing + truncatedDesc);
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return theme.selectedText(`${prefix}${truncatedValue}`);
		}
		return theme.unselectedText(`${prefix}${truncatedValue}`);
	};
}

/** Patch Pi theme helpers and SelectList row colors (dim unselected, text selected). */
export function install_select_list_theme_patches(get_theme: () => Theme): void {
	install_select_list_render_patch(get_theme);
	install_extension_selector_patch(get_theme);

	const g = globalThis as Record<symbol, boolean>;
	if (g[SELECT_LIST_THEME_PATCH]) return;
	g[SELECT_LIST_THEME_PATCH] = true;

	void import("@earendil-works/pi-coding-agent")
		.then((theme_mod) => {
			const mod = theme_mod as unknown as {
				getSelectListTheme?: () => EmberSelectListTheme;
				getSettingsListTheme?: () => ReturnType<typeof buildSettingsListTheme>;
			};
			mod.getSelectListTheme = () => buildSelectListTheme(get_theme());
			mod.getSettingsListTheme = () => buildSettingsListTheme(get_theme());
		})
		.catch(() => {
			// Tests or non-interactive loads may not resolve the theme module.
		});
}
