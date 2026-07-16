import { Spacer, type TUI } from "@earendil-works/pi-tui";

/** Blank rows above the chatbox, or above Thinking/Working when that widget is visible. */
export const CHATBOX_LEADING_ROWS = 1;

export type RenderableChild = {
	render: (width: number) => string[];
	children?: readonly RenderableChild[];
};

let was_slash_command = false;
let was_editor_autocomplete_visible = false;
let slash_exit_redraw_generation = 0;
let slash_command_exit_render: ((force: boolean) => void) | undefined;

/** Wire the throttled render fallback used when exiting slash-command editor mode. */
export function bind_slash_command_exit_render(request_render: (force: boolean) => void): void {
	slash_command_exit_render = request_render;
}

export function reset_slash_command_tracking(): void {
	was_slash_command = false;
	was_editor_autocomplete_visible = false;
	cancel_slash_exit_redraw();
}

/** Drop any deferred slash-exit render (e.g. during session shutdown). */
export function cancel_slash_exit_redraw(): void {
	slash_exit_redraw_generation += 1;
}

function editor_text_starts_with_slash(editor: { getText?: () => string }): boolean {
	return (editor.getText?.() ?? "").trimStart().startsWith("/");
}

/** Mark slash mode active after programmatic `/model ` (or similar) editor writes. */
export function sync_slash_command_active(editor: { getText?: () => string }): void {
	was_slash_command = editor_text_starts_with_slash(editor);
}

type TuiSnapInternals = {
	terminal: { rows: number; columns: number };
	render: (width: number) => string[];
	maxLinesRendered?: number;
	previousViewportTop?: number;
	setClearOnShrink?: (enabled: boolean) => void;
	requestRender?: (force?: boolean) => void;
	stopped?: boolean;
};

type EditorWithTui = {
	getText?: () => string;
	isShowingAutocomplete?: () => boolean;
	tui?: TuiSnapInternals;
};

function editor_is_showing_autocomplete(editor: EditorWithTui): boolean {
	return editor.isShowingAutocomplete?.() === true;
}

/** Pi defaults clearOnShrink off; enable once so shrink redraws can clear stale rows. */
export function enable_tui_clear_on_shrink(tui: TUI): void {
	(tui as unknown as TuiSnapInternals).setClearOnShrink?.(true);
}

/**
 * Prime Pi's clearOnShrink full redraw on the next doRender(). Never use
 * requestRender(true) here — its width/height reset homes the buffer and breaks
 * bottom anchoring after overflow.
 */
function prime_overlay_collapse_shrink_redraw(tui: TuiSnapInternals, line_count: number): void {
	const height = tui.terminal.rows;
	tui.maxLinesRendered = Math.max(tui.maxLinesRendered ?? 0, line_count + 1);
	if (line_count > height) {
		tui.previousViewportTop = Math.max(0, line_count - height);
	}
	tui.setClearOnShrink?.(true);
}

/**
 * After slash/autocomplete overlay collapse: clear stale autocomplete rows and
 * re-anchor the bottom viewport. Uses Pi's clearOnShrink path, not requestRender(true).
 */
export function request_overlay_collapse_viewport_snap(editor?: EditorWithTui): void {
	const generation = slash_exit_redraw_generation;
	const run = (): void => {
		if (generation !== slash_exit_redraw_generation) return;
		const tui = editor?.tui;
		if (tui?.stopped) return;
		if (tui?.requestRender && tui.terminal && tui.render) {
			const line_count = tui.render(tui.terminal.columns).length;
			prime_overlay_collapse_shrink_redraw(tui, line_count);
			tui.requestRender(false);
			return;
		}
		slash_command_exit_render?.(false);
	};
	if (editor?.tui?.requestRender) {
		run();
		return;
	}
	process.nextTick(run);
}

/**
 * Call after every editor handleInput (including early-return escape clears).
 * When slash mode ends or the slash autocomplete overlay collapses, schedule a
 * viewport snap via Pi's clearOnShrink redraw.
 */
export function finalize_editor_input_after(editor: EditorWithTui): void {
	const is_slash = editor_text_starts_with_slash(editor);
	const autocomplete_visible = editor_is_showing_autocomplete(editor);
	const should_snap_viewport =
		(was_slash_command && !is_slash) || (was_editor_autocomplete_visible && !autocomplete_visible);
	if (should_snap_viewport) {
		request_overlay_collapse_viewport_snap(editor);
	}
	was_slash_command = is_slash;
	was_editor_autocomplete_visible = autocomplete_visible;
}

function is_editor_component(value: RenderableChild): boolean {
	const candidate = value as RenderableChild & {
		getText?: () => string;
		handleInput?: (data: string) => void;
	};
	return typeof candidate.getText === "function" && typeof candidate.handleInput === "function";
}

export function find_editor_container(tui: TUI): RenderableChild | undefined {
	return (tui.children as readonly RenderableChild[]).find((child) =>
		child.children?.some((nested) => is_editor_component(nested)),
	);
}

function widget_container_above_editor(tui: TUI):
	| (RenderableChild & {
			children?: RenderableChild[];
	  })
	| undefined {
	const children = tui.children as RenderableChild[];
	const editor_container = find_editor_container(tui);
	if (!editor_container) return undefined;
	const editor_index = children.indexOf(editor_container);
	if (editor_index <= 0) return undefined;
	return children[editor_index - 1] as RenderableChild & {
		children?: RenderableChild[];
	};
}

/**
 * Keep exactly one leading Spacer in the above-editor widget container.
 * Padding sits above Thinking/Working when visible, otherwise above the chatbox.
 */
export function ensure_chatbox_leading_spacer(tui: TUI): void {
	const widget_above = widget_container_above_editor(tui);
	if (!widget_above?.children) return;
	const without_leading_spacers = widget_above.children.filter(
		(child) => child?.constructor?.name !== "Spacer",
	);
	const first = widget_above.children[0];
	if (
		widget_above.children.length === without_leading_spacers.length + 1 &&
		first instanceof Spacer &&
		(first as unknown as { lines: number }).lines === CHATBOX_LEADING_ROWS
	) {
		return;
	}
	widget_above.children.length = 0;
	widget_above.children.push(new Spacer(CHATBOX_LEADING_ROWS), ...without_leading_spacers);
}
