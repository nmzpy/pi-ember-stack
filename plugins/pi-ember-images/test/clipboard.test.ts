import { describe, expect, test } from "bun:test";
import { runCaptured } from "../clipboard.ts";

const SOURCE = await Bun.file(new URL("../clipboard.ts", import.meta.url)).text();

describe("native clipboard resolution", () => {
	test("prefers the pi runtime's native clipboard module over subprocess reads", () => {
		// The native module reads images in-process with zero subprocess spawns, so
		// it can never hang or time out. A revert to PowerShell/osascript-only reads
		// reintroduces the historical infinite-stall.
		expect(SOURCE).toContain("clipboard-native.js");
		expect(SOURCE).toContain("resolve_coding_agent_dist_dir");
		expect(SOURCE).toContain("getImageBinary");
	});
	
	test("keeps the async timeout-guarded subprocess fallback", () => {
		expect(SOURCE).toContain("runCaptured");
		expect(SOURCE).toContain("CLIPBOARD_READ_TIMEOUT_MS");
	});
});


describe("runCaptured", () => {
	test("captures stdout and exit status of a fast child", async () => {
		const run = await runCaptured(process.execPath, ["-e", "process.stdout.write('hello')"], 5000);
		expect(run.timedOut).toBe(false);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("hello");
	});

	test("kills a hung child and reports timed-out instead of stalling forever", async () => {
		const t0 = performance.now();
		const run = await runCaptured(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 500);
		const elapsed = performance.now() - t0;
		expect(run.timedOut).toBe(true);
		expect(run.status).toBeNull();
		// The read must resolve promptly after the timeout — never hang.
		expect(elapsed).toBeGreaterThan(450);
		expect(elapsed).toBeLessThan(3000);
	});

	test("reports a nonzero exit status", async () => {
		const run = await runCaptured(process.execPath, ["-e", "process.exit(7)"], 5000);
		expect(run.timedOut).toBe(false);
		expect(run.status).toBe(7);
	});
});