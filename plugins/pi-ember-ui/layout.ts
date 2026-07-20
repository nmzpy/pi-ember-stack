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

type CursorPos = { row: number; col: number } | null;

type TuiRenderInternals = {
	terminal: {
		rows: number;
		columns: number;
		clearScreen?: () => void;
		write?: (data: string) => void;
	};
	render: (width: number) => string[];
	previousLines?: string[];
	previousKittyImageIds?: Set<number>;
	previousWidth?: number;
	previousHeight?: number;
	cursorRow?: number;
	hardwareCursorRow?: number;
	maxLinesRendered?: number;
	previousViewportTop?: number;
	setClearOnShrink?: (enabled: boolean) => void;
	requestRender?: (force?: boolean) => void;
	stopped?: boolean;
	// Optional render-pipeline methods (same ones doRender calls). All guarded
	// with typeof checks so a missing method degrades gracefully rather than
	// crashing. Used by snap_tui_to_bottom to render the visible viewport
	// in-place without reprinting the entire transcript into scrollback.
	overlayStack?: unknown[];
	compositeOverlays?: (lines: string[], termWidth: number, termHeight: number) => string[];
	extractCursorPosition?: (lines: string[], height: number) => CursorPos;
	applyLineResets?: (lines: string[]) => string[];
	deleteKittyImages?: (ids: Set<number>) => string;
	collectKittyImageIds?: (lines: string[]) => Set<number>;
	positionHardwareCursor?: (cursorPos: CursorPos, totalLines: number) => void;
};

type EditorWithTui = {
	getText?: () => string;
	isShowingAutocomplete?: () => boolean;
	tui?: TuiRenderInternals;
};

function editor_is_showing_autocomplete(editor: EditorWithTui): boolean {
	return editor.isShowingAutocomplete?.() === true;
}

/** Keep Pi's shrink path from issuing full redraws that clear terminal scrollback. */
export function disable_tui_clear_on_shrink(tui: TUI): void {
	(tui as unknown as TuiRenderInternals).setClearOnShrink?.(false);
}

/**
 * Pin the chatbox to the bottom of the viewport while preserving terminal
 * scrollback AND without reprinting the entire transcript. This is the
 * scrollback-safe, bloat-free equivalent of Pi's `requestRender(true)`.
 *
 * It renders the full content via `tui.render(width)`, runs the same pipeline
 * as `doRender` (composite overlays, extract cursor, apply line resets), then
 * writes ONLY the bottom `height` lines (the visible viewport) to the terminal
 * with `\x1b[2J\x1b[H` (clears the visible screen, never `3J` which would
 * destroy scrollback). The full `newLines` array is stored in `previousLines`
 * so the next render is a correct differential against the full transcript —
 * nothing is lost, only the visible rows are painted.
 *
 * This eliminates the duplicate-snapshot bloat that happened when the old
 * snap reset `previousLines = []` and let `doRender`'s first-render branch
 * reprint every line of the transcript into the terminal buffer on each
 * toggle (holding the thinking-blocks toggle pushed N copies of the whole
 * transcript into scrollback). Printing only `height` lines means nothing
 * spills into scrollback: `2J\x1b[H` clears exactly `height` rows and the
 * `height` written lines fill exactly the visible screen.
 *
 * The snap completes the render synchronously and does NOT call
 * `requestRender` — any pending `requestRender` from Pi (e.g. `showStatus`)
 * fires next tick as a harmless no-op diff against the now-correct
 * `previousLines`.
 *
 * Use this for any snap that must re-pin the viewport after a line-count
 * shrink (compact-group collapse, thinking-toggle rebuild, slash-command
 * exit). Never call `tui.requestRender(true)` from render/lifecycle paths —
 * it emits `3J` and destroys scrollback.
 *
 * Returns true when the snap was applied, false when it could not run safely
 * (no TUI bound, TUI stopped, or the TUI lacks the render/write/clearScreen
 * methods the in-place render needs). Callers MUST NOT fall back to
 * `requestRender(true)` on a false return — a missing TUI means we are
 * outside a live TUI session where a snap is meaningless.
 */
export function snap_tui_to_bottom(tui: TuiRenderInternals | undefined | null): boolean {
	if (!tui) return false;
	if (tui.stopped) return false;
	if (typeof tui.terminal?.clearScreen !== "function") return false;
	if (typeof tui.terminal?.write !== "function") return false;
	if (typeof tui.render !== "function") return false;

	const width = tui.terminal.columns;
	const height = tui.terminal.rows;
	if (!width || !height) return false;

	// Render the full content (same call doRender makes).
	let new_lines = tui.render(width);
	// Composite overlays into the rendered lines, matching doRender.
	if (tui.overlayStack && tui.overlayStack.length > 0 && typeof tui.compositeOverlays === "function") {
		new_lines = tui.compositeOverlays(new_lines, width, height);
	}
	// Extract cursor marker before applying line resets (same order as doRender).
	const cursor_pos =
		typeof tui.extractCursorPosition === "function" ? tui.extractCursorPosition(new_lines, height) : null;
	if (typeof tui.applyLineResets === "function") {
		new_lines = tui.applyLineResets(new_lines);
	} else {
		// Minimal fallback: ensure each line is a string.
		for (let i = 0; i < new_lines.length; i++) {
			if (typeof new_lines[i] !== "string") new_lines[i] = String(new_lines[i] ?? "");
		}
	}

	// Only the visible viewport (bottom `height` lines) is written to the
	// terminal. This is the key difference from the old snap: printing `height`
	// lines after `2J\x1b[H` fills exactly the visible screen, so nothing spills
	// into scrollback no matter how tall the transcript is.
	const viewport_top = Math.max(0, new_lines.length - height);
	const visible_lines = new_lines.slice(viewport_top);

	// Build a synchronized-output buffer: delete previous kitty images, clear
	// the visible screen (2J, never 3J), then write the viewport lines.
	let buffer = "\x1b[?2026h";
	if (typeof tui.deleteKittyImages === "function" && tui.previousKittyImageIds) {
		buffer += tui.deleteKittyImages(tui.previousKittyImageIds);
	}
	buffer += "\x1b[2J\x1b[H";
	for (let i = 0; i < visible_lines.length; i++) {
		if (i > 0) buffer += "\r\n";
		buffer += visible_lines[i];
	}
	buffer += "\x1b[?2026l";
	tui.terminal.write(buffer);

	// Update all bookkeeping so the next render is a correct differential
	// against the FULL transcript (not just the visible slice).
	tui.previousLines = new_lines;
	tui.previousKittyImageIds =
		typeof tui.collectKittyImageIds === "function" ? tui.collectKittyImageIds(new_lines) : new Set();
	tui.cursorRow = Math.max(0, new_lines.length - 1);
	tui.hardwareCursorRow = Math.max(0, new_lines.length - 1);
	tui.maxLinesRendered = Math.max(tui.maxLinesRendered ?? 0, new_lines.length);
	tui.previousViewportTop = viewport_top;
	tui.previousWidth = width;
	tui.previousHeight = height;

	if (typeof tui.positionHardwareCursor === "function") {
		tui.positionHardwareCursor(cursor_pos, new_lines.length);
	}
	return true;
}

/**
 * After slash/autocomplete overlay collapse, preserve the chatbox viewport and
 * request only Pi's normal differential render. This lets the terminal remain
 * the owner of scrollback instead of priming Pi's full clear/redraw path.
 */
export function request_overlay_collapse_render(editor?: EditorWithTui): void {
	const generation = slash_exit_redraw_generation;
	const run = (): void => {
		if (generation !== slash_exit_redraw_generation) return;
		const tui = editor?.tui;
		if (snap_tui_to_bottom(tui)) return;
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
 * normal differential render after the upward-growing menu disappears.
 */
export function finalize_editor_input_after(editor: EditorWithTui): void {
	const is_slash = editor_text_starts_with_slash(editor);
	const autocomplete_visible = editor_is_showing_autocomplete(editor);
	const should_snap_viewport =
		(was_slash_command && !is_slash) || (was_editor_autocomplete_visible && !autocomplete_visible);
	if (should_snap_viewport) {
		request_overlay_collapse_render(editor);
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
