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
	test("beginTurn alone does not reset grouping — thinking-only turns stay grouped", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		r.renderCall("read", { file_path: "foo.ts" }, theme, ctx1 as any);
		r.beginTurn();
		// No visible text in this turn — discovery calls should join the previous group
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "bar.ts" }, theme, ctx2 as any);
		const record = (r as any).calls.get("b");
		expect(record.group).toBeDefined();
		expect(record.group).toBe((r as any).calls.get("a").group);
	});

	test("visible text before discovery calls resets grouping across turns", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		r.renderCall("read", { file_path: "foo.ts" }, theme, ctx1 as any);
		r.beginTurn();
		// Simulate visible text output in the new turn
		r.noteVisibleText();
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "bar.ts" }, theme, ctx2 as any);
		const record = (r as any).calls.get("b");
		expect(record.group).toBeUndefined();
	});

	test("discovery group within a turn persists after an intervening non-discovery tool", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ownerContext = makeContext("a");
		const memberContext = makeContext("b");

		r.renderCall("read", { file_path: "a.ts" }, theme, ownerContext as any);
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...ownerContext, isError: false } as any,
		);

		// Same turn: an edit intervenes, then another discovery call joins the same group
		r.renderCall("edit", { file_path: "x.ts", oldText: "a", newText: "b" }, theme, makeContext("edit") as any);
		r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, memberContext as any);

		const owner = r.renderCall("read", { file_path: "a.ts" }, theme, ownerContext as any) as any;
		expect(owner.text).toContain("Exploring");
		expect(owner.text).toContain("a.ts");
		expect(owner.text).toContain("foo");
		expect(owner.text.match(/•/g)?.length).toBe(1);

		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 1 } },
			{ isPartial: false },
			theme,
			{ ...memberContext, isError: false } as any,
		);
		const settledOwner = r.renderCall("read", { file_path: "a.ts" }, theme, ownerContext as any) as any;
		expect(settledOwner.text).toContain("Explored");
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

	test("grouped Search stays visible without child bullets", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const readContext = makeContext("a");
		const searchContext = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, readContext as any);
		r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, searchContext as any);
		// The owner (A, the first call) renders the full group
		const groupCall = r.renderCall("read", { file_path: "a.ts" }, theme, readContext as any) as any;

		expect(groupCall.text).toContain("Exploring");
		expect(groupCall.text).toContain("Search");
		expect(groupCall.text).toContain("Read");
		expect(groupCall.text.match(/•/g)?.length).toBe(1);
	});

	test("preflight grouping does not hide an already-rendered Search call", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const searchContext = makeContext("a");
		r.renderCall("grep", { pattern: "foo" }, theme, searchContext as any);
		r.registerCall("read", "b", { file_path: "a.ts" });

		const searchRecord = (r as any).calls.get("a");
		expect(searchRecord.group.renderOwner).toBe(searchRecord);
		// Re-render the owner (A) — it renders the group including Search
		const groupCall = r.renderCall(
			"grep",
			{ pattern: "foo" },
			theme,
			searchContext as any,
		) as any;
		expect(groupCall.text).toContain("Search");
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

	test("bash calls with same cd dir group within a turn", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "cd src && ls" }, theme, makeContext("a") as any);
		r.renderCall("bash", { command: "cd src && pwd" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
	});

	test("bash calls with same cd dir do NOT group across turns after visible text", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "cd src && ls" }, theme, makeContext("a") as any);
		r.beginTurn();
		r.noteVisibleText();
		r.renderCall("bash", { command: "cd src && pwd" }, theme, makeContext("b") as any);
		const recB = (r as any).calls.get("b");
		expect(recB.group).toBeUndefined();
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

	test("renderOwner stays on first call", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		r.renderCall("read", { file_path: "b.ts" }, theme, ctx2 as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		// First member A stays the renderOwner; B joining does NOT migrate ownership
		expect(recA.group.renderOwner).toBe(recA);
		expect(recA.group.renderOwner).not.toBe(recB);
	});

	test("non-owner grouped call renders empty; owner renders group", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ctx1 = makeContext("a");
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		r.renderCall("read", { file_path: "b.ts" }, theme, ctx2 as any);
		// Re-rendering the non-owner B returns empty
		const compB2 = r.renderCall("read", { file_path: "b.ts" }, theme, ctx2 as any);
		expect((compB2 as any).text).toBe("");
		// Re-rendering the owner A renders the full group with both children
		const compA2 = r.renderCall("read", { file_path: "a.ts" }, theme, ctx1 as any);
		expect((compA2 as any).text).toContain("Exploring");
		expect((compA2 as any).text).toContain("a.ts");
		expect((compA2 as any).text).toContain("b.ts");
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
		// A is the owner; expanded result for A shows full output
		const comp = r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "contentA_line1\ncontentA_line2" }] },
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a", stateA), isError: false } as any,
		);
		expect((comp as any).text).toContain("contentA_line1");
		expect((comp as any).text).toContain("contentA_line2");
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

	test("group stays 'Exploring' after all discovery calls complete (no non-discovery call yet)", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		const stateB: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b", stateB) as any);
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", stateA), isError: false } as any,
		);
		r.renderResult(
			"grep",
			{ pattern: "foo" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("b", stateB), isError: false } as any,
		);
		// Re-render the owner (A) to see the group label
		const groupCall = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(groupCall.text).toContain("Exploring");
		expect(groupCall.text).not.toContain("Explored");
	});

	test("group flips to 'Explored' after a non-discovery tool call", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		const stateB: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b", stateB) as any);
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", stateA), isError: false } as any,
		);
		r.renderResult(
			"grep",
			{ pattern: "foo" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("b", stateB), isError: false } as any,
		);
		// Non-discovery call sets the group's hasNonDiscovery flag
		r.renderCall("edit", { file_path: "x.ts" }, theme, makeContext("c") as any);
		// Re-render the OWNER (A, the first discovery call) to pick up the new label
		const refreshed = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(refreshed.text).toContain("Explored");
	});

	test("discovery calls within a turn join the same group with first-member owner", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
		// First member (A) remains owner
		expect(recA.group.renderOwner).toBe(recA);
		// Re-rendering the owner shows all children
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(ownerComp.text).toContain("a.ts");
		expect(ownerComp.text).toContain("foo");
	});

	test("discovery calls do NOT join the previous turn's group after visible text", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a") as any);
		r.beginTurn();
		r.noteVisibleText();
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
		const recB = (r as any).calls.get("b");
		// New turn's discovery call starts a fresh group (or is standalone)
		expect(recB.group).toBeUndefined();
	});

	test("thinking-only turn keeps discovery calls grouped with previous turn", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.beginTurn();
		// No noteVisibleText() — thinking-only turn
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recB.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
		// Owner is still the first member from the previous turn
		expect(recA.group.renderOwner).toBe(recA);
	});

	test("group hasNonDiscovery flag is sticky within a turn", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		const stateB: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b", stateB) as any);
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", stateA), isError: false } as any,
		);
		r.renderResult(
			"grep",
			{ pattern: "foo" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...makeContext("b", stateB), isError: false } as any,
		);
		// Non-discovery call sets the sticky flag within the same turn
		r.renderCall("edit", { file_path: "x.ts" }, theme, makeContext("c") as any);
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(ownerComp.text).toContain("Explored");
		expect(ownerComp.text).not.toContain("Exploring");
	});

	test("joining a group invalidates only the owner", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const invalidateA = mock(() => {});
		const invalidateB = mock(() => {});
		const ctxA = { args: {}, toolCallId: "a", invalidate: invalidateA, state: {} };
		const ctxB = { args: {}, toolCallId: "b", invalidate: invalidateB, state: {} };
		r.renderCall("read", { file_path: "a.ts" }, theme, ctxA as any);
		// B joins the group
		r.renderCall("grep", { pattern: "foo" }, theme, ctxB as any);
		// After B joins, re-render A (the owner) to confirm the group is intact
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, ctxA as any) as any;
		expect(ownerComp.text).toContain("a.ts");
		expect(ownerComp.text).toContain("foo");
		expect(invalidateA).toHaveBeenCalledTimes(1);
		expect(invalidateB).not.toHaveBeenCalled();
	});

	test("group survives Pi rebuild (thinking-toggle) with fresh context.state and invalidate", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;

		// --- First render: build a discovery group (read + grep) ---
		const stateA1: Record<string, any> = {};
		const stateB1: Record<string, any> = {};
		const invA1 = mock(() => {});
		const invB1 = mock(() => {});
		const ctxA1 = { args: {}, toolCallId: "a", invalidate: invA1, state: stateA1 };
		const ctxB1 = { args: {}, toolCallId: "b", invalidate: invB1, state: stateB1 };

		r.renderCall("read", { file_path: "a.ts" }, theme, ctxA1 as any);
		r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, ctxB1 as any);
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...ctxA1, isError: false } as any,
		);
		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 1 } },
			{ isPartial: false },
			theme,
			{ ...ctxB1, isError: false } as any,
		);

		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
		expect(recA.group.renderOwner).toBe(recA);

		// --- Simulate Pi rebuild: chatContainer.clear() + rebuildChatFromMessages() ---
		// Pi destroys every ToolExecutionComponent and creates fresh ones with
		// new rendererState = {} and new invalidate callbacks for the SAME ids.
		const stateA2: Record<string, any> = {};
		const stateB2: Record<string, any> = {};
		const invA2 = mock(() => {});
		const invB2 = mock(() => {});
		const ctxA2 = { args: {}, toolCallId: "a", invalidate: invA2, state: stateA2 };
		const ctxB2 = { args: {}, toolCallId: "b", invalidate: invB2, state: stateB2 };

		// Owner re-renders the full group into a fresh Text
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, ctxA2 as any) as any;
		expect(ownerComp.text).toContain("Exploring");
		expect(ownerComp.text).toContain("a.ts");
		expect(ownerComp.text).toContain("foo");
		expect(ownerComp.text.match(/•/g)?.length).toBe(1);

		// Non-owner renders empty (zero vertical space)
		const memberComp = r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, ctxB2 as any) as any;
		expect(memberComp.text).toBe("");

		// The group's shared callText is now the live owner's Text
		expect(recA.group.callText).toBe(ownerComp);

		// Re-deliver results with fresh wrappers (Pi creates new {content,details})
		r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...ctxA2, isError: false } as any,
		);
		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 1 } },
			{ isPartial: false },
			theme,
			{ ...ctxB2, isError: false } as any,
		);

		// The shared callText was updated directly (no owner invalidation)
		expect(ownerComp.text).toContain("a.ts");
		expect(ownerComp.text).toContain("foo");
		// No synchronous invalidate recursion: the new owner invalidate was NOT
		// called by setResult (members write callText directly).
		expect(invA2).not.toHaveBeenCalled();

		// Old destroyed invalidates are disconnected from the pulse set: the
		// record now points at the live invalidate, not the destroyed one.
		expect(recA.invalidate).toBe(invA2);
		expect(recB.invalidate).toBe(invB2);
		expect(recA.invalidate).not.toBe(invA1);
		expect(recB.invalidate).not.toBe(invB1);
	});
});
