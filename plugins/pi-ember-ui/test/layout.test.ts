import { Spacer } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";
import {
	bind_slash_command_exit_render,
	cancel_slash_exit_redraw,
	CHATBOX_LEADING_ROWS,
	disable_tui_clear_on_shrink,
	ensure_chatbox_leading_spacer,
	finalize_editor_input_after,
	request_overlay_collapse_render,
	reset_slash_command_tracking,
	snap_tui_to_bottom,
} from "../layout.ts";

function mock_tui_with_widget_above(widget_children: unknown[]): {
	children: unknown[];
} {
	const editor = {
		getText: () => "",
		handleInput: () => {},
	};
	return {
		children: [{ children: widget_children }, { children: [editor] }],
	};
}

function mock_editor_with_tui(options: {
	rows: number;
	line_count: number;
	max_lines_rendered?: number;
	requestRender?: (force?: boolean) => void;
}) {
	const lines = Array.from({ length: options.line_count }, () => "line");
	const tui: Record<string, unknown> = {
		terminal: {
			rows: options.rows,
			columns: 80,
			clearScreen: () => {
				tui.screenCleared = true;
			},
		},
		render: () => lines,
		maxLinesRendered: options.max_lines_rendered ?? options.line_count,
		previousViewportTop: 0,
		setClearOnShrink: (enabled: boolean) => {
			tui.clearOnShrink = enabled;
		},
		clearOnShrink: false,
		requestRender: options.requestRender,
	};
	return {
		getText: () => "/model ",
		isShowingAutocomplete: () => false,
		tui,
	};
}

describe("chatbox leading spacer", () => {
	test("inserts one spacer above widgets so Working sits flush on the chatbox", () => {
		const thinking_widget = { constructor: { name: "Text" }, render: () => ["Working"] };
		const tui = mock_tui_with_widget_above([thinking_widget]);
		ensure_chatbox_leading_spacer(tui as never);
		const children = (tui.children[0] as { children: unknown[] }).children;
		expect(children).toHaveLength(2);
		expect(children[0]).toBeInstanceOf(Spacer);
		expect((children[0] as Spacer).lines).toBe(CHATBOX_LEADING_ROWS);
		expect(children[1]).toBe(thinking_widget);
	});

	test("normalizes duplicate leading spacers to the SSOT row count", () => {
		const thinking_widget = { constructor: { name: "Text" }, render: () => ["Working"] };
		const tui = mock_tui_with_widget_above([
			new Spacer(1),
			new Spacer(1),
			thinking_widget,
		]);
		ensure_chatbox_leading_spacer(tui as never);
		const children = (tui.children[0] as { children: unknown[] }).children;
		expect(children).toHaveLength(2);
		expect((children[0] as Spacer).lines).toBe(CHATBOX_LEADING_ROWS);
	});
});

describe("TUI shrink redraw", () => {
	test("disables clearOnShrink on the live TUI instance", () => {
		let enabled: boolean | undefined;
		const tui = { setClearOnShrink: (value: boolean) => {
			enabled = value;
		} };
		disable_tui_clear_on_shrink(tui as never);
		expect(enabled).toBe(false);
	});
});

describe("snap_tui_to_bottom", () => {
	function mock_tui(options: {
		stopped?: boolean;
		with_clear_screen?: boolean;
		with_request_render?: boolean;
	}) {
		let screen_cleared = false;
		let render_force: boolean | undefined;
		const tui = {
			terminal: options.with_clear_screen === false
				? {}
				: { clearScreen: () => { screen_cleared = true; } },
			previousLines: ["a", "b"],
			previousKittyImageIds: new Set([1, 2]),
			previousWidth: 80,
			previousHeight: 24,
			cursorRow: 5,
			hardwareCursorRow: 5,
			maxLinesRendered: 30,
			previousViewportTop: 6,
			stopped: options.stopped ?? false,
			requestRender: options.with_request_render === false
				? undefined
				: (force?: boolean) => { render_force = force; },
		};
		return { tui, screen_cleared: () => screen_cleared, render_force: () => render_force };
	}

	test("clears visible screen, resets bookkeeping, and requests a normal (non-forced) render", () => {
		const { tui, screen_cleared, render_force } = mock_tui({});
		expect(snap_tui_to_bottom(tui as never)).toBe(true);
		expect(screen_cleared()).toBe(true);
		expect(render_force()).toBe(false);
		expect(tui.previousLines).toEqual([]);
		expect(tui.previousKittyImageIds).toEqual(new Set());
		expect(tui.previousWidth).toBe(0);
		expect(tui.previousHeight).toBe(0);
		expect(tui.cursorRow).toBe(0);
		expect(tui.hardwareCursorRow).toBe(0);
		expect(tui.maxLinesRendered).toBe(0);
		expect(tui.previousViewportTop).toBe(0);
	});

	test("returns false and does nothing when the TUI is stopped", () => {
		const { tui, screen_cleared, render_force } = mock_tui({ stopped: true });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(screen_cleared()).toBe(false);
		expect(render_force()).toBeUndefined();
		expect(tui.previousViewportTop).toBe(6);
	});

	test("returns false when no TUI is bound", () => {
		expect(snap_tui_to_bottom(undefined)).toBe(false);
		expect(snap_tui_to_bottom(null)).toBe(false);
	});

	test("returns false when the terminal lacks clearScreen", () => {
		const { tui, screen_cleared, render_force } = mock_tui({ with_clear_screen: false });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(screen_cleared()).toBe(false);
		expect(render_force()).toBeUndefined();
	});

	test("returns false when the TUI lacks requestRender", () => {
		const { tui, screen_cleared, render_force } = mock_tui({ with_request_render: false });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(screen_cleared()).toBe(false);
		expect(render_force()).toBeUndefined();
	});
});

describe("request_overlay_collapse_render (delegates to snap_tui_to_bottom)", () => {
	test("snaps via the shared helper when the editor has a live TUI", () => {
		reset_slash_command_tracking();
		let screen_cleared = false;
		let render_force: boolean | undefined;
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => true,
			tui: {
				terminal: { rows: 24, columns: 80, clearScreen: () => { screen_cleared = true; } },
				render: () => Array.from({ length: 50 }, () => "line"),
				maxLinesRendered: 58,
				previousViewportTop: 12,
				setClearOnShrink(enabled: boolean) {
					(this as { clearOnShrink: boolean }).clearOnShrink = enabled;
				},
				clearOnShrink: false,
				requestRender: (f?: boolean) => { render_force = f; },
			},
		};
		request_overlay_collapse_render(editor as never);
		expect(render_force).toBe(false);
		expect(screen_cleared).toBe(true);
		expect(editor.tui.maxLinesRendered).toBe(0);
		expect(editor.tui.previousViewportTop).toBe(0);
	});
});

describe("slash command exit render", () => {
	test("requests a normal render when overflow content exits slash mode", () => {
		reset_slash_command_tracking();
		let force: boolean | undefined;
		const editor = mock_editor_with_tui({
			rows: 24,
			line_count: 50,
			max_lines_rendered: 56,
			requestRender: (f?: boolean) => {
				force = f;
			},
		});
		finalize_editor_input_after(editor);
		editor.getText = () => "";
		finalize_editor_input_after(editor);
		expect(force).toBe(false);
		expect(editor.tui.maxLinesRendered).toBe(0);
		expect(editor.tui.previousViewportTop).toBe(0);
		expect(editor.tui.screenCleared).toBe(true);
		expect(editor.tui.clearOnShrink).toBe(false);
	});

	test("does not enable clearOnShrink for short content", () => {
		reset_slash_command_tracking();
		let force: boolean | undefined;
		const editor = mock_editor_with_tui({
			rows: 40,
			line_count: 10,
			max_lines_rendered: 16,
			requestRender: (f?: boolean) => {
				force = f;
			},
		});
		finalize_editor_input_after(editor);
		editor.getText = () => "";
		finalize_editor_input_after(editor);
		expect(force).toBe(false);
		expect(editor.tui.maxLinesRendered).toBe(0);
		expect(editor.tui.previousViewportTop).toBe(0);
		expect(editor.tui.screenCleared).toBe(true);
		expect(editor.tui.clearOnShrink).toBe(false);
	});

	test("requests a normal render when overflow autocomplete collapses", () => {
		reset_slash_command_tracking();
		let force: boolean | undefined;
		let screen_cleared = false;
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => true,
			tui: {
				terminal: {
					rows: 24,
					columns: 80,
					clearScreen: () => {
						screen_cleared = true;
					},
				},
				render: () => Array.from({ length: 50 }, () => "line"),
				maxLinesRendered: 58,
				previousViewportTop: 0,
				setClearOnShrink(enabled: boolean) {
					(this as { clearOnShrink: boolean }).clearOnShrink = enabled;
				},
				clearOnShrink: false,
				requestRender: (f?: boolean) => {
					force = f;
				},
			},
		};
		finalize_editor_input_after(editor);
		editor.isShowingAutocomplete = () => false;
		finalize_editor_input_after(editor);
		expect(force).toBe(false);
		expect(editor.tui.maxLinesRendered).toBe(0);
		expect(editor.tui.previousViewportTop).toBe(0);
		expect(screen_cleared).toBe(true);
		expect(editor.tui.clearOnShrink).toBe(false);
	});

	test("cancels deferred slash-exit redraw during shutdown", async () => {
		reset_slash_command_tracking();
		let called = false;
		bind_slash_command_exit_render(() => {
			called = true;
		});
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => false,
		};
		finalize_editor_input_after(editor);
		editor.getText = () => "";
		finalize_editor_input_after(editor);
		cancel_slash_exit_redraw();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		expect(called).toBe(false);
	});

	test("falls back to bound render request when editor has no tui", async () => {
		reset_slash_command_tracking();
		let force: boolean | undefined;
		bind_slash_command_exit_render((f) => {
			force = f;
		});
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => false,
		};
		finalize_editor_input_after(editor);
		editor.getText = () => "";
		finalize_editor_input_after(editor);
		expect(force).toBeUndefined();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		expect(force).toBe(false);
	});
});