import { describe, expect, mock, test } from "bun:test";
import { CompactRenderer, formatCallBody, strip_bash_command_preview } from "../renderer.ts";

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

	test("edits as a truncated JSON string still yields live +N -N", () => {
		// Regression: GLM / Opus 4.6 stream `edits` as a JSON string
		// token-by-token. The renderer used parseJsonWithRepair, which
		// throws on the unterminated string mid-stream, silently killing
		// the live +N -N path until the tool completed. parseStreamingJson
		// returns a partial array so the row updates in real time.
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("e4b", state) as any;

		// Partial fragment: only oldText has streamed so far (no newText
		// key yet). parseStreamingJson yields [{ oldText: "a" }] (newText
		// missing -> ""), so lineDiffCounts("a", "") = +0 -1. Before the
		// fix this threw inside parseJsonWithRepair and the row had no
		// live stats at all.
		r.renderCall(
			"edit",
			{
				file_path: "foo.ts",
				edits: '[{"oldText":"a',
			},
			theme,
			ctx,
		);
		let row = stripAnsi((state.callText as any).text);
		expect(row).toContain("-1");

		// Completed string: same as the array-form +1 -0.
		r.renderCall(
			"edit",
			{
				file_path: "foo.ts",
				edits: '[{"oldText":"a","newText":"a\\nb"}]',
			},
			theme,
			ctx,
		);
		row = stripAnsi((state.callText as any).text);
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
	test("live +N updates as content streams", () => {
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
		expect(row).not.toContain("-");

		r.renderCall("write", { path: "foo.ts", content: "a\nb\nc" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+3");
		expect(row).not.toContain("-");

		r.renderCall("write", { path: "foo.ts", content: "a\nb\nc\n" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("+3");
		expect(row).not.toContain("-");
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
		expect(row).not.toContain("-");
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

describe("CompactRenderer group child linger", () => {
	test("completed child lingers until the next baby arrives", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const child_state: Record<string, any> = {};
		const owner_ctx = makeContext("g1", owner_state) as any;
		const child_ctx = makeContext("g2", child_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		// Production: appendToGroup invalidates the owner so Pi re-renders the
		// shared group block (header + children) onto the owner's callText.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		// Both complete: latest child still lingers under the Explored header.
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).toContain("Read");
		expect(row).toContain("b.ts");
		expect(row).not.toContain("a.ts");

		// Next baby absorbs the linger; only the new runner shows.
		const baby_state: Record<string, any> = {};
		const baby_ctx = makeContext("g3", baby_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		expect(row).not.toContain("b.ts");
	});

	test("settling clears the lingering child", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const child_state: Record<string, any> = {};
		const owner_ctx = makeContext("s1", owner_state) as any;
		const child_ctx = makeContext("s2", child_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		expect(stripAnsi((owner_state.callText as any).text)).toContain("b.ts");

		r.noteVisibleText();
		// Settle schedules an owner invalidate; re-render the owner to pick up
		// the settled (header-only) format.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).not.toContain("Reading");
		expect(row).not.toContain("b.ts");
	});
});

describe("CompactRenderer thinking collapse", () => {
	test("noteThinking eagerly paints Thinking child without renderCall", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("eager1", owner_state) as any;
		const child_ctx = makeContext("eager2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).not.toContain("Thinking");

		r.noteThinking();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).toContain("Thinking");
		expect(row).not.toContain("Search");
		expect(r.hasGroupThinkingChild()).toBe(true);
	});

	test("noteVisibleText collapses thinking lane to header-only", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("vis1", owner_state) as any;
		const child_ctx = makeContext("vis2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		r.noteThinking();
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Thinking");

		r.noteVisibleText();
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).not.toContain("Thinking");
		expect(row).not.toContain("Searching");
		expect(r.hasGroupThinkingChild()).toBe(false);
	});

	test("different group key freezes prior thinking lane", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("key1", owner_state) as any;
		const edit_state: Record<string, any> = {};
		const edit_ctx = makeContext("key2", edit_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, makeContext("key1b", {}) as any);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...makeContext("key1b", {}), isError: false },
		);

		r.noteThinking();
		r.renderCall("edit", { file_path: "c.ts", oldText: "a", newText: "b" }, theme, edit_ctx);
		r.renderCall("edit", { file_path: "d.ts", oldText: "a", newText: "b" }, theme, edit_ctx);

		const discovery_row = stripAnsi((owner_state.callText as any).text);
		expect(discovery_row).toContain("Explored");
		expect(discovery_row).not.toContain("Thinking");
	});

	test("noteVisibleText settles active group for thinking handoff", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("t1", owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, makeContext("t2", {}) as any);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		expect(r.hasActiveGroups()).toBe(true);

		r.noteVisibleText();
		expect(r.hasActiveGroups()).toBe(false);

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).not.toContain("Reading");
	});

	test("noteThinking soft-settles then same-key call reopens under one header", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("soft1", owner_state) as any;
		const child_ctx = makeContext("soft2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		expect(stripAnsi((owner_state.callText as any).text)).toContain("Search");

		r.noteThinking();
		expect(r.hasActiveGroups()).toBe(true);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).toContain("Thinking");
		expect(row).not.toContain("Search");

		const baby_state: Record<string, any> = {};
		const baby_ctx = makeContext("soft3", baby_state) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		// Same owner header reopened — not a second Explored row.
		expect(row).toContain("Searching");
		expect(row).toContain("c.ts");
		expect(row).toContain("4 matches");
		expect(baby_state.callText).toBeUndefined();
	});

	test("noteVisibleText hard-splits so next same-key call owns a fresh group", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hard1", owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, makeContext("hard2", {}) as any);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...makeContext("hard2", {}), isError: false },
		);

		r.noteVisibleText();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const old_row = stripAnsi((owner_state.callText as any).text);
		expect(old_row).toContain("Explored");
		expect(old_row).not.toContain("Reading");

		const fresh_state: Record<string, any> = {};
		const fresh_ctx = makeContext("hard3", fresh_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		// Fresh group owner — standalone until a second member joins.
		const fresh_row = stripAnsi((fresh_state.callText as any).text);
		expect(fresh_row).toContain("c.ts");
		expect(fresh_row).not.toContain("Explored");
		// Prior header stayed settled header-only (no reopen onto hard1).
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
	});

	test("does not reopen a group above intervening transcript content", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const explore_owner_state: Record<string, any> = {};
		const explore_owner_ctx = makeContext("chrono1", explore_owner_state) as any;
		const explore_child_ctx = makeContext("chrono2", {}) as any;
		const edit_owner_state: Record<string, any> = {};
		const edit_owner_ctx = makeContext("chrono3", edit_owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, explore_owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, explore_child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, explore_owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...explore_owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 74 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...explore_child_ctx, isError: false },
		);
		r.settleAllGroups();

		r.renderCall("edit", { file_path: "c.ts", oldText: "a", newText: "b" }, theme, edit_owner_ctx);
		r.renderCall("edit", { file_path: "d.ts", oldText: "a", newText: "b" }, theme, edit_owner_ctx);
		r.renderResult(
			"edit",
			{ file_path: "c.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_owner_ctx, isError: false },
		);
		r.renderResult(
			"edit",
			{ file_path: "d.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_owner_ctx, isError: false },
		);
		r.settleAllGroups();

		const fresh_state: Record<string, any> = {};
		const fresh_ctx = makeContext("chrono4", fresh_state) as any;
		r.renderCall("grep", { pattern: "y", path: "e.ts" }, theme, fresh_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, explore_owner_ctx);

		const prior_explore = stripAnsi((explore_owner_state.callText as any).text);
		expect(prior_explore).toContain("Explored");
		expect(prior_explore).not.toContain("e.ts");
		expect(prior_explore).not.toContain("Searching");

		const fresh_row = stripAnsi((fresh_state.callText as any).text);
		expect(fresh_row).toContain("e.ts");
		expect(fresh_row).not.toContain("Explored");
	});

	test("edited group collapses pipe child after settle", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("edit-collapse1", owner_state) as any;
		const child_ctx = makeContext("edit-collapse2", {}) as any;

		r.renderCall("edit", { file_path: "runner.ts", oldText: "a", newText: "b" }, theme, owner_ctx);
		r.renderCall("edit", { file_path: "other.ts", oldText: "a", newText: "b" }, theme, child_ctx);
		r.renderCall("edit", { file_path: "runner.ts", oldText: "a", newText: "b" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			{ file_path: "runner.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"edit",
			{ file_path: "other.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("└");
		expect(row).toContain("other.ts");

		r.settleAllGroups();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Edited");
		expect(row).not.toContain("└");
		expect(row).not.toContain("runner.ts");
	});

	test("agent_end lifecycle shows Thinking child then reopens same group", async () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ae1", owner_state) as any;
		const child_ctx = makeContext("ae2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		r.settleAllGroups();
		r.noteThinking();
		await Promise.resolve();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).toContain("Thinking");
		expect(r.hasActiveGroups()).toBe(true);

		const baby_ctx = makeContext("ae3", {}) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("c.ts");
		expect(row).not.toMatch(/Explored[\s\S]*Explored/);
	});

	test("settleAllGroups keeps currentGroup so same-key call reopens", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("end1", owner_state) as any;
		const child_ctx = makeContext("end2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		r.settleAllGroups();
		expect(r.hasActiveGroups()).toBe(false);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("Reading");

		const baby_ctx = makeContext("end3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		expect(row).toContain("Explored");
	});

	test("standalone bash does not keep group active after completion", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("bash1", state) as any;

		r.renderCall("bash", { command: "npx tsc --noEmit" }, theme, ctx);
		expect(r.hasActiveGroups()).toBe(true);

		r.renderResult(
			"bash",
			{ command: "npx tsc --noEmit" },
			{ content: [{ type: "text", text: "" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...ctx, isError: false },
		);
		expect(r.hasActiveGroups()).toBe(false);
	});

	test("in-group keeps linger until real thinking stream", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("post1", owner_state) as any;
		const child_ctx = makeContext("post2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).not.toContain("Thinking");

		r.noteThinking();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Explored");
		expect(row).toContain("Thinking");
		expect(row).not.toContain("Search");
	});
});

describe("CompactRenderer apply_patch failures", () => {
	test("shows per-file error inline with red header bullet", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const patch_input = [
			"*** Begin Patch",
			"*** Update File: gui/utils/config_utils.py",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		const ctx = {
			args: { input: patch_input },
			toolCallId: "patch-1",
			invalidate: mock(() => {}),
			state,
		} as any;

		r.renderCall("apply_patch", { input: patch_input }, theme, ctx);
		r.renderResult(
			"apply_patch",
			{ input: patch_input },
			{
				details: {
					ok: false,
					fileCount: 1,
					results: [
						{
							path: "gui/utils/config_utils.py",
							op: "update",
							status: "error",
							error: "Invalid Context: @@ -33,8 +33,10 @@",
						},
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...ctx, isError: true },
		);

		const row = stripAnsi((state.callText as any).text);
		expect(row).toContain("Patched 1 file");
		expect(row).toContain("gui/utils/config_utils.py");
		expect(row).toContain("Invalid Context: @@ -33,8 +33,10 @@");
		expect(row).toContain("[error:• ]");
		expect(row).not.toContain("0/1 ok");
	});
});

describe("CompactRenderer native render invalidation", () => {
	test("set_compact_call_text marks pendingShrink when line count decreases", async () => {
		const { CompactGroupText, __test_only } = await import("../renderer.ts");
		const target: { pendingShrink?: boolean; lastRenderedLineCount?: number } = {};
		const callText = new CompactGroupText();
		__test_only.set_compact_call_text(target, callText, "line-1\nline-2\nline-3");
		expect(target.pendingShrink).toBeUndefined();
		__test_only.set_compact_call_text(target, callText, "line-1");
		expect(target.pendingShrink).toBe(true);
		expect(target.lastRenderedLineCount).toBe(1);
	});

	test("pendingShrink on group requests a normal native render", async () => {
		const render_calls: number[] = [];
		const gradient = await import("../../pi-ember-ui/gradient.ts");
		mock.module("../../pi-ember-ui/index.ts", () => ({
			requestTuiRender: () => {
				render_calls.push(1);
			},
			subscribeGradientTick: gradient.subscribe_gradient_tick,
			unsubscribeGradientTick: gradient.unsubscribe_gradient_tick,
			MUTED_GROUP_GRADIENT_PRESET: "actionGroup",
		}));
		const { CompactRenderer } = await import("../renderer.ts");
		const r = new CompactRenderer();
		const group = {
			pendingShrink: true,
			records: [{ _completed: true }],
			settled: false,
			renderOwner: { invalidate: () => {} },
		} as any;
		(r as any).scheduleGroupInvalidation(group);
		await new Promise((resolve) => queueMicrotask(resolve));
		expect(render_calls.length).toBe(1);
		mock.restore();
	});
});

describe("resolve_compact_group_type", () => {
	test("routes bash grep into discovery and other bash into bashing", async () => {
		const { resolve_compact_group_type } = await import("../renderer.ts");
		expect(resolve_compact_group_type("bash", { command: "grep -r foo ." })).toBe("discovery");
		expect(resolve_compact_group_type("bash", { command: "npm test" })).toBe("bashing");
		expect(resolve_compact_group_type("read", { path: "a.ts" })).toBe("discovery");
		expect(resolve_compact_group_type("edit", { file_path: "a.ts" })).toBe("editing");
	});
});

describe("compact tool row colors", () => {
	test("completed standalone calls use muted, running streams use text", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("color1", state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, ctx);
		expect((state.callText as any).text).toContain("[text:*Read*]");
		expect((state.callText as any).text).toContain("[text: a.ts]");

		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...ctx, isError: false },
		);
		expect((state.callText as any).text).toContain("[muted:*Read*]");
		expect((state.callText as any).text).toContain("[muted: a.ts]");
	});

	test("completed group child rows use muted labels", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("color2", owner_state) as any;
		const child_ctx = makeContext("color3", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = (owner_state.callText as any).text as string;
		expect(row).toContain("[muted:*Search*]");
		expect(row).toContain("[muted: x]");
	});

	test("bash and edit bullets are muted while running and green when done", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;

		const bash_state: Record<string, any> = {};
		const bash_ctx = makeContext("bash-bullet", bash_state) as any;
		r.renderCall("bash", { command: "npm test" }, theme, bash_ctx);
		expect((bash_state.callText as any).text).toContain("[muted:• ]");
		expect((bash_state.callText as any).text).not.toContain("[success:• ]");
		r.renderResult(
			"bash",
			{ command: "npm test" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...bash_ctx, isError: false },
		);
		r.renderCall("bash", { command: "npm test" }, theme, bash_ctx);
		expect((bash_state.callText as any).text).toContain("[success:• ]");

		const edit_state: Record<string, any> = {};
		const edit_ctx = makeContext("edit-bullet", edit_state) as any;
		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "b" }, theme, edit_ctx);
		expect((edit_state.callText as any).text).toContain("[muted:• ]");
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_ctx, isError: false },
		);
		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "b" }, theme, edit_ctx);
		expect((edit_state.callText as any).text).toContain("[success:• ]");
	});

	test("discovery group bullets stay muted while children show gradient verbs", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("disc-bullet1", owner_state) as any;
		const child_ctx = makeContext("disc-bullet2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const running = (owner_state.callText as any).text as string;
		expect(running).toContain("[muted:• ]");
		expect(running).not.toContain("[dim:• ]");
		expect(running).not.toContain("[success:• ]");
	});

	test("bash and edit group headers use muted then green bullets", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("bash-group1", owner_state) as any;
		const child_ctx = makeContext("bash-group2", {}) as any;

		r.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
		r.renderCall("bash", { command: "npm run lint" }, theme, child_ctx);
		r.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
		expect((owner_state.callText as any).text).toContain("[muted:• ]");

		r.renderResult(
			"bash",
			{ command: "npm test" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"bash",
			{ command: "npm run lint" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
		expect((owner_state.callText as any).text).toContain("[success:• ]");
	});
});

describe("resolve_assistant_group_boundary_event", () => {
	test("ignores text_start and empty text_delta", async () => {
		const { resolve_assistant_group_boundary_event } = await import("../renderer.ts");
		expect(resolve_assistant_group_boundary_event({ type: "text_start" })).toBeNull();
		expect(resolve_assistant_group_boundary_event({ type: "text_delta", delta: "" })).toBeNull();
		expect(resolve_assistant_group_boundary_event({ type: "text_delta", delta: "   " })).toBeNull();
		expect(resolve_assistant_group_boundary_event({ type: "text_delta", delta: "hello" })).toBe(
			"visible_text",
		);
	});

	test("classifies thinking stream events", async () => {
		const { resolve_assistant_group_boundary_event } = await import("../renderer.ts");
		expect(resolve_assistant_group_boundary_event({ type: "thinking_start" })).toBe("thinking");
		expect(resolve_assistant_group_boundary_event({ type: "thinking_delta", delta: "" })).toBe(
			"thinking",
		);
	});
});

describe("strip_bash_command_preview", () => {
	test("drops a redundant leading bash word", () => {
		expect(strip_bash_command_preview("bash t.gate.sh gui/components/ignit")).toBe(
			"t.gate.sh gui/components/ignit",
		);
	});

	test("still strips grouped cd prefixes before bash", () => {
		expect(strip_bash_command_preview("cd src && bash npm test", true)).toBe("npm test");
	});

	test("formatCallBody bash row omits redundant bash prefix", () => {
		const theme = makeTheme() as any;
		const result = formatCallBody("bash", { command: "bash t.gate.sh gui/components/ignit" }, theme);
		expect(result).toContain("Bash");
		expect(result).toContain("$ t.gate.sh gui/components/ignit");
		expect(result).not.toContain("$ bash ");
	});
});
