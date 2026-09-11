import { describe, expect, test } from "bun:test";
import {
	burst_paths,
	burst_timeout_ms,
	DEFAULT_FRAMES,
	DEFAULT_INTERVAL_MS,
	DEFAULT_SHEET_WIDTH,
	MAX_FRAMES,
	MAX_INTERVAL_MS,
	MIN_INTERVAL_MS,
	plan_burst,
	sheet_grid,
	sheet_layout,
} from "../sequence.ts";

/**
 * The screenshot timer's arithmetic. The cadence, the tiling, and the parent's
 * deadline are what the model asked for by name (interval in ms, N frames), so
 * they are pinned here instead of being judged from a produced sheet.
 */

describe("burst plan", () => {
	test("defaults are a short, readable burst", () => {
		const plan = plan_burst({});
		expect(plan.frames).toBe(DEFAULT_FRAMES);
		expect(plan.intervalMs).toBe(DEFAULT_INTERVAL_MS);
		expect(plan.delayMs).toBe(0);
	});

	test("a requested cadence and frame count are kept as asked", () => {
		expect(plan_burst({ frames: 12, intervalMs: 100, delayMs: 500 })).toEqual({
			frames: 12,
			intervalMs: 100,
			delayMs: 500,
		});
	});

	test("stays inside the bounds the schema and the parser advertise", () => {
		// Defensive floor only: the tool schema and argv parser reject these.
		expect(plan_burst({ frames: MAX_FRAMES + 50 }).frames).toBe(MAX_FRAMES);
		expect(plan_burst({ frames: 0 }).frames).toBe(1);
		expect(plan_burst({ intervalMs: MIN_INTERVAL_MS - 40 }).intervalMs).toBe(MIN_INTERVAL_MS);
		expect(plan_burst({ intervalMs: MAX_INTERVAL_MS + 1 }).intervalMs).toBe(MAX_INTERVAL_MS);
		expect(plan_burst({ delayMs: -5 }).delayMs).toBe(0);
	});

	test("non-numeric input falls back instead of producing NaN frames", () => {
		const plan = plan_burst({ frames: Number.NaN, intervalMs: Number.POSITIVE_INFINITY });
		expect(plan.frames).toBe(DEFAULT_FRAMES);
		expect(Number.isFinite(plan.intervalMs)).toBe(true);
	});
});

describe("sheet grid", () => {
	test("is known before any frame exists, so frames can be captured at tile size", () => {
		expect(sheet_grid(4, 1600)).toEqual({ cols: 2, rows: 2, cellWidth: 800 });
		expect(sheet_grid(6, 1200)).toEqual({ cols: 3, rows: 2, cellWidth: 400 });
	});

	test("agrees with the finished layout it is derived from", () => {
		const grid = sheet_grid(5, 1000);
		const layout = sheet_layout(5, 1000, 2000, 1000);
		expect(grid.cols).toBe(layout.cols);
		expect(grid.rows).toBe(layout.rows);
		expect(grid.cellWidth).toBe(layout.cellWidth);
	});
});

describe("contact sheet layout", () => {
	test("a square-ish grid in reading order", () => {
		const two = sheet_layout(2, 1600, 1900, 1800);
		expect([two.cols, two.rows]).toEqual([2, 1]);
		const six = sheet_layout(6, 1600, 1900, 1800);
		expect([six.cols, six.rows]).toEqual([3, 2]);
		const nine = sheet_layout(9, 1600, 1900, 1800);
		expect([nine.cols, nine.rows]).toEqual([3, 3]);
	});

	test("cells follow the window's aspect, never stretched", () => {
		const layout = sheet_layout(4, 1600, 2000, 1000);
		expect(layout.cellWidth).toBe(800);
		expect(layout.cellHeight).toBe(400); // half of 800, the window's own ratio
		expect(layout.width).toBe(1600);
		expect(layout.height).toBe(800);
	});

	test("the sheet honours the width cap it was given", () => {
		const layout = sheet_layout(6, 1200, 1000, 500);
		expect(layout.width).toBeLessThanOrEqual(1200);
		expect(layout.cellWidth).toBe(400);
	});

	test("a fallback aspect is used before any frame is measured", () => {
		const layout = sheet_layout(4, DEFAULT_SHEET_WIDTH, 0, 0);
		expect(layout.cellWidth).toBe(800);
		expect(layout.cellHeight).toBe(450); // 16:9
	});
});

describe("burst file names", () => {
	test("frames are numbered beside the sheet", () => {
		const paths = burst_paths("/tmp/run-sheet.webp", 3, "webp");
		expect(paths.sheet).toBe("/tmp/run-sheet.webp");
		expect(paths.frames).toEqual([
			"/tmp/run-sheet-f1.webp",
			"/tmp/run-sheet-f2.webp",
			"/tmp/run-sheet-f3.webp",
		]);
	});

	test("a sheet path keeps its own extension while the frames use the format", () => {
		const paths = burst_paths("C:/tmp/shot.png", 2, "jpeg");
		expect(paths.sheet).toBe("C:/tmp/shot.png");
		expect(paths.frames).toEqual(["C:/tmp/shot-f1.jpg", "C:/tmp/shot-f2.jpg"]);
	});

	test("a path without an extension is not mangled", () => {
		const paths = burst_paths("/tmp/burst", 2, "png");
		expect(paths.sheet).toBe("/tmp/burst");
		expect(paths.frames).toEqual(["/tmp/burst-f1.png", "/tmp/burst-f2.png"]);
	});
});

describe("parent deadline", () => {
	test("covers the delay, the cadence and a capture budget per frame", () => {
		const plan = plan_burst({ frames: 4, intervalMs: 250, delayMs: 0 });
		// 4 * (250 + 1500) + 5000 = 12000, under the 20s floor for a fast burst.
		expect(burst_timeout_ms(plan)).toBe(20_000);
	});

	test("grows with a long burst instead of killing it early", () => {
		const plan = plan_burst({ frames: 24, intervalMs: 10_000, delayMs: 60_000 });
		// The ceiling bounds a runaway request, not the burst itself.
		expect(burst_timeout_ms(plan)).toBe(240_000);
	});

	test("always leaves room for the frames that were actually asked for", () => {
		const plan = plan_burst({ frames: 8, intervalMs: 2000, delayMs: 1000 });
		expect(burst_timeout_ms(plan)).toBeGreaterThan(1000 + 8 * 2000);
	});
});
