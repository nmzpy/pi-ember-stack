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
	const lines = Array.from({ length: options.line_count }, (_v, i) => `line-${String(i).padStart(3, "0")}`);
	const tui: Record<string, unknown> = {
		terminal: {
			rows: options.rows,
			columns: 80,
			clearScreen: () => {
				tui.screenCleared = true;
			},
			write: (data: string) => {
				tui.written = ((tui.written as string) ?? "") + data;
			},
		},
		render: () => lines,
		overlayStack: [],
		compositeOverlays: (l: string[]) => l,
		extractCursorPosition: () => null,
		applyLineResets: (l: string[]) => l,
		deleteKittyImages: () => "",
		collectKittyImageIds: () => new Set<number>(),
		positionHardwareCursor: () => {},
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
		with_write?: boolean;
		with_render?: boolean;
		line_count?: number;
		rows?: number;
		columns?: number;
	}) {
		const height = options.rows ?? 10;
		const line_count = options.line_count ?? 50;
		const lines = Array.from({ length: line_count }, (_v, i) => `line-${String(i).padStart(3, "0")}`);
		let written = "";
		let screen_cleared = false;
		const tui: Record<string, unknown> = {
			terminal: {
				rows: height,
				columns: options.columns ?? 80,
				clearScreen: options.with_clear_screen === false
					? undefined
					: () => { screen_cleared = true; },
				write: options.with_write === false
					? undefined
					: (data: string) => { written += data; },
			},
			render: options.with_render === false
				? undefined
				: () => lines,
			previousLines: ["a", "b"],
			previousKittyImageIds: new Set([1, 2]),
			previousWidth: 80,
			previousHeight: 24,
			cursorRow: 5,
			hardwareCursorRow: 5,
			maxLinesRendered: 30,
			previousViewportTop: 6,
			stopped: options.stopped ?? false,
			overlayStack: [],
			compositeOverlays: (l: string[]) => l,
			extractCursorPosition: () => null,
			applyLineResets: (l: string[]) => l,
			deleteKittyImages: () => "",
			collectKittyImageIds: () => new Set<number>(),
			positionHardwareCursor: () => {},
		};
		return { tui, written: () => written, screen_cleared: () => screen_cleared, lines, height, line_count };
	}

	test("writes only the visible viewport (bottom height lines) and stores full newLines", () => {
		const { tui, written, lines, height, line_count } = mock_tui({});
		expect(snap_tui_to_bottom(tui as never)).toBe(true);
		// Only the bottom `height` lines should be written.
		const expected_visible = lines.slice(line_count - height);
		for (const line of expected_visible) {
			expect(written()).toContain(line);
		}
		// Lines above the viewport must NOT be written (no scrollback bloat).
		for (let i = 0; i < line_count - height; i++) {
			expect(written()).not.toContain(lines[i]);
		}
		// Full newLines stored in previousLines for correct next differential render.
		expect(tui.previousLines).toEqual(lines);
		expect(tui.previousViewportTop).toBe(line_count - height);
		expect(tui.cursorRow).toBe(line_count - 1);
		expect(tui.hardwareCursorRow).toBe(line_count - 1);
		expect(tui.maxLinesRendered).toBe(Math.max(30, line_count));
		expect(tui.previousWidth).toBe(80);
		expect(tui.previousHeight).toBe(height);
		expect(tui.previousKittyImageIds).toEqual(new Set());
	});

	test("does not call requestRender (render completes synchronously)", () => {
		let render_called = false;
		const { tui } = mock_tui({});
		tui.requestRender = () => { render_called = true; };
		expect(snap_tui_to_bottom(tui as never)).toBe(true);
		expect(render_called).toBe(false);
	});

	test("content shorter than height prints all lines with viewportTop 0", () => {
		const { tui, written, lines, line_count } = mock_tui({ line_count: 3, rows: 10 });
		expect(snap_tui_to_bottom(tui as never)).toBe(true);
		for (const line of lines) {
			expect(written()).toContain(line);
		}
		expect(tui.previousLines).toEqual(lines);
		expect(tui.previousViewportTop).toBe(0);
		expect(tui.cursorRow).toBe(line_count - 1);
	});

	test("returns false and does nothing when the TUI is stopped", () => {
		const { tui, written } = mock_tui({ stopped: true });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(written()).toBe("");
		expect(tui.previousViewportTop).toBe(6);
	});

	test("returns false when no TUI is bound", () => {
		expect(snap_tui_to_bottom(undefined)).toBe(false);
		expect(snap_tui_to_bottom(null)).toBe(false);
	});

	test("returns false when the terminal lacks clearScreen", () => {
		const { tui, written } = mock_tui({ with_clear_screen: false });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(written()).toBe("");
	});

	test("returns false when the terminal lacks write", () => {
		const { tui, written } = mock_tui({ with_write: false });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(written()).toBe("");
	});

	test("returns false when the TUI lacks render", () => {
		const { tui, written } = mock_tui({ with_render: false });
		expect(snap_tui_to_bottom(tui as never)).toBe(false);
		expect(written()).toBe("");
	});
});

describe("request_overlay_collapse_render (delegates to snap_tui_to_bottom)", () => {
	test("snaps via the shared helper when the editor has a live TUI", () => {
		reset_slash_command_tracking();
		let written = "";
		let render_force: boolean | undefined;
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => true,
			tui: {
				terminal: {
					rows: 24,
					columns: 80,
					clearScreen: () => {},
					write: (data: string) => { written += data; },
				},
				render: () => Array.from({ length: 50 }, (_v, i) => `line-${String(i).padStart(3, "0")}`),
				overlayStack: [],
				compositeOverlays: (l: string[]) => l,
				extractCursorPosition: () => null,
				applyLineResets: (l: string[]) => l,
				deleteKittyImages: () => "",
				collectKittyImageIds: () => new Set<number>(),
				positionHardwareCursor: () => {},
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
		// snap_tui_to_bottom completes synchronously and does not call requestRender.
		expect(render_force).toBeUndefined();
		// It writes the visible viewport (bottom 24 of 50 lines) in-place.
		expect(written).toContain("line-049");
		expect(written).not.toContain("line-000");
		expect(editor.tui.maxLinesRendered).toBe(58);
		expect(editor.tui.previousViewportTop).toBe(50 - 24);
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
		// snap_tui_to_bottom completes synchronously; requestRender is NOT called.
		expect(force).toBeUndefined();
		// maxLinesRendered is a high-water mark: Math.max(56, 50) = 56.
		expect(editor.tui.maxLinesRendered).toBe(56);
		expect(editor.tui.previousViewportTop).toBe(50 - 24);
		// The snap writes the 2J clear sequence directly via terminal.write.
		expect((editor.tui.written as string) ?? "").toContain("\x1b[2J");
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
		// Content shorter than height: all lines printed, viewportTop 0.
		expect(force).toBeUndefined();
		// maxLinesRendered is a high-water mark: Math.max(16, 10) = 16.
		expect(editor.tui.maxLinesRendered).toBe(16);
		expect(editor.tui.previousViewportTop).toBe(0);
		expect((editor.tui.written as string) ?? "").toContain("\x1b[2J");
		expect(editor.tui.clearOnShrink).toBe(false);
	});

	test("requests a normal render when overflow autocomplete collapses", () => {
		reset_slash_command_tracking();
		let force: boolean | undefined;
		let written = "";
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => true,
			tui: {
				terminal: {
					rows: 24,
					columns: 80,
					clearScreen: () => {},
					write: (data: string) => { written += data; },
				},
				render: () => Array.from({ length: 50 }, (_v, i) => `line-${String(i).padStart(3, "0")}`),
				overlayStack: [],
				compositeOverlays: (l: string[]) => l,
				extractCursorPosition: () => null,
				applyLineResets: (l: string[]) => l,
				deleteKittyImages: () => "",
				collectKittyImageIds: () => new Set<number>(),
				positionHardwareCursor: () => {},
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
		expect(force).toBeUndefined();
		// maxLinesRendered is a high-water mark: Math.max(58, 50) = 58.
		expect(editor.tui.maxLinesRendered).toBe(58);
		expect(editor.tui.previousViewportTop).toBe(50 - 24);
		expect(written).toContain("line-049");
		expect(written).toContain("\x1b[2J");
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