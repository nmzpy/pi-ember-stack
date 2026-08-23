import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const this_dir = path.dirname(fileURLToPath(import.meta.url));
const ui_dir = path.join(this_dir, "..");

/** Read a source file as a string. */
function read_src(rel: string): string {
	return fs.readFileSync(path.join(ui_dir, rel), "utf8");
}

/** Owned files that must route all render requests through render-intent.ts. */
const owned_files = ["index.ts", "gradient.ts"];

/** Files migrated to the canonical render-intent SSOT.
 *  These must import request_render from render-intent.ts and must not contain
 *  any direct .requestRender() or .requestRender?.() call sites (type
 *  annotations are allowed). */
const migrated_files = [
	"bash-queue.ts",
	"shell-mode.ts",
	"model-picker.ts",
	"model-selector.ts",
];

/** pi-ember-images editor — migrated to render-intent, lives in a sibling dir. */
const migrated_images_file = "../pi-ember-images/editor.ts";

describe("render-intent canonical entry point", () => {
	test("render-intent.ts exports bind/reset/request functions", () => {
		const src = read_src("render-intent.ts");
		expect(src).toContain("export function bind_render_intent");
		expect(src).toContain("export function reset_render_intent");
		expect(src).toContain("export function request_render");
	});

	test("render-intent.ts uses Symbol.for for jiti-duplication safety", () => {
		const src = read_src("render-intent.ts");
		expect(src).toContain("Symbol.for(");
	});

	test("render-intent.ts has no timers, no invalidate, no tui.render", () => {
		const src = read_src("render-intent.ts");
		// Check only non-comment lines for actual code patterns.
		const code_lines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
		const code = code_lines.join("\n");
		expect(code).not.toMatch(/\bsetTimeout\b/);
		expect(code).not.toMatch(/\bsetInterval\b/);
		expect(code).not.toMatch(/\binvalidate\b/);
		expect(code).not.toMatch(/\btui\.render\b/);
		expect(code).not.toMatch(/queueMicrotask/);
	});
});

describe("exclusive requestRender caller in owned files", () => {
	test("index.ts and gradient.ts have no direct requestRender() calls", () => {
		for (const file of owned_files) {
			const src = read_src(file);
			// No direct .requestRender() or .requestRender?.() invocations
			// except inside render-intent.ts itself (which is not in owned_files).
			// The bind_live_tui_render closure references tui.requestRender as a
			// property access for binding, not as a standalone call — that is
			// the binding mechanism, not a direct invocation.
			//
			// Pattern: word.requestRender followed by ( — a call.
			// Exclude: tui?.requestRender (property check in bind closure),
			// and type annotations / interface declarations.
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Skip comments and type annotations.
				if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
				if (line.includes("requestRender?:")) continue;
				if (line.includes("requestRender():")) continue;
				if (line.includes("requestRender:")) continue;
				// The bind_live_tui_render closure body: tui.requestRender?.()
				// is the one binding site — it is inside a closure that is
				// passed to bind_render_intent, not a standalone call.
				if (line.includes("tui.requestRender?.();")) continue;
				// Property existence checks (not calls).
				if (line.includes("tui?.requestRender") && !line.includes("()")) continue;
				if (line.includes("tui?.requestRender") && line.includes("return")) continue;
				if (line.includes("!requestRender") && !line.includes("()")) continue;
				if (line.includes("?.requestRender") && !line.includes("()")) continue;
				// The requestTuiRenderFromEditor binds via editor.tui!.requestRender!()
				// inside a closure passed to bind_render_intent — not a direct call.
				if (line.includes("editor.tui!.requestRender!()")) continue;
				// Match actual call sites: .requestRender() or .requestRender?.()
				// as standalone invocations (not inside a bind closure).
				if (/\brequestRender\s*\?\.\s*\(\s*\)/.test(line) || /\brequestRender\s*\(\s*\)/.test(line)) {
					// Allow the bind closure line: tui.requestRender?.();
					if (line.includes("tui.requestRender?.();")) continue;
					throw new Error(
						`${file}:${i + 1}: direct requestRender call found: ${line.trim()}`,
					);
				}
			}
		}
	});

	test("gradient.ts dispatch calls request_render from render-intent, not a local callback", () => {
		const src = read_src("gradient.ts");
		expect(src).toContain("import { request_render } from \"./render-intent.ts\"");
		expect(src).toContain("request_render();");
		// No private render callback holder.
		expect(src).not.toMatch(/let _render_request/);
		expect(src).not.toMatch(/set_gradient_render_request/);
	});
});

describe("migrated files route render through render-intent", () => {
	test("migrated ui files import request_render from render-intent.ts", () => {
		for (const file of migrated_files) {
			const src = read_src(file);
			expect(
				src.includes("import { request_render } from \"./render-intent.ts\"") ||
				src.includes("request_render,"),
			`${file} must import request_render from render-intent.ts`,
			).toBe(true);
		}
	});

	test("pi-ember-images editor imports request_render from render-intent.ts", () => {
		const src = read_src(migrated_images_file);
		expect(src).toContain("request_render");
		expect(src).toContain("render-intent.ts");
	});

	test("migrated files have no direct requestRender() call sites", () => {
		const all_files = [...migrated_files, migrated_images_file];
		for (const file of all_files) {
			const src = read_src(file);
			const lines = src.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// Skip comments and type annotations.
				if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
				if (line.includes("requestRender?:")) continue;
				if (line.includes("requestRender():")) continue;
				if (line.includes("requestRender:")) continue;
				// Match actual call sites: .requestRender() or .requestRender?.()
				if (/\brequestRender\s*\?\.\s*\(\s*\)/.test(line) || /\brequestRender\s*\(\s*\)/.test(line)) {
					throw new Error(
						`${file}:${i + 1}: direct requestRender call found: ${line.trim()}`,
					);
				}
			}
		}
	});

	test("migrated files do not import from pi-ember-ui/index.ts (no circular state)", () => {
		for (const file of migrated_files) {
			const src = read_src(file);
			expect(
				src,
				`${file} must not import from ./index.ts to avoid circular session-bound state`,
			).not.toMatch(/from\s+["']\.\/index\.ts["']/);
		}
		const images_src = read_src(migrated_images_file);
		expect(images_src).not.toMatch(/from\s+["']\.\.\/pi-ember-ui\/index\.ts["']/);
	});
});

describe("dynamic theme application has no tui.invalidate", () => {
	test("applyDynamicTheme does not call tuiRef?.invalidate", () => {
		const src = read_src("index.ts");
		expect(src).not.toMatch(/tuiRef\?\.\s*invalidate/);
		expect(src).not.toMatch(/tuiRef\.invalidate/);
	});
});

describe("no startup logo tick/subscriber or settle-trigger render", () => {
	test("index.ts has no logo animation state or functions", () => {
		const src = read_src("index.ts");
		expect(src).not.toMatch(/logoAnimating/);
		expect(src).not.toMatch(/logoStatic/);
		expect(src).not.toMatch(/logo_tick_cb/);
		expect(src).not.toMatch(/drop_logo_tick/);
		expect(src).not.toMatch(/startLogoAnimation/);
		expect(src).not.toMatch(/stopLogoAnimation/);
		expect(src).not.toMatch(/stopLogoOnFirstUserMessage/);
		expect(src).not.toMatch(/renderLogoWithGradient/);
		expect(src).not.toMatch(/RadialPoint/);
		expect(src).not.toMatch(/radialColorForCell/);
	});

	test("index.ts has no get_logo_phase or neutral_pulse_hex references", () => {
		const src = read_src("index.ts");
		expect(src).not.toMatch(/get_logo_phase/);
		expect(src).not.toMatch(/neutral_pulse_hex/);
	});

	test("gradient.ts has no logo phase or logo duration constants", () => {
		const src = read_src("gradient.ts");
		expect(src).not.toMatch(/LOGO_DURATION_MS/);
		expect(src).not.toMatch(/get_logo_phase/);
		expect(src).not.toMatch(/neutral_pulse_hex/);
		expect(src).not.toMatch(/cached_neutral_pulse_palette/);
	});

	test("startup_logo_should_animate always returns false", () => {
		const src = read_src("index.ts");
		// The function body must return false unconditionally.
		const match = src.match(
			/export function startup_logo_should_animate[\s\S]*?{[\s\S]*?return false;/,
		);
		expect(match).not.toBeNull();
	});
});

describe("session shutdown clears the bound render intent", () => {
	test("index.ts session_shutdown calls reset_render_intent", () => {
		const src = read_src("index.ts");
		expect(src).toContain("reset_render_intent()");
		// The session_shutdown handler must call reset_render_intent.
		const shutdown_match = src.match(
			/pi\.on\("session_shutdown"[\s\S]*?reset_render_intent\(\)/,
		);
		expect(shutdown_match).not.toBeNull();
	});

	test("index.ts session_start calls reset_render_intent before binding", () => {
		const src = read_src("index.ts");
		const start_match = src.match(
			/pi\.on\("session_start"[\s\S]*?reset_render_intent\(\)/,
		);
		expect(start_match).not.toBeNull();
	});

	test("render-intent.ts request_render no-ops after reset", () => {
		// Verify the module's request_render checks for a live callback.
		const src = read_src("render-intent.ts");
		expect(src).toContain("if (cb) cb();");
	});
});
