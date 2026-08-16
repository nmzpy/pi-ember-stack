import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** One canonical scanner: non-test TypeScript source under a directory tree. */
function source_files(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "test" && entry.name !== "node_modules") files.push(...source_files(full));
		} else if (entry.name.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

const plugins_root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** Concatenated non-test TypeScript source across every plugin directory. */
function all_plugin_source(): string {
	return source_files(plugins_root)
		.map((file) => fs.readFileSync(file, "utf8"))
		.join("\n");
}

describe("Pi renderer authority (whole plugins tree)", () => {
	test("no plugin enables the mouse protocol or consumes wheel/selection input", () => {
		const source = all_plugin_source();
		// Pi's TUI does not enable the mouse protocol; the terminal owns
		// scrollback and text selection. Ember must never request mouse
		// reporting (wheel/click delivery) or declare key-release interest.
		expect(source).not.toMatch(/\\x1b\[\?(?:1000|1002|1006|1015)h/);
		expect(source).not.toMatch(/\bwantsKeyRelease\b/);
	});

	test("no plugin writes terminal frames, replaces the renderer, or mutates differential state", () => {
		const source = all_plugin_source();
		// Direct, computed, and aliased terminal/scrollback writes (including
		// bracket access and any function invoked with a raw escape sequence).
		expect(source).not.toMatch(/\bterminal\.write\s*\(/);
		expect(source).not.toMatch(/\bstdout\.write\s*\(/);
		expect(source).not.toMatch(/\bwriteSync\s*\(/);
		expect(source).not.toMatch(/\b(?:terminal|stdout)\s*\[\s*["']write(?:Sync)?["']\s*\]\s*\(/);
		expect(source).not.toMatch(/\bwrite\s*\(\s*["']\\x1b\[/);
		// Renderer monkey patches and manual render calls — on the TUI, the
		// interactive mode, and the editor alike.
		expect(source).not.toMatch(/\.doRender\b/);
		expect(source).not.toMatch(/\.requestRender\s*=/);
		expect(source).not.toMatch(/\btui\.render\s*\(/);
		expect(source).not.toMatch(/\bTUI\.prototype\.(?:render|doRender|requestRender)\s*=/);
		expect(source).not.toMatch(
			/\bInteractiveMode\.prototype\.(?:render|doRender|requestRender)\s*=/,
		);
		expect(source).not.toMatch(/\bEditor\.prototype\.render\s*=/);
		// pi-tui private differential bookkeeping — reads and writes alike.
		expect(source).not.toMatch(
			/\b(?:previousLines|previousViewportTop|hardwareCursorRow|renderRequested|previousWidth|previousHeight|maxLinesRendered|cursorRow|lastRenderAt)\b/,
		);
		// pi-tui synchronized-output ownership (full redraws/scrollback clears).
		expect(source).not.toMatch(/\\x1b\[\?2026/);
		// Duplicate render schedulers / renderer internals.
		expect(source).not.toMatch(
			/\b(?:MIN_RENDER_INTERVAL_MS|forceNextRender|renderTimer|clearOnShrink|write_viewport_paint|write_viewport_diff)\b/,
		);
		// Legacy patch markers.
		expect(source).not.toContain("tui-render-patch");
		expect(source).not.toContain("in-place-render");
	});
});
