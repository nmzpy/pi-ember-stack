import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function source_files(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "test") files.push(...source_files(full));
		} else if (entry.name.endsWith(".ts")) {
			files.push(full);
		}
	}
	return files;
}

describe("Pi renderer authority", () => {
	test("plugins never replace Pi's renderer or differential snapshot", () => {
		const ui_dir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
		const source = source_files(ui_dir)
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");

		expect(source).not.toContain("tui-render-patch");
		expect(source).not.toContain("in-place-render");
		expect(source).not.toMatch(/\bpreviousLines\s*=/);
		expect(source).not.toMatch(/\bpreviousViewportTop\s*=/);
		expect(source).not.toMatch(/\bhardwareCursorRow\s*=/);
		expect(source).not.toMatch(/\b(?:previousWidth|previousHeight|renderRequested)\s*=/);
		expect(source).not.toMatch(/\.doRender\s*=/);
		expect(source).not.toMatch(/\.requestRender\s*=/);
		expect(source).not.toMatch(/\btui\.render\s*\(/);
		expect(source).not.toMatch(/\bterminal\.write\s*\(/);
		expect(source).not.toMatch(/\b(?:MIN_RENDER_INTERVAL_MS|forceNextRender|renderTimer|clearOnShrink)\b/);
		expect(source).not.toMatch(/\bwrite_viewport_(?:paint|diff)\b/);
		expect(source).not.toContain("Editor.prototype.render");
	});
});
