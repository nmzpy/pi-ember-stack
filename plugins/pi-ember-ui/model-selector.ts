/**
 * In-editor Switch Model picker — editor chatbox stays in place; the bottom rule
 * drops to 50% opacity and model rows render below (slash-menu pattern, no header).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	fuzzyFilter,
	getKeybindings,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type FamilyModel,
	type ModelFamily,
	build_model_families,
	family_contains_model,
	initial_effort_for_family,
	nearest_effort,
	resolve_family_selection,
} from "./model-families.ts";
import {
	type EffortSliderPoint,
	format_effort_display_label,
} from "./model-variants.ts";
import {
	DIM_COLOR,
	ORANGE,
	PAGE_BG,
	blendToHex,
	colorize,
	setQuizActive,
} from "./mode-colors.ts";
import { resolve_select_list_theme } from "./select-list-theme.ts";

export interface ModelSelectorResult {
	provider: string;
	id: string;
	thinkingLevel?: EffortSliderPoint;
	syncThinkingLevelToPi?: boolean;
}

export interface OpenModelPickerOptions {
	initialSearch?: string;
	onConfirm?: (result: ModelSelectorResult) => void;
	onCancel?: () => void;
}

const MAX_VISIBLE_FAMILIES = 7;

const EFFORT_OPACITY_FOUR: Record<"low" | "medium" | "high" | "xhigh" | "max", number> = {
	low: 0.25,
	medium: 0.5,
	high: 0.75,
	xhigh: 1,
	max: 1,
};

const EFFORT_OPACITY_FIVE: Record<EffortSliderPoint, number> = {
	low: 0.2,
	medium: 0.4,
	high: 0.6,
	xhigh: 0.8,
	max: 1,
};

const EFFORT_OPACITY_THREE: Record<"low" | "medium" | "high", number> = {
	low: 0.33,
	medium: 0.66,
	high: 1,
};

function effort_point_opacity(point: EffortSliderPoint, efforts: EffortSliderPoint[]): number {
	if (efforts.includes("max")) {
		return EFFORT_OPACITY_FIVE[point];
	}
	if (!efforts.includes("xhigh")) {
		if (point === "low" || point === "medium" || point === "high") {
			return EFFORT_OPACITY_THREE[point];
		}
	}
	return EFFORT_OPACITY_FOUR[point as keyof typeof EFFORT_OPACITY_FOUR];
}

/** Orange accent at the Effort point opacity (SSOT for the slider). */
export function effort_point_color(
	point: EffortSliderPoint,
	efforts?: EffortSliderPoint[],
): string {
	const opacity =
		efforts && efforts.length > 0
			? effort_point_opacity(point, efforts)
			: EFFORT_OPACITY_FOUR[point];
	return blendToHex(ORANGE, PAGE_BG, opacity);
}

function paint_effort_point(
	theme: Theme,
	point: EffortSliderPoint,
	active: boolean,
	text: string,
	efforts: EffortSliderPoint[],
): string {
	const painted = colorize(effort_point_color(point, efforts), text);
	if (active) {
		return typeof theme.bold === "function" ? theme.bold(painted) : painted;
	}
	return theme.fg("dim", text);
}

type PickerState = {
	families: ModelFamily[];
	familyIndex: number;
	scrollOffset: number;
	effort: EffortSliderPoint | undefined;
	effortExpanded: boolean;
	currentInfo:
		| {
				provider: string;
				id: string;
				name?: string;
				thinkingLevel: string;
		  }
		| undefined;
};

let picker_active = false;
let picker_state: PickerState | null = null;
let bound_editor: unknown = null;
let confirm_handler: ((result: ModelSelectorResult) => void) | null = null;
let cancel_handler: (() => void) | null = null;

function family_search_text(family: ModelFamily): string {
	return [
		family.displayName,
		family.provider,
		family.familyKey,
		family.baseModel.id,
		...Object.values(family.variants)
			.filter(Boolean)
			.map((m) => `${m?.id ?? ""} ${m?.name ?? ""}`),
	].join(" ");
}

function is_confirm_key(data: string): boolean {
	if (matchesKey(data, Key.enter)) return true;
	const kb = getKeybindings();
	return kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit");
}

function filter_from_editor(editor: { getText?: () => string }): string {
	return editor.getText?.()?.trim() ?? "";
}

function filtered_families(state: PickerState, filter: string): ModelFamily[] {
	if (!filter) return state.families;
	return fuzzyFilter(state.families, filter, family_search_text);
}

function selected_family(state: PickerState, filter: string): ModelFamily | undefined {
	const list = filtered_families(state, filter);
	if (list.length === 0) return undefined;
	state.familyIndex = Math.max(0, Math.min(state.familyIndex, list.length - 1));
	return list[state.familyIndex];
}

function ensure_visible(state: PickerState, listLen: number): void {
	if (state.familyIndex < state.scrollOffset) state.scrollOffset = state.familyIndex;
	if (state.familyIndex >= state.scrollOffset + MAX_VISIBLE_FAMILIES) {
		state.scrollOffset = state.familyIndex - MAX_VISIBLE_FAMILIES + 1;
	}
	state.scrollOffset = Math.max(
		0,
		Math.min(state.scrollOffset, Math.max(0, listLen - MAX_VISIBLE_FAMILIES)),
	);
}

function seed_effort_for(
	state: PickerState,
	family: ModelFamily | undefined,
): void {
	if (!family || family.efforts.length < 2) {
		state.effort = undefined;
		return;
	}
	state.effort = initial_effort_for_family(family, state.currentInfo);
}

function reset_selection_on_filter_change(state: PickerState): void {
	state.familyIndex = 0;
	state.scrollOffset = 0;
	state.effortExpanded = false;
	state.effort = undefined;
}

export function is_model_picker_active(): boolean {
	return picker_active;
}

export function is_model_picker_editor(editor: unknown): boolean {
	return picker_active && editor === bound_editor;
}

export function close_model_picker(editor?: { setText?: (t: string) => void }): void {
	picker_active = false;
	picker_state = null;
	bound_editor = null;
	confirm_handler = null;
	cancel_handler = null;
	setQuizActive(false);
	editor?.setText?.("");
}

function finish_confirm(editor: { setText?: (t: string) => void }, result: ModelSelectorResult): void {
	const handler = confirm_handler;
	close_model_picker(editor);
	handler?.(result);
}

function finish_cancel(editor: { setText?: (t: string) => void }): void {
	const handler = cancel_handler;
	close_model_picker(editor);
	handler?.();
}

/** Open the in-editor model list (editor stays; rows grow below at 50% sep). */
export function open_model_picker_in_editor(
	editor: {
		getText?: () => string;
		setText?: (t: string) => void;
		cancelAutocomplete?: () => void;
		tui?: { requestRender?: (force?: boolean) => void };
	},
	ctx: ExtensionContext,
	_pi: ExtensionAPI,
	options?: OpenModelPickerOptions,
): void {
	if (!ctx.hasUI || ctx.mode !== "tui") return;

	const models = (ctx.modelRegistry?.getAvailable?.() ?? []) as FamilyModel[];
	const families = build_model_families(models);
	if (families.length === 0) {
		ctx.ui.notify("No models available.", "warning");
		return;
	}

	const currentModel = ctx.model as FamilyModel | undefined;
	const currentThinking =
		(_pi as { getThinkingLevel?: () => string }).getThinkingLevel?.() ?? "off";
	const currentInfo = currentModel
		? {
				provider: currentModel.provider,
				id: currentModel.id,
				name: currentModel.name,
				thinkingLevel: currentThinking,
			}
		: undefined;

	const list = options?.initialSearch?.trim()
		? fuzzyFilter(families, options.initialSearch.trim(), family_search_text)
		: families;
	const curIdx = list.findIndex((f) =>
		family_contains_model(f, currentInfo?.provider, currentInfo?.id),
	);

	picker_state = {
		families,
		familyIndex: curIdx >= 0 ? curIdx : 0,
		scrollOffset: 0,
		effort: undefined,
		effortExpanded: false,
		currentInfo,
	};
	picker_active = true;
	bound_editor = editor;
	confirm_handler = options?.onConfirm ?? null;
	cancel_handler = options?.onCancel ?? null;

	setQuizActive(true);
	editor.cancelAutocomplete?.();
	editor.setText?.(options?.initialSearch?.trim() ?? "");
	editor.tui?.requestRender?.();
}

function render_effort_slider(
	theme: Theme,
	efforts: EffortSliderPoint[],
	selected: EffortSliderPoint,
	width: number,
	indent = " ",
): string[] {
	const selectedIdx = Math.max(0, efforts.indexOf(selected));
	const lines: string[] = [];
	const left = theme.fg("dim", "<");
	const right = theme.fg("dim", ">");
	const parts: string[] = [];
	for (let i = 0; i < efforts.length; i++) {
		const point = efforts[i];
		parts.push(
			paint_effort_point(
				theme,
				point,
				i === selectedIdx,
				format_effort_display_label(point),
				efforts,
			),
		);
		if (i < efforts.length - 1) {
			parts.push(theme.fg("dim", " ── "));
		}
	}
	const row = `${indent}${theme.fg("dim", "Effort")}  ${left} ${parts.join("")} ${right}`;
	lines.push(visibleWidth(row) > width ? truncateToWidth(row, width) : row);
	lines.push("");
	return lines;
}

function push_line(lines: string[], text: string, width: number): void {
	lines.push(visibleWidth(text) > width ? truncateToWidth(text, width) : text);
}

/** Model rows only — no title, no chatbox rules (shell injects sep + gutter). */
export function render_model_picker_rows(width: number): string[] {
	if (!picker_active || !picker_state || !bound_editor) return [];

	const editor = bound_editor as { getText?: () => string };
	const state = picker_state;
	const theme = resolve_select_list_theme();
	const filter = filter_from_editor(editor);
	const list = filtered_families(state, filter);
	ensure_visible(state, list.length);

	const renderWidth = Math.max(1, width);
	const lines: string[] = [];

	if (list.length === 0) {
		push_line(lines, theme.fg("warning", "No matching models"), renderWidth);
		return lines;
	}

	const end = Math.min(list.length, state.scrollOffset + MAX_VISIBLE_FAMILIES);
	for (let i = state.scrollOffset; i < end; i++) {
		const family = list[i];
		const selected = i === state.familyIndex;
		const isCurrent = family_contains_model(
			family,
			state.currentInfo?.provider,
			state.currentInfo?.id,
		);
		const suffix = isCurrent ? " (current)" : "";
		const label = `${family.displayName}${suffix}`;
		const providerHint = theme.fg("dim", ` ${family.provider}`);
		if (selected) {
			push_line(
				lines,
				`${colorize(ORANGE, ">")} ${colorize(ORANGE, label)}${providerHint}`,
				renderWidth,
			);
		} else {
			push_line(lines, `  ${theme.fg("dim", label)}${providerHint}`, renderWidth);
		}

		if (selected && state.effortExpanded && family.efforts.length >= 2) {
			const selectedEffort =
				state.effort && family.efforts.includes(state.effort)
					? state.effort
					: (nearest_effort(family.efforts, "medium") ?? family.efforts[0]);
			state.effort = selectedEffort;
			for (const row of render_effort_slider(
				theme,
				family.efforts,
				selectedEffort,
				renderWidth,
				" ",
			)) {
				lines.push(row);
			}
		}
	}

	if (list.length > MAX_VISIBLE_FAMILIES) {
		push_line(
			lines,
			theme.fg("dim", `${state.familyIndex + 1}/${list.length}`),
			renderWidth,
		);
	}

	return lines;
}

function confirm_selection(editor: { setText?: (t: string) => void }): void {
	if (!picker_state) return;
	const filter = filter_from_editor(editor as { getText?: () => string });
	const family = selected_family(picker_state, filter);
	if (!family) return;
	const selection = resolve_family_selection(family, picker_state.effort);
	finish_confirm(editor, {
		provider: selection.model.provider,
		id: selection.model.id,
		thinkingLevel: selection.thinkingLevel,
		syncThinkingLevelToPi: selection.syncThinkingLevelToPi,
	});
}

function expand_effort_or_confirm(editor: {
	setText?: (t: string) => void;
	tui?: { requestRender?: (force?: boolean) => void };
}): void {
	if (!picker_state) return;
	const filter = filter_from_editor(editor as { getText?: () => string });
	const family = selected_family(picker_state, filter);
	if (!family) return;
	if (family.efforts.length >= 2 && !picker_state.effortExpanded) {
		picker_state.effortExpanded = true;
		seed_effort_for(picker_state, family);
		request_picker_render(editor);
		return;
	}
	confirm_selection(editor);
}

function request_picker_render(editor: { tui?: { requestRender?: () => void } }): void {
	editor.tui?.requestRender?.();
}

/** Call after editor text changes so the filter list stays in sync. */
export function on_model_picker_filter_changed(
	editor: { getText?: () => string; tui?: { requestRender?: (force?: boolean) => void } },
): void {
	if (!picker_active || !picker_state || editor !== bound_editor) return;
	reset_selection_on_filter_change(picker_state);
	request_picker_render(editor);
}

/** Navigation keys while the in-editor picker is open. Returns true when consumed. */
export function handle_model_picker_input(
	data: string,
	editor: {
		getText?: () => string;
		setText?: (t: string) => void;
		tui?: { requestRender?: (force?: boolean) => void };
	},
): boolean {
	if (!picker_active || !picker_state || editor !== bound_editor) return false;

	if (isKeyRelease(data)) return true;

	if (matchesKey(data, Key.escape)) {
		if (picker_state.effortExpanded) {
			picker_state.effortExpanded = false;
			picker_state.effort = undefined;
			request_picker_render(editor);
			return true;
		}
		finish_cancel(editor);
		return true;
	}

	if (is_confirm_key(data)) {
		expand_effort_or_confirm(editor);
		return true;
	}

	const filter = filter_from_editor(editor);
	const list = filtered_families(picker_state, filter);

	if (matchesKey(data, Key.up)) {
		if (list.length === 0) return true;
		const next = Math.max(0, picker_state.familyIndex - 1);
		if (next !== picker_state.familyIndex) {
			picker_state.familyIndex = next;
			picker_state.effortExpanded = false;
			picker_state.effort = undefined;
			request_picker_render(editor);
		}
		return true;
	}

	if (matchesKey(data, Key.down)) {
		if (list.length === 0) return true;
		const next = Math.min(list.length - 1, picker_state.familyIndex + 1);
		if (next !== picker_state.familyIndex) {
			picker_state.familyIndex = next;
			picker_state.effortExpanded = false;
			picker_state.effort = undefined;
			request_picker_render(editor);
		}
		return true;
	}

	const family = list[picker_state.familyIndex];
	if (picker_state.effortExpanded && family && family.efforts.length >= 2) {
		const idx = Math.max(0, family.efforts.indexOf(picker_state.effort ?? family.efforts[0]));
		if (matchesKey(data, Key.left)) {
			const next = Math.max(0, idx - 1);
			if (next !== idx) {
				picker_state.effort = family.efforts[next];
				request_picker_render(editor);
			}
			return true;
		}
		if (matchesKey(data, Key.right)) {
			const next = Math.min(family.efforts.length - 1, idx + 1);
			if (next !== idx) {
				picker_state.effort = family.efforts[next];
				request_picker_render(editor);
			}
			return true;
		}
	}

	// Block editor navigation while the picker owns ↑↓←→ / Enter / Esc.
	if (
		matchesKey(data, Key.left) ||
		matchesKey(data, Key.right) ||
		matchesKey(data, Key.up) ||
		matchesKey(data, Key.down) ||
		is_confirm_key(data)
	) {
		return true;
	}

	return false;
}

export const __test_only = {
	effort_point_color,
	effort_point_opacity,
	EFFORT_OPACITY_FOUR,
	EFFORT_OPACITY_THREE,
};
