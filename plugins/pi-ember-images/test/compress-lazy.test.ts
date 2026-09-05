import { describe, expect, test } from "bun:test";

/**
 * Regression test for the lazy sharp loading in compress.ts.
 *
 * sharp is a heavy native dependency. It must never be imported eagerly at
 * module/startup load time — only lazily via a cached dynamic import when the
 * first attachment is actually encoded. This guards against someone reverting
 * to a static `import sharp from "sharp"` at the top of compress.ts.
 *
 * Asserting on the module source is deliberate: it is the only way to observe
 * the load-time import graph without globally mocking "sharp", which would leak
 * into the other compress tests that use the real sharp module.
 */

const SOURCE = await Bun.file(new URL("../compress.ts", import.meta.url)).text();

describe("compressAttachment lazy sharp loading", () => {
	test("does not statically import sharp at module top level", () => {
		// A static `import ... from "sharp"` would eagerly load sharp at startup.
		expect(/^\s*import\s+[^"']*\s+from\s+["']sharp["']/m.test(SOURCE)).toBe(false);
	});

	test("loads sharp through a dynamic import", () => {
		expect(SOURCE).toContain('import("sharp")');
	});

	test("caches the dynamic import in a module-level promise", () => {
		// The cached loader keeps a single import across calls (no re-import per encode).
		expect(SOURCE).toContain("sharp_loader");
	});
});