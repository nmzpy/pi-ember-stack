import { describe, expect, test, beforeEach } from "bun:test";
import { Box, Editor, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { PromptGlyphContent, wrapEditorRenderForShell, type EditorWithBorder } from "../index.ts";
import { setUserBashRunning } from "../mode-colors.ts";

/** A single long chatbox message (same shape as the user message that
 *  crashed pi with "Rendered line 23 exceeds terminal width (122 > 121)"). */
const LONG_TEXT =
	"[image 1]- lets make Links visual representation look cooler, its way too much out there. it should rather be represented as link liek this: it makes the outline part of the IN block, the right edge it makes it have a gradient accent color fallofff towards the left, falling off towards 0 opacity nicely, for 15px of the block. do the same for the Out block, just on the right instead. if on different tracks, just still do it. and remove the cringey ass 'chain' we have now.";

function fakeTui(rows = 40): never {
	return { terminal: { rows }, requestRender() {} } as never;
}

function makeWrappedEditor(text: string): EditorWithBorder {
	const editor = new Editor(fakeTui(), { borderColor: (t) => t }, {}) as unknown as EditorWithBorder;
	editor.focused = true;
	editor.setText(text);
	wrapEditorRenderForShell(editor);
	return editor;
}

describe("chatbox editor wrap (regression: '...' at line end)", () => {
	beforeEach(() => {
		setUserBashRunning(false);
	});

	test("wrapped body rows never exceed the terminal width", () => {
		const editor = makeWrappedEditor(LONG_TEXT);
		for (const width of [121, 100, 80]) {
			const rows = editor.render(width);
			for (const row of rows) {
				expect(visibleWidth(row), `row at width ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("wrapped body rows are never ellipsis-truncated", () => {
		const editor = makeWrappedEditor(LONG_TEXT);
		const rows = editor.render(121);
		// Skip the two chatbox horizontal rules; every body row must contain
		// the full wrapped text — a truncateToWidth("...") tack-on means the
		// continuation row overflowed the reserved width.
		const body = rows.filter((row) => !row.includes("\u2500"));
		expect(body.length).toBeGreaterThan(1);
		for (const row of body) {
			expect(row).not.toContain("...");
		}
	});

	test("wrap holds while user bash streaming adds the extra inset column", () => {
		setUserBashRunning(true);
		const editor = makeWrappedEditor(LONG_TEXT);
		const rows = editor.render(121);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(121);
		}
	});

	test("single-line messages keep the prompt glyph on the first row", () => {
		const editor = makeWrappedEditor("hi there");
		const rows = editor.render(121);
		const body = rows.filter((row) => !row.includes("\u2500"));
		expect(body[0]).toContain("\u276d");
	});
});

describe("prompt-glyph user message (regression: 122 > 121 crash)", () => {
	const theme = { fg: (_color: string, text: string) => text };

	test("glyph-prefixed first row stays within the terminal width", () => {
		const markdown = new Markdown(
			LONG_TEXT,
			0,
			0,
			theme as never,
			{ color: (text: string) => text },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		const glyphContent = new PromptGlyphContent(markdown, theme);
		// Same nesting as the patched UserMessageComponent rebuild:
		// Box(outputPad=1) -> PromptGlyphContent -> Markdown.
		const box = new Box(1, 0, undefined);
		box.addChild(glyphContent);
		const rows = box.render(121);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(121);
		}
		// The first row must carry the prompt glyph.
		expect(rows[0]).toContain("\u276d");
	});

	test("narrow terminals stay safe too", () => {
		const markdown = new Markdown(
			LONG_TEXT,
			0,
			0,
			theme as never,
			{ color: (text: string) => text },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		const box = new Box(1, 0, undefined);
		box.addChild(new PromptGlyphContent(markdown, theme));
		for (const width of [60, 40]) {
			const rows = box.render(width);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("the prompt glyph renders exactly once per row, never accumulating", () => {
		const markdown = new Markdown(
			LONG_TEXT,
			0,
			0,
			theme as never,
			{ color: (text: string) => text },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		const glyphContent = new PromptGlyphContent(markdown, theme);
		// pi-tui Markdown caches its render output and returns the same array
		// reference every call. The wrapper must NOT mutate that array in
		// place — rendering the same component repeatedly (every TUI frame
		// re-renders the transcript) used to prepend another `❭ ` each time,
		// producing an infinite spam line.
		const glyphCount = (row: string): number => (row.match(/\u276d/g) ?? []).length;
		for (let i = 0; i < 5; i++) {
			const rows = glyphContent.render(119);
			expect(rows.length).toBeGreaterThan(0);
			expect(glyphCount(rows[0] ?? ""), `render #${i + 1}`).toBe(1);
		}
	});
});
