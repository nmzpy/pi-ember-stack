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
import { find_exact_model_reference } from "./model-reference.ts";

export const MODEL_COMMAND_PREFIX = "/model";

/** Strip slash-command prefix and display-only suffixes from picker filter text. */
export function normalize_picker_filter(text: string): string {
	let trimmed = text.trim();
	if (trimmed === MODEL_COMMAND_PREFIX) return "";
	if (trimmed.startsWith(`${MODEL_COMMAND_PREFIX} `)) {
		trimmed = trimmed.slice(MODEL_COMMAND_PREFIX.length).trim();
	} else if (
		trimmed.startsWith(MODEL_COMMAND_PREFIX) &&
		trimmed.length > MODEL_COMMAND_PREFIX.length
	) {
		trimmed = trimmed.slice(MODEL_COMMAND_PREFIX.length).trim();
	}
	return trimmed.replace(/\s*\(current\)\s*$/i, "").trim();
}

/** Search term after `/model` when the editor still holds the slash command. */
export function extract_model_command_search(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(MODEL_COMMAND_PREFIX)) return null;
	if (trimmed === MODEL_COMMAND_PREFIX) return "";
	return normalize_picker_filter(trimmed);
}

/** True once the user is typing a model filter after `/model`. */
export function should_route_model_slash_to_picker(text: string): boolean {
	return (
		text.startsWith(MODEL_COMMAND_PREFIX) && text.length > MODEL_COMMAND_PREFIX.length
	);
}

export interface ModelSelectorResult {
	provider: string;
	id: string;
	thinkingLevel?: EffortSliderPoint;
	syncThinkingLevelToPi?: boolean;
}

export interface OpenModelPickerOptions {
	initialSearch?: string;
	/** Override ctx.model when picking for subagents or other non-live contexts. */
	currentModel?: {
		provider: string;
		id: string;
		name?: string;
		thinkingLevel?: string;
	};
	onConfirm?: (result: ModelSelectorResult) => void;
	onCancel?: () => void;
}

const MAX_VISIBLE_FAMILIES = 7;

const EFFORT_OPACITY_FOUR: Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", number> = {
	minimal: 0.2,
	low: 0.25,
	medium: 0.5,
	high: 0.75,
	xhigh: 1,
	max: 1,
};

const EFFORT_OPACITY_FIVE: Record<EffortSliderPoint, number> = {
	default: 0.5,
	minimal: 0.2,
	low: 0.2,
	medium: 0.4,
	high: 0.6,
	xhigh: 0.8,
	max: 1,
};

const EFFORT_OPACITY_THREE: Record<"minimal" | "low" | "medium" | "high", number> = {
	minimal: 0.2,
	low: 0.33,
	medium: 0.66,
	high: 1,
};

function effort_point_opacity(point: EffortSliderPoint, efforts: EffortSliderPoint[]): number {
	if (point === "default") {
		if (efforts.length === 2 && efforts.includes("max") && efforts.includes("default")) {
			return 0.66;
		}
		return 0.5;
	}
	if (efforts.includes("max")) {
		return EFFORT_OPACITY_FIVE[point];
	}
	if (!efforts.includes("xhigh")) {
		if (point === "minimal" || point === "low" || point === "medium" || point === "high") {
			return EFFORT_OPACITY_THREE[point];
		}
	}
	return EFFORT_OPACITY_FOUR[point];
}

/** Orange accent at the Effort point opacity (SSOT for the slider). */
export function effort_point_color(
	point: EffortSliderPoint,
	efforts?: EffortSliderPoint[],
): string {
	const opacity =
		efforts && efforts.length > 0
			? effort_point_opacity(point, efforts)
			: point === "default"
			  ? 0.5
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
	lastFilter?: string;
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
	const variant_parts = Object.values(family.variants)
		.filter(Boolean)
		.flatMap((model) => [
			model?.id ?? "",
			model?.name ?? "",
			`${family.provider}/${model?.id ?? ""}`,
		]);
	return [
		family.displayName,
		family.provider,
		family.familyKey,
		family.baseModel.id,
		family.baseModel.name ?? "",
		`${family.provider}/${family.baseModel.id}`,
		...variant_parts,
	].join(" ");
}

function resolve_picker_open_state(
	families: ModelFamily[],
	models: FamilyModel[],
	raw_search: string,
	current_info: PickerState["currentInfo"],
): { editor_filter: string; family_index: number } {
	const filter = normalize_picker_filter(raw_search);
	if (!filter) {
		const current_idx = families.findIndex((family) =>
			family_contains_model(family, current_info?.provider, current_info?.id),
		);
		return { editor_filter: "", family_index: current_idx >= 0 ? 0 : 0 };
	}

	const exact = find_exact_model_reference(filter, models);
	if (exact) {
		const exact_idx = families.findIndex((family) =>
			family_contains_model(family, exact.provider, exact.id),
		);
		if (exact_idx >= 0) {
			return { editor_filter: "", family_index: exact_idx };
		}
	}

	const display_idx = families.findIndex(
		(family) => family.displayName.toLowerCase() === filter.toLowerCase(),
	);
	if (display_idx >= 0) {
		return { editor_filter: "", family_index: display_idx };
	}

	const filtered = fuzzyFilter(families, filter, family_search_text);
	if (filtered.length > 0) {
		const primary_idx = families.indexOf(filtered[0]);
		return {
			editor_filter: filter,
			family_index: primary_idx >= 0 ? primary_idx : 0,
		};
	}

	return { editor_filter: filter, family_index: 0 };
}

function is_confirm_key(data: string): boolean {
	if (matchesKey(data, Key.enter)) return true;
	const kb = getKeybindings();
	return kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit");
}

/** SSOT: picker-owned keys — same bindings Pi uses for SelectList navigation. */
function is_picker_select_up(data: string): boolean {
	const kb = getKeybindings();
	return matchesKey(data, Key.up) || kb.matches(data, "tui.select.up");
}

function is_picker_select_down(data: string): boolean {
	const kb = getKeybindings();
	return matchesKey(data, Key.down) || kb.matches(data, "tui.select.down");
}

function is_picker_select_left(data: string): boolean {
	const kb = getKeybindings();
	return matchesKey(data, Key.left) || kb.matches(data, "tui.editor.cursorLeft");
}

function is_picker_select_right(data: string): boolean {
	const kb = getKeybindings();
	return matchesKey(data, Key.right) || kb.matches(data, "tui.editor.cursorRight");
}

function is_picker_navigation_key(data: string): boolean {
	return (
		is_picker_select_up(data) ||
		is_picker_select_down(data) ||
		is_picker_select_left(data) ||
		is_picker_select_right(data) ||
		is_confirm_key(data)
	);
}

function filter_from_editor(editor: { getText?: () => string }): string {
	return normalize_picker_filter(editor.getText?.() ?? "");
}

function filtered_families(state: PickerState, filter: string): ModelFamily[] {
	if (!filter) return state.families;
	return fuzzyFilter(state.families, filter, family_search_text);
}

/** Pin the live/current family to the top when the filter is empty. */
function display_families(state: PickerState, filter: string): ModelFamily[] {
	const list = filtered_families(state, filter);
	if (filter || !state.currentInfo) return list;
	const current_idx = list.findIndex((family) =>
		family_contains_model(family, state.currentInfo?.provider, state.currentInfo?.id),
	);
	if (current_idx <= 0) return list;
	const reordered = [...list];
	const [current] = reordered.splice(current_idx, 1);
	reordered.unshift(current);
	return reordered;
}

function selected_family(state: PickerState, filter: string): ModelFamily | undefined {
	const list = display_families(state, filter);
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

export function bind_picker_editor(editor: unknown): void {
	if (picker_active) bound_editor = editor;
}

export function consumes_picker_key(data: string): boolean {
	if (isKeyRelease(data)) return true;
	if (matchesKey(data, Key.escape)) return true;
	return is_picker_navigation_key(data);
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

	const currentModel = options?.currentModel ?? (ctx.model as FamilyModel | undefined);
	const currentThinking =
		options?.currentModel?.thinkingLevel ??
		(_pi as { getThinkingLevel?: () => string }).getThinkingLevel?.() ??
		"off";
	const currentInfo = currentModel
		? {
				provider: currentModel.provider,
				id: currentModel.id,
				name: currentModel.name,
				thinkingLevel: currentThinking,
			}
		: undefined;

	const open_state = resolve_picker_open_state(
		families,
		models,
		options?.initialSearch ?? "",
		currentInfo,
	);

	picker_state = {
		families,
		familyIndex: open_state.family_index,
		scrollOffset: 0,
		effort: undefined,
		effortExpanded: false,
		lastFilter: open_state.editor_filter,
		currentInfo,
	};
	picker_active = true;
	bound_editor = editor;
	confirm_handler = options?.onConfirm ?? null;
	cancel_handler = options?.onCancel ?? null;

	setQuizActive(true);
	editor.cancelAutocomplete?.();
	editor.setText?.(open_state.editor_filter);
	editor.tui?.requestRender?.();
}

function push_line(lines: string[], text: string, width: number): void {
	lines.push(visibleWidth(text) > width ? truncateToWidth(text, width) : text);
}

function compose_row_with_right_suffix(prefix: string, suffix: string, width: number): string {
	if (!suffix) {
		return visibleWidth(prefix) > width ? truncateToWidth(prefix, width) : prefix;
	}
	const prefix_width = visibleWidth(prefix);
	const suffix_width = visibleWidth(suffix);
	if (prefix_width + 1 + suffix_width <= width) {
		const gap = width - prefix_width - suffix_width;
		return `${prefix}${" ".repeat(Math.max(1, gap))}${suffix}`;
	}
	const max_prefix = Math.max(0, width - suffix_width - 1);
	const truncated_prefix = max_prefix > 0 ? truncateToWidth(prefix, max_prefix) : "";
	const gap = Math.max(1, width - visibleWidth(truncated_prefix) - suffix_width);
	const row = `${truncated_prefix}${" ".repeat(gap)}${suffix}`;
	return visibleWidth(row) > width ? truncateToWidth(row, width) : row;
}

function format_effort_slider_inline(
	theme: Theme,
	efforts: EffortSliderPoint[],
	selected: EffortSliderPoint,
	dimmed: boolean,
): string {
	const selected_idx = Math.max(0, efforts.indexOf(selected));
	const left = theme.fg("dim", "<");
	const right = theme.fg("dim", ">");
	const parts: string[] = [];
	for (let i = 0; i < efforts.length; i++) {
		const point = efforts[i];
		const active = i === selected_idx;
		const label = format_effort_display_label(point);
		if (dimmed) {
			parts.push(theme.fg("dim", label));
		} else {
			parts.push(paint_effort_point(theme, point, active, label, efforts));
		}
		if (i < efforts.length - 1) {
			parts.push(theme.fg("dim", " ── "));
		}
	}
	return `${left} ${parts.join("")} ${right}`;
}

function effort_for_family_row(
	state: PickerState,
	family: ModelFamily,
	selected: boolean,
): EffortSliderPoint | undefined {
	if (family.efforts.length < 2) return undefined;
	if (selected) {
		const point =
			state.effort && family.efforts.includes(state.effort)
				? state.effort
				: (nearest_effort(family.efforts, "medium") ?? family.efforts[0]);
		state.effort = point;
		return point;
	}
	return (
		initial_effort_for_family(family, state.currentInfo) ??
		nearest_effort(family.efforts, "medium") ??
		family.efforts[0]
	);
}

/** Model rows only — no title, no chatbox rules (shell injects sep + gutter). */
export function render_model_picker_rows(width: number): string[] {
	if (!picker_active || !picker_state || !bound_editor) return [];

	const editor = bound_editor as { getText?: () => string };
	const state = picker_state;
	const theme = resolve_select_list_theme();
	const filter = filter_from_editor(editor);
	const list = display_families(state, filter);
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
		const providerHint = ` ${family.provider}`;
		let row: string;
		if (selected) {
			const effort_point = effort_for_family_row(state, family, true);
			const effort_suffix =
				effort_point !== undefined
					? ` ${format_effort_slider_inline(theme, family.efforts, effort_point, false)}`
					: "";
			row = `${theme.fg("text", ">")} ${theme.fg("text", label)}${theme.fg("text", providerHint)}${effort_suffix}`;
		} else {
			row = `  ${theme.fg("dim", label)}${theme.fg("dim", providerHint)}`;
		}
		push_line(lines, row, renderWidth);
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
	if (!picker_state.effort && family.efforts.length >= 2) {
		seed_effort_for(picker_state, family);
	}
	const selection = resolve_family_selection(family, picker_state.effort);
	finish_confirm(editor, {
		provider: selection.model.provider,
		id: selection.model.id,
		thinkingLevel: selection.thinkingLevel,
		syncThinkingLevelToPi: selection.syncThinkingLevelToPi,
	});
}

function request_picker_render(editor: { tui?: { requestRender?: () => void } }): void {
	editor.tui?.requestRender?.();
}

/** Call after editor text changes so the filter list stays in sync. */
export function on_model_picker_filter_changed(
	editor: { getText?: () => string; setText?: (t: string) => void; tui?: { requestRender?: (force?: boolean) => void } },
): void {
	if (!picker_active || !picker_state) return;
	bind_picker_editor(editor);
	const normalized = normalize_picker_filter(editor.getText?.() ?? "");
	if ((editor.getText?.() ?? "") !== normalized) {
		editor.setText?.(normalized);
	}
	const prev_filter = picker_state.lastFilter ?? "";
	if (normalized !== prev_filter) {
		reset_selection_on_filter_change(picker_state);
		picker_state.lastFilter = normalized;
	}
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
	if (!picker_active || !picker_state) return false;
	bind_picker_editor(editor);

	if (isKeyRelease(data)) return true;

	if (matchesKey(data, Key.escape)) {
		finish_cancel(editor);
		return true;
	}

	if (is_confirm_key(data)) {
		confirm_selection(editor);
		return true;
	}

	const filter = filter_from_editor(editor);
	const list = display_families(picker_state, filter);

	if (is_picker_select_up(data)) {
		if (list.length === 0) return true;
		const next = Math.max(0, picker_state.familyIndex - 1);
		if (next !== picker_state.familyIndex) {
			picker_state.familyIndex = next;
			picker_state.effort = undefined;
			ensure_visible(picker_state, list.length);
			request_picker_render(editor);
		}
		return true;
	}

	if (is_picker_select_down(data)) {
		if (list.length === 0) return true;
		const next = Math.min(list.length - 1, picker_state.familyIndex + 1);
		if (next !== picker_state.familyIndex) {
			picker_state.familyIndex = next;
			picker_state.effort = undefined;
			ensure_visible(picker_state, list.length);
			request_picker_render(editor);
		}
		return true;
	}

	const family = list[picker_state.familyIndex];
	if (family && family.efforts.length >= 2) {
		const current =
			picker_state.effort && family.efforts.includes(picker_state.effort)
				? picker_state.effort
				: (nearest_effort(family.efforts, "medium") ?? family.efforts[0]);
		picker_state.effort = current;
		const idx = Math.max(0, family.efforts.indexOf(current));
		if (is_picker_select_left(data)) {
			const next = Math.max(0, idx - 1);
			if (next !== idx) {
				picker_state.effort = family.efforts[next];
				request_picker_render(editor);
			}
			return true;
		}
		if (is_picker_select_right(data)) {
			const next = Math.min(family.efforts.length - 1, idx + 1);
			if (next !== idx) {
				picker_state.effort = family.efforts[next];
				request_picker_render(editor);
			}
			return true;
		}
	}

	// Block editor navigation while the picker owns ↑↓←→ / Enter / Esc.
	if (is_picker_navigation_key(data)) {
		return true;
	}

	return false;
}

export const __test_only = {
	effort_point_color,
	effort_point_opacity,
	EFFORT_OPACITY_FOUR,
	EFFORT_OPACITY_THREE,
	is_picker_select_up,
	is_picker_select_down,
	handle_model_picker_input,
	open_model_picker_in_editor,
	close_model_picker,
	is_model_picker_active,
	normalize_picker_filter,
	resolve_picker_open_state,
};
