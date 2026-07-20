import { describe, expect, mock, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	CompactRenderer,
	DISCOVERY_TOOLS,
	formatCallBody,
	PULSE_INTERVAL_MS,
} from "../../pi-compact-tools/renderer.ts";
import {
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
} from "../../pi-ember-ui/mode-colors.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
	test("hidden thinking carries grouping across turns", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "foo.ts" }, theme, makeContext("a") as any);
		r.endTurn(true);
		r.beginTurn();
		r.renderCall("read", { file_path: "bar.ts" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recB.group).toBe(recA.group);
		expect(recB.group).toBeDefined();
	});

	test("visible text before discovery calls resets grouping across turns", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		r.renderCall("read", { file_path: "foo.ts" }, theme, makeContext("a", stateA) as any);
		r.endTurn(true);
		r.beginTurn();
		// Simulate visible text output in the new turn
		r.noteVisibleText();
		const ctx2 = makeContext("b");
		r.renderCall("read", { file_path: "bar.ts" }, theme, ctx2 as any);
		const record = (r as any).calls.get("b");
		expect(record.group).toBeUndefined();
		// The previous group is now settled and past-tense.
		const ownerComp = r.renderCall("read", { file_path: "foo.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(stripAnsi(ownerComp.text)).toContain("Read");
	});

	test("visible thinking blocks settle the group when shown", () => {
		const prev_hidden = isThinkingBlocksHidden();
		try {
			const r = new CompactRenderer();
			const theme = makeTheme() as any;
			const stateA: Record<string, any> = {};
			const stateB: Record<string, any> = {};
			const ctxA = makeContext("a", stateA);
			const ctxB = makeContext("b", stateB);
			r.renderCall("read", { file_path: "foo.ts" }, theme, ctxA as any);
			r.renderCall("grep", { pattern: "foo" }, theme, ctxB as any);
			r.renderResult(
				"read",
				{ file_path: "foo.ts" },
				{ content: [{ type: "text", text: "ok" }] },
				{ isPartial: false },
				theme,
				{ ...ctxA, isError: false } as any,
			);
			r.renderResult(
				"grep",
				{ pattern: "foo" },
				{ content: [{ type: "text", text: "ok" }] },
				{ isPartial: false },
				theme,
				{ ...ctxB, isError: false } as any,
			);
			// Simulate thinking blocks visible.
			setThinkingBlocksHidden(false);
			r.endTurn(false);
			r.beginTurn();
			// A visible thinking block in the new turn acts as a transcript boundary.
			r.noteVisibleText();
			r.renderCall("read", { file_path: "bar.ts" }, theme, makeContext("c") as any);
			const record = (r as any).calls.get("c");
			expect(record.group).toBeUndefined();
			// The previous group is now settled and past-tense.
			const ownerComp = r.renderCall(
				"read",
				{ file_path: "foo.ts" },
				theme,
				makeContext("a", stateA) as any,
			) as any;
			expect(stripAnsi(ownerComp.text)).toContain("Explored 2 files");
		} finally {
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hidden thinking blocks do not settle the group", () => {
		const prev_hidden = isThinkingBlocksHidden();
		try {
			const r = new CompactRenderer();
			const theme = makeTheme() as any;
			r.renderCall("read", { file_path: "foo.ts" }, theme, makeContext("a") as any);
			// Thinking blocks hidden: no visible transcript boundary.
			setThinkingBlocksHidden(true);
			r.endTurn(true);
			r.beginTurn();
			r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
			const recA = (r as any).calls.get("a");
			const recB = (r as any).calls.get("b");
			expect(recB.group).toBe(recA.group);
			expect(recB.group).toBeDefined();
		} finally {
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("a user message prevents hidden-thinking carry-over", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("read", { file_path: "foo.ts" }, theme, makeContext("a") as any);
		r.endTurn(true);
		r.beginTurn();
		r.noteUserMessage();
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
		expect((r as any).calls.get("b").group).toBeUndefined();
	});

	test("a different group settles discovery before starting Editing", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const ownerContext = makeContext("a");
		const memberContext = makeContext("b");
		const stateA: Record<string, any> = {};

		r.renderCall("read", { file_path: "a.ts" }, theme, { ...ownerContext, state: stateA } as any);
			r.renderResult(
			"read",
			{ file_path: "a.ts" },
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{ ...ownerContext, state: stateA, isError: false } as any,
		);

		// Same turn: an edit settles discovery, so the later search starts fresh.
		r.renderCall("edit", { file_path: "x.ts", oldText: "a", newText: "b" }, theme, makeContext("edit") as any);
		r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, memberContext as any);

		const owner = r.renderCall("read", { file_path: "a.ts" }, theme, { ...ownerContext, state: stateA } as any) as any;
		expect(stripAnsi(owner.text)).not.toContain("foo");
		expect((r as any).calls.get("b").group).toBeUndefined();

		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 1 } },
			{ isPartial: false },
			theme,
			{ ...memberContext, isError: false } as any,
		);
		// The new standalone search does not reopen the settled discovery group.
		const unsettledOwner = r.renderCall("read", { file_path: "a.ts" }, theme, { ...ownerContext, state: stateA } as any) as any;
		expect(stripAnsi(unsettledOwner.text)).toContain("Read");
		// The discovery group is already settled and should not be reopened by a
		// later discovery call in a new turn.
		r.endTurn(true);
		r.beginTurn();
		r.renderCall("read", { file_path: "z.ts" }, theme, makeContext("z") as any);
		const settledOwner = r.renderCall("read", { file_path: "a.ts" }, theme, { ...ownerContext, state: stateA } as any) as any;
		expect(stripAnsi(settledOwner.text)).toContain("Read");
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

		expect(stripAnsi(groupCall.text)).toContain("Exploring");
		expect(groupCall.text).toContain("Search");
		expect(groupCall.text).toContain("Read");
		expect(groupCall.text).toContain("│");
		expect(groupCall.text).toContain("└");
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

	test("Editing and Bashing start separate groups", () => {
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
		expect((call as any).text).toContain("Bash");
		expect((call as any).text).toContain("OK");
		expect((call as any).text).not.toContain("first");
		expect((call as any).text).not.toContain("second");
	});

	test("refreshThemeColors repaints grep match counts as muted, not accent", () => {
		const r = new CompactRenderer();
		const theme_a = makeTheme() as any;
		const theme_b = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("a", state);
		r.renderCall("grep", { pattern: "foo", path: "src/" }, theme_a, ctx as any);
		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 2 } },
			{ isPartial: false },
			theme_a,
			{ ...ctx, isError: false } as any,
		);
		const callText = state.callText as { text: string; setText: (text: string) => void };
		expect(callText.text).toContain("[muted:2 matches]");
		r.refreshThemeColors(theme_b);
		expect(theme_b.fg).toHaveBeenCalledWith("muted", "2 matches");
		expect(callText.text).toContain("[muted:2 matches]");
	});

	test("grep match count uses muted foreground, not accent or success", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const call = r.renderCall("grep", { pattern: "foo", path: "src/" }, theme, makeContext("a", state) as any);
		r.renderResult(
			"grep",
			{ pattern: "foo", path: "src/" },
			{ content: [{ type: "text", text: "match" }], details: { totalMatched: 3 } },
			{ isPartial: false },
			theme,
			{ ...makeContext("a", state), isError: false } as any,
		);
		expect((call as any).text).toContain("[muted:3 matches]");
		expect((call as any).text).not.toContain("[success:3 matches]");
		expect((call as any).text).not.toContain("[toolMatchCount:3 matches]");
		expect((call as any).text).not.toContain("[accent:3 matches]");
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
		expect((call as any).text).toContain("Bash");
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
		expect((call as any).text).toContain("Bash");
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

	test("bash errors stay on one compact truncated row even when expanded", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const args = { command: "./t.gate.sh" };
		const call = r.renderCall("bash", args, theme, makeContext("a") as any) as any;
		const comp = r.renderResult(
			"bash",
			args,
			{
				content: [{ type: "text", text: `Error: ${"x".repeat(200)}\nline two\nline three` }],
			},
			{ isPartial: false, expanded: true },
			theme,
			{ ...makeContext("a"), isError: true } as any,
		) as any;
		expect(call.text).not.toContain("\n");
		const lines = comp.render(40);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).not.toContain("line two");
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

	test("non-grep bash calls group regardless of cd directory", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		r.renderCall("bash", { command: "cd src && ls" }, theme, makeContext("a") as any);
		r.renderCall("bash", { command: "cd src && pwd" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recA.group).toBeDefined();
		expect(recB.group).toBe(recA.group);
	});

	test("Editing children omit the tool name, show diff stats, and count distinct paths", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		const stateB: Record<string, any> = {};
		const args = { file_path: "src/long-file.ts" };
		r.renderCall("edit", args, theme, makeContext("a", stateA) as any);
		r.renderCall("edit", args, theme, makeContext("b", stateB) as any);
		const owner = r.renderCall("edit", args, theme, makeContext("a", stateA) as any) as any;
		expect(stripAnsi(owner.text)).toContain("Editing");
		expect(owner.text).toContain("src/long-file.ts");
		expect(owner.text).not.toContain("[dim:Edit]");

		const result = { content: [{ type: "text", text: "ok" }], details: { diff: "+new\n-old" } };
		r.renderResult("edit", args, result, { isPartial: false }, theme, {
			...makeContext("a", stateA),
			isError: false,
		} as any);
		r.renderResult("edit", args, result, { isPartial: false }, theme, {
			...makeContext("b", stateB),
			isError: false,
		} as any);
		r.endTurn(true);

		// Settle by simulating visible text output; the group is now complete and past-tense.
		r.noteVisibleText();
		const settled = r.renderCall("edit", args, theme, makeContext("a", stateA) as any) as any;
		expect(stripAnsi(settled.text)).toContain("Edited 1 file");
		expect(settled.text).toContain("[success:+1]");
		expect(settled.text).toContain("[error:-1]");
	});

	test("Explored summaries count distinct target paths", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const args = { file_path: "src/shared.ts" };
		const ctxA = makeContext("a");
		const ctxB = makeContext("b");
		r.renderCall("read", args, theme, ctxA as any);
		r.renderCall("read", args, theme, ctxB as any);
		for (const [id, context] of [["a", ctxA], ["b", ctxB]] as const) {
			r.renderResult("read", args, { content: [{ type: "text", text: "ok" }] }, { isPartial: false }, theme, {
				...context,
				toolCallId: id,
				isError: false,
			} as any);
		}
		// Settle by emitting visible text; the group is now complete and past-tense.
		r.noteVisibleText();
		const owner = r.renderCall("read", args, theme, ctxA as any) as any;
		expect(stripAnsi(owner.text)).toContain("Explored 1 file");
	});

	test("Writing and Bashing use their own group labels and summaries", () => {
		const theme = makeTheme() as any;
		const writing = new CompactRenderer();
		const writeA = makeContext("write-a");
		const writeB = makeContext("write-b");
		writing.renderCall("write", { file_path: "a.ts" }, theme, writeA as any);
		writing.renderCall("write", { file_path: "b.ts" }, theme, writeB as any);
		const writingOwner = writing.renderCall("write", { file_path: "a.ts" }, theme, writeA as any) as any;
		expect(stripAnsi(writingOwner.text)).toContain("Writing");
		expect(stripAnsi(writingOwner.text)).not.toContain("└ Write a.ts");
		for (const [id, args] of [["write-a", { file_path: "a.ts" }], ["write-b", { file_path: "b.ts" }]] as const) {
			writing.renderResult("write", args, { content: [{ type: "text", text: "ok" }] }, { isPartial: false }, theme, {
				...makeContext(id),
				isError: false,
			} as any);
		}
		// Settle by emitting visible text; the writing group is now complete and past-tense.
		writing.noteVisibleText();
		expect(stripAnsi((writing.renderCall("write", { file_path: "a.ts" }, theme, writeA as any) as any).text)).toContain("Written 2 files");

		const bashing = new CompactRenderer();
		const bashA = makeContext("bash-a");
		const bashB = makeContext("bash-b");
		bashing.renderCall("bash", { command: "echo first" }, theme, bashA as any);
		bashing.renderCall("bash", { command: "echo second" }, theme, bashB as any);
		const bashingOwner = bashing.renderCall("bash", { command: "echo first" }, theme, bashA as any) as any;
		expect(stripAnsi(bashingOwner.text)).toContain("Bashing");
		expect(bashingOwner.text).toContain("$ echo first");
		expect(bashingOwner.text).not.toContain("[dim:Bash]");
		for (const [id, args] of [["bash-a", { command: "echo first" }], ["bash-b", { command: "echo second" }]] as const) {
			bashing.renderResult("bash", args, { content: [{ type: "text", text: "ok" }] }, { isPartial: false }, theme, {
				...makeContext(id),
				isError: false,
			} as any);
		}
		// Settle by emitting visible text; the bashing group is now complete and past-tense.
		bashing.noteVisibleText();
		expect(stripAnsi((bashing.renderCall("bash", { command: "echo first" }, theme, bashA as any) as any).text)).toContain("Ran 2 commands");
	});

	test("grouped rows include read ranges and truncate to the TUI width", () => {
		const r = new CompactRenderer();
		const theme = { fg: (_tag: string, text: string) => text, bold: (text: string) => text } as any;
		const first = { file_path: "src/a-very-long-path-that-cannot-fit-on-one-row.ts", offset: 10, limit: 25 };
		const second = { file_path: "src/another-very-long-path-that-cannot-fit-on-one-row.ts", offset: 50, limit: 1 };
		const ctxA = makeContext("a");
		r.renderCall("read", first, theme, ctxA as any);
		r.renderCall("read", second, theme, makeContext("b") as any);
		const group = r.renderCall("read", first, theme, ctxA as any) as any;
		expect(group.text).toContain("offset 10, 25 lines");
		expect(group.text).toContain("offset 50, 1 line");
		const lines = group.render(28);
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
		expect(stripAnsi(lines[1])).toEndWith("...");
		expect(stripAnsi(lines[2])).toEndWith("...");
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
		expect(stripAnsi((compA2 as any).text)).toContain("Exploring");
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

	test("group flips to 'Explored' when settled", () => {
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
		r.settleAllGroups();
		const settledCall = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(stripAnsi(settledCall.text)).toContain("Explored 2 files");
		expect(stripAnsi(settledCall.text)).not.toContain("Exploring");
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
		// Non-discovery call settles the discovery group and starts a new group.
		r.renderCall("edit", { file_path: "x.ts" }, theme, makeContext("c") as any);
		// Re-render the OWNER (A, the first discovery call) to pick up the new label
		const refreshed = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(refreshed.text).toContain("Explored");
		expect(refreshed.text).not.toContain("Exploring");
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

	test("thinking-only turn carries the discovery group across turns", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const stateA: Record<string, any> = {};
		r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
		r.endTurn(true);
		r.beginTurn();
		r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b") as any);
		const recA = (r as any).calls.get("a");
		const recB = (r as any).calls.get("b");
		expect(recB.group).toBe(recA.group);
		expect(recB.group).toBeDefined();
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
		// Non-discovery call settles the discovery group and starts a new group.
		r.renderCall("edit", { file_path: "x.ts" }, theme, makeContext("c") as any);
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any) as any;
		expect(ownerComp.text).toContain("Explored");
		expect(ownerComp.text).not.toContain("Exploring");
	});

	test("joining a group invalidates only the owner after the render stack", async () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const invalidateA = mock(() => {});
		const invalidateB = mock(() => {});
		const ctxA = { args: {}, toolCallId: "a", invalidate: invalidateA, state: {} };
		const ctxB = { args: {}, toolCallId: "b", invalidate: invalidateB, state: {} };
		r.renderCall("read", { file_path: "a.ts" }, theme, ctxA as any);
		// B joins the group
		r.renderCall("grep", { pattern: "foo" }, theme, ctxB as any);
		expect(invalidateA).not.toHaveBeenCalled();
		await Promise.resolve();
		// After B joins, re-render A (the owner) to confirm the group is intact
		const ownerComp = r.renderCall("read", { file_path: "a.ts" }, theme, ctxA as any) as any;
		expect(ownerComp.text).toContain("a.ts");
		expect(ownerComp.text).toContain("foo");
		expect(invalidateA).toHaveBeenCalledTimes(1);
		expect(invalidateB).not.toHaveBeenCalled();
	});

	test("native tool rows do not keep a pulse timer", async () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const firstInvalidate = mock(() => {});
		const replacementInvalidate = mock(() => {});
		const args = { file_path: "a.ts" };

		r.renderCall("read", args, theme, {
			args,
			toolCallId: "a",
			invalidate: firstInvalidate,
			state: {},
		} as any);

		// This is the compact plugin's tool_call hook, which has no component
		// invalidator because Pi has not exposed one at that lifecycle point.
		r.registerCall("read", "a", args);

		r.renderResult(
			"read",
			args,
			{ content: [{ type: "text", text: "ok" }] },
			{ isPartial: false },
			theme,
			{
				args,
				toolCallId: "a",
				invalidate: replacementInvalidate,
				state: {},
				isError: false,
			} as any,
		);

		await new Promise((resolve) => setTimeout(resolve, PULSE_INTERVAL_MS + 50));
		expect(firstInvalidate).not.toHaveBeenCalled();
		expect(replacementInvalidate).not.toHaveBeenCalled();
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

		// Settle the group by emitting visible text before rebuild.
		r.noteVisibleText();

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
		expect(stripAnsi(ownerComp.text)).toContain("Explored");
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

	test("settled group collapses to header-only when thinking blocks are hidden", () => {
		const prev_hidden = isThinkingBlocksHidden();
		try {
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
			r.settleAllGroups();

			// Verbose (thinking visible): children render.
			setThinkingBlocksHidden(false);
			const verboseOwner = r.renderCall(
				"read",
				{ file_path: "a.ts" },
				theme,
				makeContext("a", stateA) as any,
			) as any;
			expect(stripAnsi(verboseOwner.text)).toContain("Explored 2 files");
			expect(stripAnsi(verboseOwner.text)).toContain("a.ts");
			expect(stripAnsi(verboseOwner.text)).toContain("foo");

			// Compact (thinking hidden): settled group collapses to header-only.
			setThinkingBlocksHidden(true);
			const collapsedOwner = r.renderCall(
				"read",
				{ file_path: "a.ts" },
				theme,
				makeContext("a", stateA) as any,
			) as any;
			expect(stripAnsi(collapsedOwner.text)).toContain("Explored 2 files");
			expect(stripAnsi(collapsedOwner.text)).not.toContain("a.ts");
			expect(stripAnsi(collapsedOwner.text)).not.toContain("foo");

			// Toggling back to verbose reveals children again (simulates the
		// rebuildChatFromMessages() path triggered by Ctrl+T).
			setThinkingBlocksHidden(false);
			const revealedOwner = r.renderCall(
				"read",
				{ file_path: "a.ts" },
				theme,
				makeContext("a", stateA) as any,
			) as any;
			expect(stripAnsi(revealedOwner.text)).toContain("a.ts");
			expect(stripAnsi(revealedOwner.text)).toContain("foo");
		} finally {
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("settled group hides per-member error row when collapsed", () => {
		const prev_hidden = isThinkingBlocksHidden();
		try {
			const r = new CompactRenderer();
			const theme = makeTheme() as any;
			const stateA: Record<string, any> = {};
			const stateB: Record<string, any> = {};
			r.renderCall("read", { file_path: "a.ts" }, theme, makeContext("a", stateA) as any);
			r.renderCall("grep", { pattern: "foo" }, theme, makeContext("b", stateB) as any);
			// Owner (read) fails; second member succeeds.
			r.renderResult(
				"read",
				{ file_path: "a.ts" },
				{ content: [{ type: "text", text: "Error: boom" }] },
				{ isPartial: false },
				theme,
				{ ...makeContext("a", stateA), isError: true } as any,
			);
			r.renderResult(
				"grep",
				{ pattern: "foo" },
				{ content: [{ type: "text", text: "ok" }] },
				{ isPartial: false },
				theme,
				{ ...makeContext("b", stateB), isError: false } as any,
			);
			r.settleAllGroups();

			// Verbose: the owner's error row renders below the group header.
			setThinkingBlocksHidden(false);
			const verboseResult = r.renderResult(
				"read",
				{ file_path: "a.ts" },
				{ content: [{ type: "text", text: "Error: boom" }] },
				{ isPartial: false },
				theme,
				{ ...makeContext("a", stateA), isError: true } as any,
			) as any;
			expect(stripAnsi(verboseResult.text)).toContain("boom");

			// Compact: the owner's error row is suppressed; the header bullet
			// already signals the failure (red).
			setThinkingBlocksHidden(true);
			const collapsedResult = r.renderResult(
				"read",
				{ file_path: "a.ts" },
				{ content: [{ type: "text", text: "Error: boom" }] },
				{ isPartial: false },
				theme,
				{ ...makeContext("a", stateA), isError: true } as any,
			) as any;
			expect(stripAnsi(collapsedResult.text)).not.toContain("boom");
		} finally {
			setThinkingBlocksHidden(prev_hidden);
		}
	});
});
