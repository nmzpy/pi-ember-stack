import { describe, expect, mock, test } from "bun:test";
import { CompactRenderer, formatCallBody, DISCOVERY_TOOLS } from "../../pi-compact-tools/renderer.ts";

function makeTheme() {
	const fg = mock((tag: string, text: string) => `[${tag}:${text}]`);
	return {
		fg,
		bold: mock((s: string) => `*${s}*`),
	};
}

function makeContext(id: string, state: Record<string, any> = {}) {
	return {
		args: {},
		toolCallId: id,
		invalidate: mock(() => {}),
		state,
	};
}

describe("CompactRenderer", () => {
	test("beginTurn does not reset grouping for same-key calls", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		r.renderCall("read", { file_path: "foo.ts" }, theme, ctx1 as any);
		r.beginTurn();
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "bar.ts" }, theme, ctx2 as any);
		// Same group key (__discovery__) should still group across turns
		const record = (r as any).calls.get("b");
		expect(record.group).toBeDefined();
	});

	test("consecutive discovery tools group together", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		r.renderCall("grep", { pattern: "foo" }, theme, ctx2 as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
		expect(recA.group.records.length).toBe(2);
	});

	test("non-discovery tools do not group", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "ls" }, theme, makeContext("a") as any);
		r.renderCall("edit", { file_path: "x.ts" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeUndefined();
		expect(recB.group).toBeUndefined();
	});

	test("renderResult returns empty for bash on success", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "echo hi" }, theme, makeContext("a") as any);
		const comp = r.renderResult(
			"bash",
			{ command: "echo hi" },
			{ content: [{ type: "text", text: "hi" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a"), isError: false } as any,
		);
		// Compact: the result component itself is empty, but the call row is updated.
		expect((comp as any).text).toBe("");
	});

	test("bash success renders last output line on the call row", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("bash", { command: "echo hi" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"bash",
			{ command: "echo hi" },
			{ content: [{ type: "text", text: "first\nsecond\nOK" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("Run");
		expect((call as any).text).toContain("OK");
		expect((call as any).text).not.toContain("first");
		expect((call as any).text).not.toContain("second");
	});

	test("bash output skips trailing blank lines", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("bash", { command: "echo hi" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"bash",
			{ command: "echo hi" },
			{ content: [{ type: "text", text: "OK\n\n\n" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("OK");
		expect((call as any).text).not.toContain("\n\n");
	});

	test("bash empty output does not add a result line", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("bash", { command: ":" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"bash",
			{ command: ":" },
			{ content: [{ type: "text", text: "" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("Run");
		expect((call as any).text).not.toContain("  ");
	});

	test("bash partial result does not render output yet", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("bash", { command: "sleep 1" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"bash",
			{ command: "sleep 1" },
			{ content: [{ type: "text", text: "intermediate" }] },
			{ isPartial: true },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("Run");
		expect((call as any).text).not.toContain("intermediate");
	});

	test("renderResult shows error text on failure", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "bad.ts" }, theme, makeContext("a") as any);
		const comp = r.renderResult(
			"read",
			{ file_path: "bad.ts" },
			{ content: [{ type: "text", text: "Error: not found" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a"), isError: true } as any,
		);
		expect((comp as any).text).toContain("Error: not found");
	});

	test("read never dumps file content on success", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "big.ts" }, theme, makeContext("a") as any);
		const fileContent = "line1\nline2\nline3\n".repeat(100);
		const comp = r.renderResult(
			"read",
			{ file_path: "big.ts" },
			{ content: [{ type: "text", text: fileContent }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a"), isError: false } as any,
		);
		// Result must be empty — the call row shows the compact summary.
		expect((comp as any).text).toBe("");
		expect((comp as any).text).not.toContain("line1");
	});

	test("bash calls with same cd dir group across turns", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "cd src && ls" }, theme, makeContext("a") as any);
		r.beginTurn();
		r.renderCall("bash", { command: "cd src && pwd" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
	});

	test("DISCOVERY_TOOLS includes grep and find", () => {
		expect(DISCOVERY_TOOLS.has("grep")).toBe(true);
		expect(DISCOVERY_TOOLS.has("find")).toBe(true);
		expect(DISCOVERY_TOOLS.has("read")).toBe(true);
		expect(DISCOVERY_TOOLS.has("ls")).toBe(true);
	});

	test("formatCallBody handles grep", () => {
		const theme = makeTheme() as any;
		const result = formatCallBody("grep", { pattern: "MyClass", path: "src/" }, theme);
		expect(result).toContain("Search");
		expect(result).toContain("MyClass");
		expect(result).toContain("src/");
	});

	test("formatCallBody handles find", () => {
		const theme = makeTheme() as any;
		const result = formatCallBody("find", { pattern: "main", path: "." }, theme);
		expect(result).toContain("Find");
		expect(result).toContain("main");
	});

	test("renderOwner moves group to latest call", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		r.renderCall("read", { file_path: "b.ts" }, theme, ctx2 as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		// After B joins, B should be the renderOwner
		expect(recA.group.renderOwner).toBe(recB);
		expect(recA.group.renderOwner).not.toBe(recA);
	});

	test("non-owner grouped call renders empty", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		r.renderCall("read", { file_path: "b.ts" }, theme, ctx2 as any);
		// After B joins and becomes owner, re-rendering A should return empty
		const compA2 = r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		expect((compA2 as any).text).toBe("");
	});

	test("expanded bash shows full output", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall("bash", { command: "echo hi" }, theme, makeContext("a", state) as any);
		const comp = r.renderResult(
			"bash",
			{ command: "echo hi" },
			{ content: [{ type: "text", text: "line1\nline2\nline3" }] },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((comp as any).text).toContain("line1");
		expect((comp as any).text).toContain("line2");
		expect((comp as any).text).toContain("line3");
	});

	test("collapsed bash shows only last line", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("bash", { command: "echo hi" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"bash",
			{ command: "echo hi" },
			{ content: [{ type: "text", text: "line1\nline2\nline3" }] },
			{ isPartial: false, expanded: false },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("line3");
		expect((call as any).text).not.toContain("line1");
		expect((call as any).text).not.toContain("line2");
	});

	test("expanded read shows full file content", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "big.ts" }, theme, makeContext("a") as any);
		const fileContent = "line1\nline2\nline3\nline4\nline5";
		const comp = r.renderResult(
			"read",
			{ file_path: "big.ts" },
			{ content: [{ type: "text", text: fileContent }] },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a"), isError: false } as any,
		);
		expect((comp as any).text).toContain("line1");
		expect((comp as any).text).toContain("line2");
		expect((comp as any).text).toContain("line5");
	});

	test("collapsed read hides file content", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "big.ts" }, theme, makeContext("a") as any);
		const fileContent = "line1\nline2\nline3\nline4\nline5";
		const comp = r.renderResult(
			"read",
			{ file_path: "big.ts" },
			{ content: [{ type: "text", text: fileContent }] },
			{ isPartial: false, expanded: false },
			theme,
			{ ...makeContext("a"), isError: false } as any,
		);
		expect((comp as any).text).toBe("");
	});

	test("expanded grep shows all match lines", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("a", state) as any);
		const comp = r.renderResult(
			"grep",
			{ pattern: "foo" },
			{ content: [{ type: "text", text: "a.ts:1:foo\nb.ts:2:foo\nc.ts:3:foo" }], details: { totalMatched: 3 } },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((comp as any).text).toContain("a.ts:1:foo");
		expect((comp as any).text).toContain("b.ts:2:foo");
		expect((comp as any).text).toContain("c.ts:3:foo");
	});

	test("expanded grouped call shows full output for owner", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		const stateB: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.renderCall("read", { file_path: "b.ts" }, theme, makeContext("b", stateB) as any);
		const comp = r.renderResult(
			"read",
			{ file_path: "b.ts" },
			{ content: [{ type: "text", text: "contentB_line1\ncontentB_line2" }] },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("b", stateB), isError: false } as any,
		);
		expect((comp as any).text).toContain("contentB_line1");
		expect((comp as any).text).toContain("contentB_line2");
	});

	test("expanded partial result does not show output", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		r.renderCall("bash", { command: "sleep 1" }, theme, makeContext("a", state) as any);
		const comp = r.renderResult(
			"bash",
			{ command: "sleep 1" },
			{ content: [{ type: "text", text: "intermediate" }] },
			{ isPartial: true, expanded: true },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((comp as any).text).toBe("");
	});

	test("expanded error still shows error text", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "bad.ts" }, theme, makeContext("a") as any);
		const comp = r.renderResult(
			"read",
			{ file_path: "bad.ts" },
			{ content: [{ type: "text", text: "Error: not found" }] },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a"), isError: true } as any,
		);
		expect((comp as any).text).toContain("Error: not found");
	});
});
