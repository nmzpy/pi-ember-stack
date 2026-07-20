import { describe, expect, mock, test } from "bun:test";
import { CompactRenderer } from "../renderer.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme() {
	const fg = mock((tag: string, text: string) => `[${tag}:${text}]`);
	return { fg, bold: mock((s: string) => `*${s}*`) };
}

function makeContext(id: string, state: Record<string, any> = {}) {
	return { args: {}, toolCallId: id, invalidate: mock(() => {}), state };
}

describe("CompactRenderer streaming edit stats", () => {
	test("live +N -N updates as oldText/newText grow", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};

		// Token 1: one line added, nothing removed yet
		r.renderCall(
			"edit",
			{ file_path: "foo.ts", oldText: "a", newText: "a\nb" },
			theme,
			makeContext("e1", state) as any,
		);
		let row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+1");
		expect(row).toContain("-0");

		// Token 2: two lines added, one removed
		r.renderCall(
			"edit",
			{ file_path: "foo.ts", oldText: "a\nc", newText: "a\nb\nd" },
			theme,
			makeContext("e1", state) as any,
		);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+2");
		expect(row).toContain("-1");
	});

	test("no stats while args are empty", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall("edit", { file_path: "foo.ts" }, theme, makeContext("e2", state) as any);
		const row = stripAnsi((state.callText as any).text);
		expect(row).not.toContain("+");
		expect(row).not.toContain("-");
	});

	test("edits[] array form is summed", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall(
			"edit",
			{
				file_path: "foo.ts",
				edits: [
					{ oldText: "x", newText: "x\ny" },
					{ oldText: "p\nq", newText: "p" },
				],
			},
			theme,
			makeContext("e3", state) as any,
		);
		const row = stripAnsi((state.callText as any).text);
		// edit 1: +1 -0, edit 2: +0 -1 => +1 -1
		expect(row).toContain("+1");
		expect(row).toContain("-1");
	});

	test("edits as a JSON string is parsed for live +N -N", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall(
			"edit",
			{
				file_path: "foo.ts",
				edits: '[{"oldText":"a","newText":"a\\nb"}]',
			},
			theme,
			makeContext("e4", state) as any,
		);
		const row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+1");
		expect(row).toContain("-0");
	});

	test("empty oldText/newText suppresses +0 -0 placeholder", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall(
			"edit",
			{ file_path: "foo.ts", oldText: "", newText: "" },
			theme,
			makeContext("e5", state) as any,
		);
		const row = stripAnsi((state.callText as any).text);
		expect(row).not.toContain("+0");
		expect(row).not.toContain("-0");
	});

	test("edits[] array grows one edit at a time", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("e6", state) as any;

		r.renderCall(
			"edit",
			{ file_path: "foo.ts", edits: [{ oldText: "a", newText: "a\nb" }] },
			theme,
			ctx,
		);
		let row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+1");
		expect(row).toContain("-0");

		r.renderCall(
			"edit",
			{
				file_path: "foo.ts",
				edits: [
					{ oldText: "a", newText: "a\nb" },
					{ oldText: "x", newText: "y\nz" },
				],
			},
			theme,
			ctx,
		);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+3");
		expect(row).toContain("-1");
	});
});

describe("CompactRenderer streaming write stats", () => {
	test("live +N -0 updates as content streams", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("w1", state) as any;

		r.renderCall("write", { path: "foo.ts", content: "" }, theme, ctx);
		let row = stripAnsi((state.callText as any).text);
		expect(row).not.toContain("+");

		r.renderCall("write", { path: "foo.ts", content: "a" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+1");
		expect(row).toContain("-0");

		r.renderCall("write", { path: "foo.ts", content: "a\nb\nc" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+3");
		expect(row).toContain("-0");

		r.renderCall("write", { path: "foo.ts", content: "a\nb\nc\n" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+3");
		expect(row).toContain("-0");
	});

	test("write final stats are shown after completion", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("w2", state) as any;

		r.renderCall("write", { path: "foo.ts", content: "x\ny" }, theme, ctx);
		// Manually mark the call as completed to exercise the final result path.
		if (state.records && state.records[0]) {
			state.records[0]._completed = true;
			state.records[0].result = {};
		}
		const row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+2");
		expect(row).toContain("-0");
	});

	test("empty content suppresses +0 -0 placeholder for write", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall("write", { path: "foo.ts" }, theme, makeContext("w3", state) as any);
		const row = stripAnsi((state.callText as any).text);
		expect(row).not.toContain("+0");
		expect(row).not.toContain("-0");
	});
});
