import { Spacer, type TUI } from "@earendil-works/pi-tui";
import { request_render } from "./render-intent.ts";

/** Blank rows above the chatbox, or above Thinking when that widget is visible. */
export const CHATBOX_LEADING_ROWS = 1;

export type RenderableChild = {
	render: (width: number) => string[];
	children?: readonly RenderableChild[];
};

/** No-op — slash collapse re-anchors were removed to preserve terminal scrollback. */
export function reset_slash_command_tracking(): void {}

/** No-op — kept for model-picker programmatic `/model ` writes. */
export function sync_slash_command_active(_editor: { getText?: () => string }): void {}

/**
 * Compatibility seam for callers that used to pass a TUI target. All live
 * render requests now use the session-safe render-intent singleton.
 */
export function request_live_tui_render(_tui?: unknown): void {
	request_render();
}

/** No-op — editor input must not force layout re-anchors (trackpad scrollback). */
export function finalize_editor_input_after(_editor: {
	getText?: () => string;
	isShowingAutocomplete?: () => boolean;
}): void {}

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

function widget_container_above_editor(
	tui: TUI,
): (RenderableChild & { children?: RenderableChild[] }) | undefined {
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
