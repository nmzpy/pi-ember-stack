import { beforeEach, describe, expect, test } from "bun:test";
import { CompactRenderer } from "../renderer.ts";
import { getSharedRenderer } from "../shared-renderer.ts";

/** Identity theme so rows assert as plain text (gradient ANSI is stripped). */
const theme = {
	fg: (_token: string, text: string): string => text,
	bold: (text: string): string => text,
} as never;

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function make_context(id: string, state: Record<string, unknown> = {}) {
	return { args: {}, toolCallId: id, invalidate: (): void => {}, state };
}

function row_of(state: Record<string, unknown>): string[] {
	const callText = state.callText as { text?: string } | undefined;
	const text = stripAnsi(callText?.text ?? "");
	return text.length === 0 ? [] : text.split("\n");
}

function render_call(
	r: CompactRenderer,
	id: string,
	name: string,
	args: Record<string, unknown>,
	state: Record<string, unknown>,
): ReturnType<typeof make_context> {
	const ctx = make_context(id, state);
	r.renderCall(name, args, theme, ctx as never);
	return ctx;
}

function render_result(
	r: CompactRenderer,
	name: string,
	args: Record<string, unknown>,
	ctx: ReturnType<typeof make_context>,
): void {
	r.renderResult(
		name,
		args,
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: false } as never,
	);
}

beforeEach(() => {
	getSharedRenderer().resetForSession();
});

describe("Browser compat work group", () => {
	test("browser calls collapse to the newest child row under one Browser header", () => {
		const r = new CompactRenderer();
		const owner_state: Record<string, unknown> = {};
		const owner = render_call(r, "browser-1", "browser_navigate", { url: "http://localhost:3000/" }, owner_state);

		expect(row_of(owner_state)).toEqual(["◇Navigating http://localhost:3000/"]);

		const resize_state: Record<string, unknown> = {};
		const resize = render_call(r, "browser-2", "browser_resize", { width: 1600, height: 900 }, resize_state);
		const shot_state: Record<string, unknown> = {};
		render_call(r, "browser-3", "browser_take_screenshot", {}, shot_state);
		const interact_state: Record<string, unknown> = {};
		render_call(
			r,
			"browser-4",
			"browser_evaluate",
			{ function: "() => document.title" },
			interact_state,
		);

		render_result(r, "browser_navigate", { url: "http://localhost:3000/" }, owner);
		render_result(r, "browser_resize", { width: 1600, height: 900 }, resize);

		const lines = row_of(owner_state);
		// Live header is the compat tool name; the per-tool count summary waits
		// for the boundary that folds the group.
		expect(lines[0]).toBe("◇Browser");
		// All four calls keep their child rows — the cap only absorbs calls
		// past the newest five.
		expect(lines).toContain("  │Navigated http://localhost:3000/");
		expect(lines).toContain("  │Resized 1600x900");
		expect(lines).toContain("  │Screenshot");
		expect(lines).toContain("  │Interacting");
		// Non-owner members never render their own rows.
		expect(row_of(resize_state)).toEqual([]);
		expect(row_of(shot_state)).toEqual([]);
		expect(row_of(interact_state)).toEqual([]);
	});

	test("an outside tool call folds the browser group to its summary", () => {
		const r = new CompactRenderer();
		const browser_state: Record<string, unknown> = {};
		const first = render_call(r, "b1", "browser_navigate", { url: "http://localhost:3000/" }, browser_state);
		render_result(r, "browser_navigate", { url: "http://localhost:3000/" }, first);
		const second = render_call(r, "b2", "browser_navigate", { url: "http://localhost:3000/next" }, browser_state);
		render_result(r, "browser_navigate", { url: "http://localhost:3000/next" }, second);
		const shot = render_call(r, "b3", "browser_take_screenshot", {}, undefined as never);
		render_call(r, "b3", "browser_take_screenshot", {}, browser_state);
		render_result(r, "browser_take_screenshot", {}, shot);
		const interact = render_call(r, "b4", "browser_evaluate", { function: "() => 1" }, browser_state);
		render_result(r, "browser_evaluate", { function: "() => 1" }, interact);
		const resize = render_call(r, "b5", "browser_resize", { width: 1200, height: 800 }, browser_state);
		render_result(r, "browser_resize", { width: 1200, height: 800 }, resize);

		expect(row_of(browser_state)).toContain("◇Browser");

		// A work tool starts its own group and folds the Browser group above it.
		const read_state: Record<string, unknown> = {};
		render_call(r, "w1", "read", { path: "a.ts" }, read_state);

		expect(row_of(browser_state)).toEqual([
			"◇Browser: Navigated 2 times, Took a screenshot, Interacted once, Resized once",
		]);
		// The new work call is a single-member group: it renders as the standalone
		// compact row, not as an `Explored 1 file` aggregate header.
		expect(row_of(read_state)).toEqual(["• Read a.ts"]);
	});

	test("visible assistant text folds the browser group the same way", () => {
		const r = new CompactRenderer();
		const browser_state: Record<string, unknown> = {};
		const first = render_call(r, "t1", "browser_click", { element: "Save" }, browser_state);
		render_result(r, "browser_click", { element: "Save" }, first);
		const second = render_call(r, "t2", "browser_take_screenshot", {}, browser_state);
		render_result(r, "browser_take_screenshot", {}, second);
		const third = render_call(r, "t3", "browser_take_screenshot", {}, browser_state);
		render_result(r, "browser_take_screenshot", {}, third);

		expect(row_of(browser_state)).toContain("◇Browser");

		r.noteVisibleText();
		expect(row_of(browser_state)).toEqual([
			"◇Browser: Took 2 screenshots, Clicked once",
		]);
	});

	test("interleaved work and browser calls keep chronological groups", () => {
		const r = new CompactRenderer();
		const work_state: Record<string, unknown> = {};
		const work = render_call(r, "mix-w1", "read", { path: "a.ts" }, work_state);
		render_result(r, "read", { path: "a.ts" }, work);

		const browser_state: Record<string, unknown> = {};
		render_call(r, "mix-b1", "browser_navigate", { url: "http://localhost:3000/" }, browser_state);

		// The lone completed read collapses to its standalone compact row when the
		// browser call takes over the transcript.
		expect(row_of(work_state)).toEqual(["• Read a.ts"]);

		// A later work call starts a fresh work group below the browser block; the
		// earlier read row never moves.
		const next_work: Record<string, unknown> = {};
		render_call(r, "mix-w2", "grep", { pattern: "x", path: "b.ts" }, next_work);
		expect(row_of(next_work)).toEqual(["• Search x in b.ts"]);
		expect(row_of(work_state)).toEqual(["• Read a.ts"]);
	});
});
