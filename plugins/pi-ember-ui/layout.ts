import { Spacer, type TUI } from "@earendil-works/pi-tui";
import { isScrollReviewActive, setScrollReviewActive } from "./mode-colors.ts";

/** Blank rows above the chatbox, or above Thinking when that widget is visible. */
export const CHATBOX_LEADING_ROWS = 1;

export type RenderableChild = {
	render: (width: number) => string[];
	children?: readonly RenderableChild[];
};

let was_slash_command = false;
let was_editor_autocomplete_visible = false;
let slash_exit_redraw_generation = 0;
let slash_command_exit_render: (() => void) | undefined;

/** Wire the native Pi render request used after slash/autocomplete changes. */
export function bind_slash_command_exit_render(request_render: () => void): void {
	slash_command_exit_render = request_render;
}

export function reset_slash_command_tracking(): void {
	was_slash_command = false;
	was_editor_autocomplete_visible = false;
	cancel_slash_exit_redraw();
}

/** Drop any deferred slash-exit render, for example during shutdown. */
export function cancel_slash_exit_redraw(): void {
	slash_exit_redraw_generation += 1;
}

function editor_text_starts_with_slash(editor: { getText?: () => string }): boolean {
	return (editor.getText?.() ?? "").trimStart().startsWith("/");
}

/** Mark slash mode active after programmatic `/model ` (or similar) writes. */
export function sync_slash_command_active(editor: { getText?: () => string }): void {
	was_slash_command = editor_text_starts_with_slash(editor);
}

type EditorWithTui = {
	getText?: () => string;
	isShowingAutocomplete?: () => boolean;
	tui?: { requestRender?: () => void };
};

function editor_is_showing_autocomplete(editor: EditorWithTui): boolean {
	return editor.isShowingAutocomplete?.() === true;
}

/** Exit scroll review and let Pi render the current component tree normally. */
export function resume_scroll_follow_from_editor(editor?: EditorWithTui): void {
	if (!isScrollReviewActive()) return;
	setScrollReviewActive(false);
	editor?.tui?.requestRender?.();
}

export function reset_scroll_review_state(): void {
	setScrollReviewActive(false);
}

/**
 * Request a normal native render after slash/autocomplete state changes.
 * Pi owns line clearing, viewport placement, cursor positioning, and all
 * differential bookkeeping; this helper only defers the public request until
 * the editor has finished mutating its component tree.
 */
export function request_overlay_collapse_render(_editor?: EditorWithTui): void {
	const generation = slash_exit_redraw_generation;
	process.nextTick(() => {
		if (generation !== slash_exit_redraw_generation) return;
		slash_command_exit_render?.();
	});
}

/** Call after every editor handleInput, including early-return escape paths. */
export function finalize_editor_input_after(editor: EditorWithTui): void {
	const is_slash = editor_text_starts_with_slash(editor);
	const autocomplete_visible = editor_is_showing_autocomplete(editor);
	const should_collapse_overlay =
		(was_slash_command && !is_slash) ||
		(was_editor_autocomplete_visible && !autocomplete_visible);
	if (should_collapse_overlay) request_overlay_collapse_render(editor);
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
	| (RenderableChild & { children?: RenderableChild[] })
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

/** Keep exactly one leading Spacer in the above-editor widget container. */
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
