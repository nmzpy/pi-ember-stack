import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ORANGE, colorize } from "./mode-colors.ts";

const SELECT_LIST_RENDER_PATCH = Symbol.for("pi-ember-ui:select-list-render");
const SELECT_LIST_THEME_PATCH = Symbol.for("pi-ember-ui:select-list-theme");

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
export function buildSelectListTheme(_live: Theme): EmberSelectListTheme {
	const selected = (text: string) => colorize(ORANGE, text);
	return {
		selectedPrefix: selected,
		selectedText: selected,
		description: (text: string) => _live.fg("dim", text),
		scrollInfo: (text: string) => _live.fg("dim", text),
		noMatch: (text: string) => _live.fg("dim", text),
		unselectedText: (text: string) => _live.fg("dim", text),
	};
}

/** SSOT for Pi settings menus (SettingsList). */
export function buildSettingsListTheme(live: Theme) {
	return {
		label: (text: string, selected: boolean) =>
			selected ? colorize(ORANGE, text) : live.fg("dim", text),
		value: (text: string, selected: boolean) =>
			selected ? colorize(ORANGE, text) : live.fg("dim", text),
		description: (text: string) => live.fg("dim", text),
		cursor: colorize(ORANGE, "→ "),
		hint: (text: string) => live.fg("dim", text),
	};
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
