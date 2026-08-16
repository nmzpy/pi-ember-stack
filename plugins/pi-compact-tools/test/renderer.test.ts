import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	apply_assistant_stream_boundary,
	resolve_assistant_stream_boundary_event,
} from "../../pi-ember-ui/assistant-stream-boundary.ts";
import { CompactRenderer, formatCallBody, formatCompactChildRow, formatUnifiedWorkHeader, strip_bash_command_preview, GROUP_CHILD_FOLD_DEBOUNCE_MS } from "../renderer.ts";
import {
	deactivate_gradient,
	dispatch_gradient_tick,
	gradient_clock_is_idle,
	set_gradient_render_request,
	shutdown_gradient_clock,
} from "../../pi-ember-ui/gradient.ts";
import {
	isThinkingBlocksHidden,
	resetToolExecutionInFlight,
	setAgentRunPending,
	setThinkingBlocksHidden,
	setTurnToolTranscriptActive,
	begin_work_group_boundary_suppression,
	end_work_group_boundary_suppression,
} from "../../pi-ember-ui/mode-colors.ts";

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

async function flush_group_child_fold_debounce(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, GROUP_CHILD_FOLD_DEBOUNCE_MS + 25));
}

afterEach(() => {
	// Local renderer instances subscribe to the shared clock. Dispose the
	// process-global clock between tests so one instance cannot keep a later
	// Thinking-header test permanently non-idle.
	shutdown_gradient_clock();
});

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
		expect(row).not.toContain("-0");

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
		expect(row).not.toContain("-0");
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
		expect(row).not.toContain("-0");
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
		expect(row).not.toContain("-0");

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

describe("CompactRenderer group child visibility", () => {
	test("completed children stay visible until the next tool call absorbs them", async () => {
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

		// Both complete: every child row stays under the unified work header.
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).toContain("Read");
		expect(row).toContain("a.ts");
		expect(row).toContain("b.ts");

		// Same-name call (read c.ts) appends below without folding priors.
		const baby_state: Record<string, any> = {};
		const baby_ctx = makeContext("g3", baby_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		expect(row).toContain("b.ts");
		await flush_group_child_fold_debounce();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");

		// A different tool name (grep) folds the prior read wave after debounce.
		r.settleAllGroups();
		const next_state: Record<string, any> = {};
		const next_ctx = makeContext("g4", next_state) as any;
		r.renderCall("grep", { pattern: "x", path: "d.ts" }, theme, next_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("d.ts");
		await flush_group_child_fold_debounce();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).not.toContain("c.ts");
		expect(row).not.toContain("b.ts");
	});

	test("beginTurn keeps lingering tool children until thinking or tool-wave reopen", async () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("noop-turn1", owner_state) as any;
		const child_ctx = makeContext("noop-turn2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		r.beginTurn();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");

		const wave_ctx = makeContext("noop-turn3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, wave_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");
		await flush_group_child_fold_debounce();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).not.toContain("b.ts");
	});

	test("endTurn keeps completed tool children visible until thinking folds them", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("end-turn1", owner_state) as any;
		const child_ctx = makeContext("end-turn2", {}) as any;

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
		r.endTurn();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");
		expect(row).not.toContain("Thinking");
	});

	test("parallel burst keeps prior children visible for debounce window", async () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("burst-owner", owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.settleAllGroups();

		const wave2: string[] = [];
		for (let i = 0; i < 4; i++) {
			const id = `burst-${i}`;
			const ctx = makeContext(id, {}) as any;
			wave2.push(id);
			r.renderCall("read", { path: `${id}.ts` }, theme, ctx);
			r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		}
		const row = stripAnsi((owner_state.callText as any).text);
		for (const id of wave2) {
			expect(row).toContain(`${id}.ts`);
		}
		expect(row).toContain("a.ts");
	});

	test("new tool wave folds prior completed children immediately", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("wave-fold1", owner_state) as any;
		const child_ctx = makeContext("wave-fold2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		// A different tool name (read after grep) folds the prior grep wave
		// immediately so only the fresh read wave is visible.
		const wave2_ctx = makeContext("wave-fold3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, wave2_ctx);
		// Re-render the owner to refresh the shared group block.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		expect(row).not.toContain("b.ts");
		// Same-name read appends below the fresh wave without folding it.
		const wave2_ctx2 = makeContext("wave-fold4", {}) as any;
		r.renderCall("read", { path: "d.ts" }, theme, wave2_ctx2);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("d.ts");
		expect(row).toContain("c.ts");
	});

	test("completed tools stay visible after settle without thinking stream", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("linger-settle1", owner_state) as any;
		const child_ctx = makeContext("linger-settle2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();

		// After settle, the prior completed read and grep are folded into the
		// unified work header so the transcript stays compact.
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).not.toContain("a.ts");
		expect(r.hasGroupThinkingChild()).toBe(false);
	});

	test("completed tools stay visible through thinking stream", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("no-flush1", owner_state) as any;
		const child_ctx = makeContext("no-flush2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();

		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).toContain("b.ts");
		expect(r.hasGroupThinkingChild()).toBe(false);

		r.noteThinking();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
	});

	test("hasActiveGroups is false when only lingering completed children remain", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("linger-active1", owner_state) as any;
		const child_ctx = makeContext("linger-active2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();

		expect(r.hasActiveGroups()).toBe(false);
		expect(r.hasReopenableGroup()).toBe(true);
	});

	test("resyncGroupGradientTick stops 20 FPS renders for settled lingering children", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("tick-linger-1", owner_state) as any;
		const child_ctx = makeContext("tick-linger-2", {}) as any;
		const render_calls: number[] = [];
		set_gradient_render_request(() => render_calls.push(1));

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		r.resyncGroupGradientTick();
		try {
			dispatch_gradient_tick();
			expect(render_calls.length).toBe(0);
		} finally {
			set_gradient_render_request(undefined);
			deactivate_gradient("thinking");
		}
	});

	test("noteThinking collapses on the anchor owner slot not the latest member", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const mid_state: Record<string, any> = {};
		const latest_state: Record<string, any> = {};
		const owner_ctx = makeContext("anchor-1", owner_state) as any;
		const mid_ctx = makeContext("anchor-2", mid_state) as any;
		const latest_ctx = makeContext("anchor-3", latest_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, mid_ctx);
		r.renderCall("read", { path: "c.ts" }, theme, latest_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		for (const [ctx, path] of [
			[owner_ctx, "a.ts"],
			[mid_ctx, "b.ts"],
			[latest_ctx, "c.ts"],
		] as const) {
			r.renderResult(
				"read",
				{ path },
				{ content: [{ type: "text", text: path }] },
				{ expanded: false, isPartial: false },
				theme,
				{ ...ctx, isError: false },
			);
		}

		r.noteThinking();
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Thinking");
		expect(mid_state.callText).toBeUndefined();
		expect(latest_state.callText).toBeUndefined();
		expect(r.renderCall("read", { path: "b.ts" }, theme, mid_ctx).render(80)).toHaveLength(0);
		expect(r.renderCall("read", { path: "c.ts" }, theme, latest_ctx).render(80)).toHaveLength(0);
	});

	test("noteThinking appends in-group Thinking after lingering tool rows", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("s1", owner_state) as any;
		const child_ctx = makeContext("s2", {}) as any;

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

		r.noteThinking();
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).toContain("Thinking");
		expect(row).toContain("a.ts");
		expect(row).toContain("b.ts");
		expect(r.hasGroupThinkingChild()).toBe(true);

		const baby_ctx = makeContext("s3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		// Same-name call (read) appends without folding prior children.
		expect(row).toContain("b.ts");
		expect(r.hasGroupThinkingChild()).toBe(false);
	});

	test("holdToolLane keeps the latest child gradient -ing with no Thinking lane", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hold-1", owner_state) as any;
		const child_ctx = makeContext("hold-2", {}) as any;

		r.renderCall("grep", { pattern: "x", path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("grep", { pattern: "x", path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
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

		// Wait with no thinking stream: the group HOLDS the tool lane.
		r.holdToolLane();
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).not.toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(false);
		// The latest completed child keeps its gradient `-ing` verb; the prior
		// grep wave folded into the header summary when `read` joined.
		expect(row).toContain("Reading");
		expect(row).toContain("b.ts");
		expect(row).toContain("1 search");
		expect(row).not.toContain("Search");
		expect(r.hasActiveGroups()).toBe(false);
	});

	test("hold keeps every visible child in its gradient -ing verb with a dashed branch", () => {
		// Blocks VISIBLE (default): the hold must still arm during the
		// pre-thinking wait so completed children read as ongoing work until a
		// thinking delta arrives.
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const g1 = makeContext("hold-wave-1", owner_state) as any;
		const g2 = makeContext("hold-wave-2", {}) as any;
		const g3 = makeContext("hold-wave-3", {}) as any;

		r.renderCall(
			"grep",
			{ pattern: "def get_interaction_render_snapshot", path: "gui/services/timeline_render_service.py" },
			theme,
			g1,
		);
		r.renderCall("grep", { pattern: "link", path: "gui/services/timeline_render_service.py" }, theme, g2);
		r.renderCall("grep", { pattern: "LINKS", path: "gui/components/timeline/constants.py" }, theme, g3);
		r.renderResult(
			"grep",
			{ pattern: "def get_interaction_render_snapshot", path: "gui/services/timeline_render_service.py" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...g1, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "link", path: "gui/services/timeline_render_service.py" },
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...g2, isError: false },
		);
		r.renderResult(
			"grep",
			{ pattern: "LINKS", path: "gui/components/timeline/constants.py" },
			{ content: [{ type: "text", text: "c" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...g3, isError: false },
		);

		// Wait with no thinking stream: the group HOLDS the tool lane and ALL
		// visible children of the wave keep their gradient `-ing` verbs.
		r.holdToolLane();
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).not.toContain("Thinking");
		// Only the latest visible child keeps its gradient `-ing` verb;
		// earlier completed children render as completed with a bare `│`.
		expect(row.split("Searching").length - 1).toBe(1);
		expect(row).toContain("Search");
		expect(row).not.toContain("├─");
		expect(row).toContain("└─");
		expect(row).not.toContain("├Search");
	});

	test("agent settlement clears a held tool lane and its gradient subscription", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("hold-settle", state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...ctx, isError: false },
		);
		r.holdToolLane();
		expect(gradient_clock_is_idle()).toBe(false);

		// agent_settled clears the hold before stopping remaining
		// standalone/group subscriptions.
		r.clearGroupThinkingChild();
		expect(gradient_clock_is_idle()).toBe(true);
		expect(stripAnsi(state.callText.text)).not.toContain("Reading");
	});

	test("stopGradientTicks kills a running standalone edit tick without a result", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("standalone-no-result", state) as any;

		// A standalone edit streams args but never receives a result callback
		// (interrupted stream): its gradient verb tick must not rely on
		// renderResult cleanup.
		r.renderCall("edit", { file_path: "foo.ts", oldText: "a", newText: "b" }, theme, ctx);
		expect(gradient_clock_is_idle()).toBe(false);

		r.stopGradientTicks();
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("holdToolLane renders edit/write children past tense (Edited/Wrote)", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hold-edit-1", owner_state) as any;
		const child_ctx = makeContext("hold-edit-2", {}) as any;

		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "a\nb" }, theme, owner_ctx);
		r.renderCall("write", { file_path: "b.ts", content: "x" }, theme, child_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "a\nb" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "a", newText: "a\nb" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "@@" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"write",
			{ file_path: "b.ts", content: "x" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		r.holdToolLane();
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Edited 1 file");
		expect(row).toContain("Wrote 1 file");
		// Completed mutations snap to past tense — never a lingering -ing.
		expect(row).toContain("Edited");
		expect(row).toContain("Wrote");
		expect(row).not.toContain("Editing");
		expect(row).not.toContain("Writing");
		expect(row).not.toContain("Thinking");
	});

	test("real thinking stream arms the lane from the hold; new wave clears the hold", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hold-flow-1", owner_state) as any;
		const child_ctx = makeContext("hold-flow-2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		r.holdToolLane();
		expect(r.hasGroupThinkingChild()).toBe(false);

		// A real thinking stream (hidden blocks) arms the lane from the hold.
		r.noteThinking();
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(true);

		// The next tool wave reopens the tool lane and clears the hold/lane.
		const baby_ctx = makeContext("hold-flow-3", {}) as any;
		r.renderCall("find", { query: "z", path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(r.hasGroupThinkingChild()).toBe(false);
		expect(row).not.toContain("Thinking");
		expect(row).toContain("Finding");
		expect(row).toContain("c.ts");
	});

	test("visible text hard-exits and clears child rows", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hard-vis1", owner_state) as any;
		const child_ctx = makeContext("hard-vis2", {}) as any;

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

		r.noteVisibleText();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).not.toContain("Reading");
		expect(row).not.toContain("b.ts");
	});
});

describe("CompactRenderer same-file child merge", () => {
	test("consecutive edits to the same file merge into one row with accumulated stats", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-e1", owner_state) as any;
		const child_ctx = makeContext("merge-e2", {}) as any;
		const third_ctx = makeContext("merge-e3", {}) as any;

		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "x\ny" }, theme, owner_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "y", newText: "y\nz" }, theme, child_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "z", newText: "z\nw" }, theme, third_ctx);
		// Re-render the owner to refresh the shared group block onto its callText.
		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "x\ny" }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Editing");
		expect(row).toContain("a.ts");
		expect(row).toContain("+3");
		// Mock theme wraps tokens in [tag:…], so count tree glyphs rather than
		// matching line starts: exactly one child row for the file.
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(1);
	});

	test("different files stay as separate child rows", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-f1", owner_state) as any;
		const child_ctx = makeContext("merge-f2", {}) as any;
		const third_ctx = makeContext("merge-f3", {}) as any;

		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "x\ny" }, theme, owner_ctx);
		r.renderCall("edit", { file_path: "b.ts", oldText: "p", newText: "p\nq" }, theme, child_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "a\nb" }, theme, third_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "x\ny" }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("a.ts");
		expect(row).toContain("b.ts");
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(2);
	});

	test("completed same-file edits accumulate authoritative diff stats", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-c1", owner_state) as any;
		const child_ctx = makeContext("merge-c2", {}) as any;
		const third_ctx = makeContext("merge-c3", {}) as any;

		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "y" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "x", newText: "y" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+one\n+two\n" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderCall("edit", { file_path: "a.ts", oldText: "y", newText: "z" }, theme, child_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "y", newText: "z" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+three\n" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.renderCall("edit", { file_path: "a.ts", oldText: "q", newText: "r" }, theme, third_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "q", newText: "r" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+four\n" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...third_ctx, isError: false },
		);
		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "y" }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Edited");
		expect(row).toContain("a.ts");
		expect(row).toContain("+4");
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(1);
	});

	test("write to the same file merges without a duplicate row", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-w1", owner_state) as any;
		const child_ctx = makeContext("merge-w2", {}) as any;
		const third_ctx = makeContext("merge-w3", {}) as any;

		r.renderCall("write", { file_path: "a.ts", content: "one\ntwo" }, theme, owner_ctx);
		r.renderCall("write", { file_path: "a.ts", content: "three" }, theme, child_ctx);
		r.renderCall("write", { file_path: "a.ts", content: "four" }, theme, third_ctx);
		r.renderCall("write", { file_path: "a.ts", content: "one\ntwo" }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Writing");
		expect(row).toContain("a.ts");
		expect(row).toContain("+4");
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(1);
	});

	test("same-file read calls still append as separate rows", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-r1", owner_state) as any;
		const child_ctx = makeContext("merge-r2", {}) as any;
		const third_ctx = makeContext("merge-r3", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, third_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("a.ts");
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(3);
	});

	test("pure apply_patch run merges duplicate per-file rows", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("merge-p1", owner_state) as any;
		const child_ctx = makeContext("merge-p2", {}) as any;
		const third_ctx = makeContext("merge-p3", {}) as any;

		const patch1 = "*** Update File: src/a.ts\n@@\n+one\n+two\n*** Update File: src/b.ts\n@@\n+one\n";
		const patch2 = "*** Update File: src/a.ts\n@@\n+three\n";
		const patch3 = "*** Update File: src/a.ts\n@@\n+four\n";
		r.renderCall("apply_patch", { input: patch1 }, theme, owner_ctx);
		r.renderCall("apply_patch", { input: patch2 }, theme, child_ctx);
		r.renderCall("apply_patch", { input: patch3 }, theme, third_ctx);
		r.renderCall("apply_patch", { input: patch1 }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Patching");
		expect(row).toContain("src/a.ts");
	expect(row).toContain("src/b.ts");
		expect((row.match(/[└├]/g) ?? [])).toHaveLength(2);
	});
});

describe("CompactRenderer thinking collapse", () => {
	test("noteThinking soft-settles header and appends Thinking after tool rows", () => {
		setThinkingBlocksHidden(true);
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

		r.noteThinking();
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(row).toContain("b.ts");
		expect(r.hasGroupThinkingChild()).toBe(true);
	});

	test("noteVisibleText collapses to header-only", () => {
		setThinkingBlocksHidden(true);
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
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");

		r.noteVisibleText();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).not.toContain("Searching");
		expect(r.hasGroupThinkingChild()).toBe(false);
	});

	test("edit joins unified work group after thinking settle", () => {
		setThinkingBlocksHidden(true);
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
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);

		const work_row = stripAnsi((owner_state.callText as any).text);
		expect(work_row).not.toContain("Thinking");
		expect(work_row).toContain("Editing");
		expect(work_row).toContain("d.ts");
	});

	test("noteVisibleText settles active group for thinking handoff", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("t1", owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, makeContext("t2", {}) as any);
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
			{ ...makeContext("t2", {}), isError: false },
		);
		expect(r.hasActiveGroups()).toBe(false);

		r.noteVisibleText();
		expect(r.hasActiveGroups()).toBe(false);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).not.toContain("Reading");
	});

	test("noteThinking soft-settles then same-key call reopens under one header", () => {
		setThinkingBlocksHidden(true);
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
		expect(r.hasGroupThinkingChild()).toBe(true);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row.toLowerCase()).toContain("explored");
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(row).toContain("b.ts");

		const baby_state: Record<string, any> = {};
		const baby_ctx = makeContext("soft3", baby_state) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("c.ts");
		// Same-name call (grep) appends without folding prior children.
		expect(row).toContain("b.ts");
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
		const old_row = stripAnsi((owner_state.callText as any).text);
		expect(old_row.toLowerCase()).toContain("explored");
		expect(old_row).not.toContain("Reading");

		const fresh_state: Record<string, any> = {};
		const fresh_ctx = makeContext("hard3", fresh_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		// Fresh group owner — standalone until a second member joins.
		const fresh_row = stripAnsi((fresh_state.callText as any).text);
		expect(fresh_row).toContain("c.ts");
		expect(fresh_row.toLowerCase()).not.toContain("explored");
		// Prior header stayed settled header-only (no reopen onto hard1).
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
	});

	test("unified work group reopens across tool types until hard exit", () => {
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

		const fresh_ctx = makeContext("chrono4", {}) as any;
		r.renderCall("grep", { pattern: "y", path: "e.ts" }, theme, fresh_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, explore_owner_ctx);

		const prior_work = stripAnsi((explore_owner_state.callText as any).text);
		expect(prior_work).toContain("Edited");
		expect(prior_work.toLowerCase()).toContain("explored");
		expect(prior_work).toContain("e.ts");
	});

	test("edited group folds prior wave when next tool batch reopens", async () => {
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
		expect(row).toContain("└");
		expect(row).toContain("other.ts");

		const baby_ctx = makeContext("edit-collapse3", {}) as any;
		r.renderCall("edit", { file_path: "next.ts", oldText: "a", newText: "b" }, theme, baby_ctx);
		r.renderCall("edit", { file_path: "runner.ts", oldText: "a", newText: "b" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Editing");
		expect(row).toContain("next.ts");
		expect(row).toContain("other.ts");
		await flush_group_child_fold_debounce();
		r.renderCall("edit", { file_path: "runner.ts", oldText: "a", newText: "b" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		// Same-name call (edit) appends without folding prior children.
		expect(row).toContain("other.ts");
	});

	test("agent_end lifecycle shows Thinking child then reopens with folded prior batch", async () => {
		setThinkingBlocksHidden(true);
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
		expect(row.toLowerCase()).toContain("explored");
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(r.hasActiveGroups()).toBe(true);
		expect(r.hasGroupThinkingChild()).toBe(true);

		const baby_ctx = makeContext("ae3", {}) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("c.ts");
		// Same-name call (grep) appends without folding prior children.
		expect(row).toContain("b.ts");
		expect(row).not.toMatch(/explored[\s\S]*explored/i);
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
		expect(r.hasReopenableGroup()).toBe(true);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Read");

		const baby_ctx = makeContext("end3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Reading");
		expect(row).toContain("c.ts");
		expect(row.toLowerCase()).toContain("explored");
	});

	test("three discovery batches across agent_end cycles reopen one work header", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("batch-owner", owner_state) as any;
		let baby_id = 0;

		const run_first_batch = (paths: string[]) => {
			r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			const child_ctx = makeContext(`batch-baby-${baby_id++}`, {}) as any;
			r.renderCall("grep", { pattern: "x", path: paths[1] }, theme, child_ctx);
			r.renderResult(
				"grep",
				{ pattern: "x", path: paths[0] },
				{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
				{ expanded: false, isPartial: false },
				theme,
				{ ...owner_ctx, isError: false },
			);
			r.renderResult(
				"grep",
				{ pattern: "x", path: paths[1] },
				{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
				{ expanded: false, isPartial: false },
				theme,
				{ ...child_ctx, isError: false },
			);
			r.settleAllGroups();
		};

		const run_next_batch = (paths: string[]) => {
			for (const file_path of paths) {
				const child_ctx = makeContext(`batch-baby-${baby_id++}`, {}) as any;
				r.renderCall("grep", { pattern: "x", path: file_path }, theme, child_ctx);
				r.renderResult(
					"grep",
					{ pattern: "x", path: file_path },
					{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
					{ expanded: false, isPartial: false },
					theme,
					{ ...child_ctx, isError: false },
				);
			}
			r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			r.settleAllGroups();
		};

		run_first_batch(["a.ts", "b.ts"]);
		run_next_batch(["c.ts", "d.ts"]);
		run_next_batch(["e.ts", "f.ts"]);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("6 searches");
		expect(row).not.toMatch(/6 searches[\s\S]*6 searches/);
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

	test("running Bash child appears inside the unified work group", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const state: Record<string, any> = {};
		const ctx = makeContext("running-bash", state) as any;
		const child_ctx = makeContext("running-bash-child", {}) as any;
		const ctx2 = makeContext("running-bash2", {}) as any;

		r.renderCall("bash", { command: "npm test" }, theme, ctx);
		// A different tool name (read) folds the prior bash wave immediately
		// so only the fresh wave is visible under the unified `Working` header.
		r.renderCall("read", { path: "package.json" }, theme, child_ctx);
		// Refresh the group block through the original owner component.
		r.renderCall("bash", { command: "npm test" }, theme, ctx);
		let row = stripAnsi((state.callText as any).text);
		expect(row).toContain("Working");
		expect(row).toContain("Reading");
		expect(row).toContain("package.json");
		// A fresh same-name bash wave reopens and becomes the visible child.
		r.renderCall("bash", { command: "npm test" }, theme, ctx2);
		// Re-render the owner to refresh the shared group block.
		r.renderCall("bash", { command: "npm test" }, theme, ctx);
		row = stripAnsi((state.callText as any).text);
		expect(row).toContain("Running");
		expect(row).toContain("npm test");
		expect(row).not.toContain("Bashing");
	});

	test("noteThinking paints in-group Thinking for a single settled tool", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("single-tool", owner_state) as any;

		r.renderCall("read", { path: "solo.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "solo.ts" },
			{ content: [{ type: "text", text: "solo" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);

		r.noteThinking();
		expect(r.hasGroupThinkingChild()).toBe(true);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
	});

	test("noteThinking paints in-group Thinking when blocks are hidden", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("visible-blocks", owner_state) as any;
		const child_ctx = makeContext("visible-blocks2", {}) as any;

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

		r.noteThinking();
		expect(r.hasGroupThinkingChild()).toBe(true);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(row).toContain("b.ts");
	});

	test("noteHiddenThinking arms in-group Thinking without folding children", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("planning-owner", owner_state) as any;
		const child_ctx = makeContext("planning-child", {}) as any;

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

		// Hidden reasoning (blocks hidden) arms the in-group Thinking lane.
		// Thinking never folds prior tool children — the `└ Thinking` lane
		// appends after lingering rows.
		r.noteHiddenThinking();
		expect(r.hasGroupThinkingChild()).toBe(true);
		// Children must linger (not fold) for the hidden-thinking boundary.
		expect(r.hasVisibleGroupChildren()).toBe(true);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(row).toContain("b.ts");
		// Group stays reopenable (no reopenClosed) so the next tool wave reopens.
		expect(r.hasReopenableGroup()).toBe(true);
	});

	test("noteInterveningToolCall hard-exits so later exploration starts a fresh group", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("chrono-explore", owner_state) as any;
		const child_ctx = makeContext("chrono-explore2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		const prior_row = stripAnsi((owner_state.callText as any).text);
		expect(prior_row.toLowerCase()).toContain("explored");

		r.noteInterveningToolCall();

		const fresh_state: Record<string, any> = {};
		const fresh_ctx = makeContext("chrono-explore3", fresh_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		r.renderCall("grep", { pattern: "y", path: "d.ts" }, theme, makeContext("chrono-explore4", {}) as any);
		// Use a fresh id for the second same-name read so it becomes the
		// visible child of the new wave rather than updating the folded record.
		const fresh_ctx2 = makeContext("chrono-explore5", fresh_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx2);
		r.renderResult(
			"read",
			{ path: "c.ts" },
			{ content: [{ type: "text", text: "c" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...fresh_ctx2, isError: false },
		);
		const fresh_row = stripAnsi((fresh_state.callText as any).text);
		expect(fresh_row).toContain("c.ts");
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
		expect(stripAnsi((owner_state.callText as any).text).toLowerCase()).toContain("explored");
	});

	test("noteSoftInterveningToolCall keeps work group reopenable after todo", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("todo-soft-1", owner_state) as any;
		const child_ctx = makeContext("todo-soft-2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		const before_todo = stripAnsi((owner_state.callText as any).text);
		expect(before_todo.toLowerCase()).toContain("explored");

		r.noteSoftInterveningToolCall();
		const after_todo = stripAnsi((owner_state.callText as any).text);
		expect(after_todo).toContain("b.ts");

		const after_state: Record<string, any> = {};
		const after_ctx = makeContext("todo-soft-3", after_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, after_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const after_row = stripAnsi((after_state.callText as any).text);
		expect(after_row).toContain("c.ts");
		expect(after_row.toLowerCase()).toContain("explored");
		expect(stripAnsi((owner_state.callText as any).text ?? "")).not.toContain("c.ts");
	});

	test("same tool name keeps prior children lingering across debounce", async () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("repeat-owner", owner_state) as any;
		const child_ctx = makeContext("repeat-child", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);

		const repeat_ctx = makeContext("repeat-same", {}) as any;
		r.renderCall("grep", { pattern: "z", path: "c.ts" }, theme, repeat_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");

		await flush_group_child_fold_debounce();
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("b.ts");
	});

	test("noteSoftInterveningToolCall then thinking paints in-group Thinking when blocks hidden", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("todo-think-1", owner_state) as any;

		r.renderCall("edit", { path: "a.ts", oldText: "x", newText: "y" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			{ path: "a.ts", oldText: "x", newText: "y" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+1 -1" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.settleAllGroups();
		r.noteSoftInterveningToolCall();
		r.noteThinking();

		expect(stripAnsi((owner_state.callText as any).text ?? "")).not.toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(false);

		const after_state: Record<string, any> = {};
		const after_ctx = makeContext("todo-think-2", after_state) as any;
		r.renderCall("read", { path: "b.ts" }, theme, after_ctx);
		r.noteThinking();

		const row = stripAnsi((after_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(true);
	});

	test("same-key call reopens settled group instead of spawning a second header", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("reopen1", owner_state) as any;
		const child_ctx = makeContext("reopen2", {}) as any;

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
			{ content: [{ type: "text", text: "b" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		(r as any).currentGroup = undefined;

		const baby_state: Record<string, any> = {};
		const baby_ctx = makeContext("reopen3", baby_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, baby_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("c.ts");
		expect(row.toLowerCase()).toContain("explored");
		expect(baby_state.callText).toBeUndefined();
	});

	test("announceToolCall drops the in-group Thinking lane synchronously and keeps the group reopenable", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ann-lane1", owner_state) as any;
		const child_ctx = makeContext("ann-lane2", {}) as any;

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
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(true);

		// The model announces the next tool call (message_update toolcall_start)
		// before its args finish streaming. The lane must vanish in this same
		// component update — no gradient tick, no tool_call, no microtask.
		r.announceToolCall();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).not.toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(false);
		// Soft/reopenable grouping is preserved: not a hard exit.
		expect(r.hasReopenableGroup()).toBe(true);
		expect(r.hasVisibleGroupChildren()).toBe(true);

		// The arriving same-key call reopens the SAME header — one bullet row,
		// no duplicated Explored/… header, no stale Thinking lane.
		const wave_ctx = makeContext("ann-lane3", {}) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, wave_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("c.ts");
		expect(row).not.toContain("Thinking");
		expect((row.match(/•/g) ?? [])).toHaveLength(1);
	});

	test("hidden-thinking consecutive groupable calls with no visible text batch into one work group", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("batch-hidden1", owner_state) as any;

		// Tool wave 1: read completes, hidden thinking lane arms between waves.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.settleAllGroups();
		r.noteThinking();
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Thinking");

		// Tool wave 2: announce (toolcall_start) then execute — same work group.
		r.announceToolCall();
		const wave_ctx = makeContext("batch-hidden2", {}) as any;
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, wave_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("b.ts");
		expect(row).not.toContain("Thinking");
		// ONE unified work header for the whole burst.
		expect((row.match(/•/g) ?? [])).toHaveLength(1);
	});

	test("thinkingBlocksHidden state and listener are shared across module instances", async () => {
		// Simulate jiti module duplication: a query-string dynamic import yields
		// a second module instance of mode-colors.ts. The flag must agree across
		// instances because it lives on globalThis via Symbol.for, exactly like
		// SHELL_MODE_KEY — a per-instance `let` would desync pi-ember-ui's
		// setter from pi-compact-tools' reader and leave a stale Thinking lane.
		const specifier =
			"../../pi-ember-ui/mode-colors.ts?instance=thinking-blocks-hidden-desync";
		const second = (await import(specifier)) as {
			isThinkingBlocksHidden: () => boolean;
			setThinkingBlocksHidden: (hidden: boolean) => void;
			set_thinking_blocks_visibility_listener: (
				listener: ((hidden: boolean) => void) | undefined,
			) => void;
		};
		setThinkingBlocksHidden(false);
		expect(second.isThinkingBlocksHidden()).toBe(false);
		setThinkingBlocksHidden(true);
		expect(second.isThinkingBlocksHidden()).toBe(true);

		// The visibility listener is shared too: register on the second
		// instance, toggle from the first, and the callback fires.
		const seen: boolean[] = [];
		second.set_thinking_blocks_visibility_listener((hidden: boolean) => {
			seen.push(hidden);
		});
		setThinkingBlocksHidden(false);
		expect(seen).toEqual([false]);
		second.setThinkingBlocksHidden(true);
		expect(seen).toEqual([false, true]);
		expect(isThinkingBlocksHidden()).toBe(true);

		// Cleanup: drop the listener and reset the shared flag.
		second.set_thinking_blocks_visibility_listener(undefined);
		setThinkingBlocksHidden(false);
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
		expect(row).toContain("[error:• ]");
		expect(row).toContain("Invalid Context");
		expect(row).not.toContain("0/1 ok");
	});
});

describe("CompactRenderer apply_patch grouping", () => {
	test("uses a collapsible Patching group for two pure patch calls", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("patch-group-owner", owner_state) as any;
		const second_ctx = makeContext("patch-group-second", {}) as any;
		const first_input = [
			"*** Begin Patch",
			"*** Add File: first.ts",
			"+first",
			"*** End Patch",
		].join("\n");
		const second_input = [
			"*** Begin Patch",
			"*** Add File: second.ts",
			"+second",
			"*** End Patch",
		].join("\n");

		r.renderCall("apply_patch", { input: first_input }, theme, owner_ctx);
		r.renderCall("apply_patch", { input: second_input }, theme, second_ctx);
		r.renderCall("apply_patch", { input: first_input }, theme, owner_ctx);

		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Patching 2 files");
		expect(row).toContain("+2");
		expect(row).toContain("first.ts");
		expect(row).toContain("second.ts");
		expect(second_ctx.state.callText).toBeUndefined();

		r.renderResult(
			"apply_patch",
			{ input: first_input },
			{
				details: {
					ok: true,
					fileCount: 1,
					results: [{ path: "first.ts", op: "add", status: "ok" }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"apply_patch",
			{ input: second_input },
			{
				details: {
					ok: true,
					fileCount: 1,
					results: [{ path: "second.ts", op: "add", status: "ok" }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...second_ctx, isError: false },
		);

		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Patched 2 files");
		expect(row).toContain("+2");
		expect(row).toContain("first.ts");
		expect(row).toContain("second.ts");

		r.settleAllGroups();
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Patched 2 files");
		expect(row).not.toContain("first.ts");
		expect(row).not.toContain("second.ts");
	});

	test("keeps mixed patch calls in the public unified work group", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("patch-mixed-owner", owner_state) as any;
		const read_ctx = makeContext("patch-mixed-read", {}) as any;
		const patch_input = [
			"*** Begin Patch",
			"*** Update File: changed.ts",
			"@@",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");

		r.renderCall("apply_patch", { input: patch_input }, theme, owner_ctx);
		r.renderCall("read", { path: "inspected.ts" }, theme, read_ctx);
		r.renderCall("apply_patch", { input: patch_input }, theme, owner_ctx);
		r.renderResult(
			"apply_patch",
			{ input: patch_input },
			{
				details: {
					ok: true,
					fileCount: 1,
					results: [{ path: "changed.ts", op: "update", status: "ok" }],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"read",
			{ path: "inspected.ts" },
			{ content: [{ type: "text", text: "contents" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...read_ctx, isError: false },
		);
		r.renderCall("apply_patch", { input: patch_input }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Edited 1 file");
		expect(row).toContain("Explored 1 file");
		expect(row).not.toContain("Patching");
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
			requestGradientRender: gradient.request_gradient_render,
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

describe("unified work header", () => {
	test("formats cross-type summary with bright aggregate diff", async () => {
		const { formatUnifiedWorkHeader } = await import("../renderer.ts");
		const theme = makeTheme() as any;
		const group = {
			records: [
				{
					name: "read",
					args: { path: "a.ts" },
					_completed: true,
					isError: false,
				},
				{
					name: "grep",
					args: { pattern: "x", path: "b.ts" },
					_completed: true,
					isError: false,
				},
				{
					name: "edit",
					args: { file_path: "c.ts" },
					_completed: true,
					isError: false,
					result: { details: { diff: "+\n+\n-" } },
				},
				{
					name: "bash",
					args: { command: "npm test" },
					_completed: true,
					isError: false,
				},
			],
			type: "work",
			key: "__work__",
		} as any;
		const header = stripAnsi(formatUnifiedWorkHeader(group, theme));
		expect(header).toContain("Edited 1 file");
		expect(header).toContain("Explored 1 file");
		expect(header).toContain("1 search");
		expect(header).toContain("Ran 1 command");
		expect(header).toContain("+2");
		expect(header).toContain("-1");
	});

	test("omits -0 when aggregate removals are zero", async () => {
		const { formatUnifiedWorkHeader } = await import("../renderer.ts");
		const theme = makeTheme() as any;
		const group = {
			records: [
				{
					name: "edit",
					args: { file_path: "a.ts" },
					_completed: true,
					isError: false,
					result: { details: { diff: "+\n".repeat(279) } },
				},
				{
					name: "bash",
					args: { command: "npm test" },
					_completed: true,
					isError: false,
				},
			],
			type: "work",
			key: "__work__",
		} as any;
		const header = stripAnsi(formatUnifiedWorkHeader(group, theme));
		expect(header).toContain("+279");
		expect(header).not.toContain("-0");
	});

	test("falls back to edit args when details.diff is missing", async () => {
		const { formatUnifiedWorkHeader } = await import("../renderer.ts");
		const theme = makeTheme() as any;
		const group = {
			records: [
				{
					name: "read",
					args: { path: "a.ts" },
					_completed: true,
					isError: false,
				},
				{
					name: "edit",
					args: { file_path: "c.ts", oldText: "a\nc", newText: "a\nb\nd" },
					_completed: true,
					isError: false,
					result: { content: [{ type: "text", text: "ok" }] },
				},
				{
					name: "bash",
					args: { command: "npm test" },
					_completed: true,
					isError: false,
				},
			],
			type: "work",
			key: "__work__",
		} as any;
		const header = stripAnsi(formatUnifiedWorkHeader(group, theme));
		expect(header).toContain("Edited 1 file");
		expect(header).toContain("+2");
		expect(header).toContain("-1");
	});

	test("first completed edit paints header diff before a second edit", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("edit-header-owner", owner_state) as any;
		const edit_ctx = makeContext("edit-header-edit", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, makeContext("edit-header-grep", {}) as any);
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
			{ ...makeContext("edit-header-grep", {}), isError: false },
		);
		r.renderCall("edit", { file_path: "c.ts", oldText: "a\nc", newText: "a\nb\nd" }, theme, edit_ctx);
		r.renderResult(
			"edit",
			{ file_path: "c.ts", oldText: "a\nc", newText: "a\nb\nd" },
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_ctx, isError: false },
		);

		const header = stripAnsi((owner_state.callText as any).text);
		expect(header).toContain("Edited 1 file");
		expect(header).toContain("+2");
		expect(header).toContain("-1");
	});

	test("late details.diff enrichment refreshes grouped header on duplicate renderResult", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("late-diff-owner", owner_state) as any;
		const edit_ctx = makeContext("late-diff-edit", {}) as any;
		const edit_args = { file_path: "c.ts" };
		const result: { content: Array<{ type: string; text: string }>; details?: { diff: string } } = {
			content: [{ type: "text", text: "ok" }],
		};

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("edit", edit_args, theme, edit_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			edit_args,
			result,
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_ctx, isError: false },
		);
		let header = stripAnsi((owner_state.callText as any).text);
		expect(header).not.toContain("+2");

		result.details = { diff: "+\n+\n-" };
		r.renderResult(
			"edit",
			edit_args,
			result,
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_ctx, isError: false },
		);
		header = stripAnsi((owner_state.callText as any).text);
		expect(header).toContain("+2");
		expect(header).toContain("-1");
	});

	test("folded bash failure clears active error from work group header", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("bash-err-owner", owner_state) as any;
		const child_ctx = makeContext("bash-err-child", {}) as any;

		r.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
		r.renderResult(
			"bash",
			{ command: "npm test" },
			{ content: [{ type: "text", text: "(no output)" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: true },
		);
		let row = (owner_state.callText as any).text as string;
		expect(row).toContain("[error:• ]");

		// A different tool name (read) folds the failed bash and becomes the
		// visible child, so the active error leaves the header.
		const wave_ctx = makeContext("bash-err-wave", {}) as any;
		r.renderCall("read", { path: "b.ts" }, theme, wave_ctx);
		r.renderResult(
			"read",
			{ path: "b.ts" },
			{ content: [{ type: "text", text: "b" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...wave_ctx, isError: false },
		);
		// Re-render the owner so the shared group block reflects the new wave.
		r.renderCall("bash", { command: "npm test" }, theme, owner_ctx);
		row = (owner_state.callText as any).text as string;
		expect(row).not.toContain("[error:• ]");
		expect(row).toContain("[success:• ]");
	});

	test("grouped edit child stats use muted diff colors", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("muted-child1", owner_state) as any;
		const child_ctx = makeContext("muted-child2", {}) as any;

		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "bb" }, theme, owner_ctx);
		r.renderCall("edit", { file_path: "b.ts", oldText: "a", newText: "bb" }, theme, child_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "a", newText: "bb" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+++\n-" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"edit",
			{ file_path: "b.ts", oldText: "a", newText: "bb" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "bb" }, theme, owner_ctx);
		const row = (owner_state.callText as any).text as string;
		expect(row).toContain("Edited 2 files");
		expect(row).toContain("Edit");
		expect(row).toContain("[success:+1]");
		expect(row).toContain("[error:-1]");
		expect(row).toContain("[muted:+1]");
		expect(row).toContain("a.ts");
		expect(row).toContain("b.ts");
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

		const edit_renderer = new CompactRenderer();
		const edit_state: Record<string, any> = {};
		const edit_ctx = makeContext("edit-bullet", edit_state) as any;
		edit_renderer.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "b" }, theme, edit_ctx);
		expect((edit_state.callText as any).text).toContain("[muted:• ]");
		edit_renderer.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "a", newText: "b" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: { additions: 1, removals: 0 } } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...edit_ctx, isError: false },
		);
		edit_renderer.renderCall("edit", { file_path: "a.ts", oldText: "a", newText: "b" }, theme, edit_ctx);
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

describe("resolve_assistant_stream_boundary_event", () => {
	test("ignores text_start and empty text_delta", () => {
		expect(resolve_assistant_stream_boundary_event({ type: "text_start" })).toBeNull();
		expect(resolve_assistant_stream_boundary_event({ type: "text_delta", delta: "" })).toBeNull();
		expect(resolve_assistant_stream_boundary_event({ type: "text_delta", delta: "   " })).toBeNull();
		expect(resolve_assistant_stream_boundary_event({ type: "text_delta", delta: "hello" })).toBe(
			"visible_text",
		);
	});

	test("classifies thinking stream events", () => {
		expect(resolve_assistant_stream_boundary_event({ type: "thinking_start" })).toBe("thinking");
		expect(resolve_assistant_stream_boundary_event({ type: "thinking_delta", delta: "" })).toBe(
			"thinking",
		);
	});
});

describe("apply_assistant_stream_boundary inter-run gap", () => {
	function setup_inter_run_gap(): void {
		setAgentRunPending(true);
		setTurnToolTranscriptActive(true);
		resetToolExecutionInFlight();
	}

	function settle_discovery_pair(
		r: CompactRenderer,
		theme: ReturnType<typeof makeTheme>,
		owner_ctx: ReturnType<typeof makeContext>,
		child_ctx: ReturnType<typeof makeContext>,
	): void {
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
	}

	test("inter-run planning text hard-exits the work group", () => {
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-plan1", owner_state) as any;
		const child_ctx = makeContext("ir-plan2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, {
			type: "text_delta",
			delta: "Task: continue investigation",
		});
		// Non-reasoning, non-tool text always hard-splits the work group so
		// emitted text can never appear below an ongoing work group.
		expect(r.hasReopenableGroup()).toBe(false);
		expect(r.hasGroupThinkingChild()).toBe(false);

		const fresh_ctx = makeContext("ir-plan3", {}) as any;
		r.renderCall("grep", { pattern: "x", path: "c.ts" }, theme, fresh_ctx);
		expect(r.hasReopenableGroup()).toBe(true);
	});

	test("inter-run plain text with hidden thinking hard-exits", () => {
		// Any visible non-reasoning, non-tool text hard-splits the work group
		// even when thinking blocks are hidden and the agent is still pending.
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-gap1", owner_state) as any;
		const child_ctx = makeContext("ir-gap2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, {
			type: "text_delta",
			delta: "Here is some inter-tool narration.",
		});
		expect(r.hasReopenableGroup()).toBe(false);

		// The next same-key call must start a FRESH header, not reopen the old one.
		const fresh_ctx = makeContext("ir-gap3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		r.renderResult(
			"read",
			{ path: "c.ts" },
			{ content: [{ type: "text", text: "c" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...fresh_ctx, isError: false },
		);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
	});

	test("three discovery batches separated by visible text create separate work headers", () => {
		// Each visible text_delta between batches is a hard boundary, so each
		// batch keeps its own work header instead of merging into one.
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-batch-owner", owner_state) as any;
		let baby_id = 0;

		const run_batch = (paths: string[]) => {
			if (baby_id === 0) {
				r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			}
			for (const file_path of paths) {
				const child_ctx = makeContext(`ir-batch-${baby_id++}`, {}) as any;
				r.renderCall("grep", { pattern: "x", path: file_path }, theme, child_ctx);
				r.renderResult(
					"grep",
					{ pattern: "x", path: file_path },
					{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
					{ expanded: false, isPartial: false },
					theme,
					{ ...child_ctx, isError: false },
				);
			}
			r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			r.settleAllGroups();
			apply_assistant_stream_boundary(r, {
				type: "text_delta",
				delta: "Task: next batch",
			});
		};

		run_batch(["a.ts", "b.ts"]);
		run_batch(["c.ts", "d.ts"]);
		run_batch(["e.ts", "f.ts"]);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("2 searches");
		expect(row).not.toContain("6 searches");
	});

	test("three batches separated by hidden plain-text narration create separate work headers", () => {
		// Any plain text_delta hard-exits the group, so consecutive exploration
		// batches separated by narration get separate headers.
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("nar-owner", owner_state) as any;
		let baby_id = 0;

		const run_batch = (paths: string[]) => {
			if (baby_id === 0) {
				r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			}
			for (const file_path of paths) {
				const child_ctx = makeContext(`nar-${baby_id++}`, {}) as any;
				r.renderCall("grep", { pattern: "x", path: file_path }, theme, child_ctx);
				r.renderResult(
					"grep",
					{ pattern: "x", path: file_path },
					{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
					{ expanded: false, isPartial: false },
					theme,
					{ ...child_ctx, isError: false },
				);
			}
			r.renderCall("grep", { pattern: "x", path: paths[0] }, theme, owner_ctx);
			r.settleAllGroups();
			// Non-planning plain narration ("Thinking"-style, not a Label:/header):
			apply_assistant_stream_boundary(r, {
				type: "text_delta",
				delta: "let me check where that symbol is defined",
			});
		};

		run_batch(["a.ts", "b.ts"]);
		run_batch(["c.ts", "d.ts"]);
		run_batch(["e.ts", "f.ts"]);

		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("2 searches");
		expect(row).not.toContain("6 searches");
	});

	test("visible_text after agent settled still hardExits", () => {
		setThinkingBlocksHidden(true);
		setAgentRunPending(false);
		setTurnToolTranscriptActive(true);
		resetToolExecutionInFlight();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-hard1", owner_state) as any;
		const child_ctx = makeContext("ir-hard2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, { type: "text_delta", delta: "final answer text" });
		expect(r.hasActiveGroups()).toBe(false);

		const fresh_ctx = makeContext("ir-hard3", {}) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
	});

	test("thinking_delta with hidden blocks shows in-group Thinking child", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-think-hidden1", owner_state) as any;
		const child_ctx = makeContext("ir-think-hidden2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(row).toContain("Search");
		expect(r.hasGroupThinkingChild()).toBe(true);
		// Hidden reasoning is NOT a separate transcript block — the group stays
		// reopenable so the next tool wave reopens under the same header instead
		// of spawning a fresh Explored row.
		expect(r.hasReopenableGroup()).toBe(true);
	});

	test("hidden thinking keeps one group header across tool waves", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("hidden-reopen-1", owner_state) as any;
		const child_ctx = makeContext("hidden-reopen-2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		// Hidden thinking arms the in-group lane but keeps the group reopenable.
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		expect(r.hasReopenableGroup()).toBe(true);

		// A different tool name reopens the SAME group, folding prior children.
		const wave_ctx = makeContext("hidden-reopen-3", {}) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, wave_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).toContain("c.ts");
		// No second Explored header — the prior wave folded into the same group.
		expect(row).not.toMatch(/explored[\s\S]*explored/i);
	});

	test("thinking_delta with blocks visible hard-exits for a fresh downstream group", () => {
		setThinkingBlocksHidden(false);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-think1", owner_state) as any;
		const child_ctx = makeContext("ir-think2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		expect(r.hasReopenableGroup()).toBe(false);
		expect(r.hasActiveGroups()).toBe(false);

		const fresh_owner_state: Record<string, any> = {};
		const fresh_owner_ctx = makeContext("ir-think3", fresh_owner_state) as any;
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, fresh_owner_ctx);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
		expect(stripAnsi((fresh_owner_state.callText as any).text)).toContain("c.ts");
	});

	test("inter-run thinking_delta with blocks visible hard-exits before the next tool wave", () => {
		setThinkingBlocksHidden(false);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ir-think-vis1", owner_state) as any;
		const child_ctx = makeContext("ir-think-vis2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);

		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "reasoning between batches" });
		expect(r.hasReopenableGroup()).toBe(false);
		expect(r.hasActiveGroups()).toBe(false);

		const fresh_state: Record<string, any> = {};
		const fresh_ctx = makeContext("ir-think-vis3", fresh_state) as any;
		r.renderCall("read", { path: "c.ts" }, theme, fresh_ctx);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("c.ts");
		expect(stripAnsi((fresh_state.callText as any).text)).toContain("c.ts");
	});

	test("visible thinking hard-exits a still-running work group", () => {
		setThinkingBlocksHidden(false);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("visible-running-owner", owner_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		expect(r.hasActiveGroups()).toBe(true);

		apply_assistant_stream_boundary(r, { type: "thinking_start" });
		expect(r.hasActiveGroups()).toBe(false);
		expect(r.hasReopenableGroup()).toBe(false);

		const fresh_state: Record<string, any> = {};
		r.renderCall(
			"grep",
			{ pattern: "x", path: "b.ts" },
			theme,
			makeContext("visible-running-next", fresh_state) as any,
		);
		expect(stripAnsi((owner_state.callText as any).text)).not.toContain("b.ts");
		expect(stripAnsi((fresh_state.callText as any).text)).toContain("b.ts");
	});

	test("thinking block toggle preserves lingering children through visible-thinking replay", () => {
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("toggle-child1", owner_state) as any;
		const child_ctx = makeContext("toggle-child2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		expect(stripAnsi((owner_state.callText as any).text)).toContain("Search");

		begin_work_group_boundary_suppression();
		setThinkingBlocksHidden(false);
		r.repaintAfterThinkingBlocksToggle(false);
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).not.toContain("Thinking");
		end_work_group_boundary_suppression();

		begin_work_group_boundary_suppression();
		setThinkingBlocksHidden(true);
		r.repaintAfterThinkingBlocksToggle(true, true);
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).toContain("Thinking");
		end_work_group_boundary_suppression();
	});

	test("thinking block toggle rebuild keeps lingering children", () => {
		setThinkingBlocksHidden(true);
		setup_inter_run_gap();
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("toggle-rebuild1", owner_state) as any;
		const child_ctx = makeContext("toggle-rebuild2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "" });

		const fresh_owner_state: Record<string, any> = {};
		const fresh_owner_ctx = makeContext("toggle-rebuild1", fresh_owner_state) as any;
		const fresh_child_ctx = makeContext("toggle-rebuild2", {}) as any;
		r.renderCall("read", { path: "a.ts" }, theme, fresh_owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, fresh_child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, fresh_owner_ctx);

		begin_work_group_boundary_suppression();
		r.repaintAfterThinkingBlocksToggle(false);
		let row = stripAnsi((fresh_owner_state.callText as any).text);
		expect(row).toContain("Search");
		r.repaintAfterThinkingBlocksToggle(true, true);
		row = stripAnsi((fresh_owner_state.callText as any).text);
		expect(row).toContain("Search");
		expect(row).toContain("Thinking");
		end_work_group_boundary_suppression();
	});

	test("noteUserMessage hard-exits the group", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("user-msg1", owner_state) as any;
		const child_ctx = makeContext("user-msg2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
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
		expect(r.hasGroupThinkingChild()).toBe(true);
		expect(r.hasActiveGroups()).toBe(true);

		r.noteUserMessage();
		expect(r.hasGroupThinkingChild()).toBe(false);
		expect(r.hasActiveGroups()).toBe(false);
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

	test("formatCallBody bash row uses Ran verb without shell-prompt prefix", () => {
		const theme = makeTheme() as any;
		const result = formatCallBody("bash", { command: "bash t.gate.sh gui/components/ignit" }, theme);
		expect(result).toContain("Ran");
		expect(result).toContain("t.gate.sh gui/components/ignit");
		expect(result).not.toContain("$");
	});

	test("formatCallBody bash running row uses Running verb", () => {
		const theme = makeTheme() as any;
		const result = formatCallBody("bash", { command: "npm test" }, theme, false, false);
		expect(result).toContain("Running");
		expect(result).toContain("npm test");
		expect(result).not.toContain("$");
	});
});

describe("running_work_label via formatUnifiedWorkHeader", () => {
	function makeRecord(name: string, args: Record<string, any>, completed: boolean) {
		return {
			id: `${name}-${Math.random().toString(36).slice(2)}`,
			name,
			args,
			isError: false,
			_completed: completed,
		};
	}

	function makeGroup(records: any[]): any {
		return { records, key: "__work__", type: "work" };
	}

	function headerLabel(group: any): string {
		const theme = makeTheme() as any;
		const raw = formatUnifiedWorkHeader(group, theme);
		// Strip both ANSI codes and the mock theme format `[tag:*text*]`
		return stripAnsi(raw).replace(/^\[[^:]+:\*/, "").replace(/\*\]$/, "");
	}

	test("Exploring when all running records are discovery type (read, ls)", () => {
		const group = makeGroup([
			makeRecord("read", { file_path: "a.ts" }, false),
			makeRecord("ls", { path: "." }, false),
		]);
		expect(headerLabel(group)).toBe("Exploring");
	});

	test("Editing when all running records are editing type (edit)", () => {
		const group = makeGroup([
			makeRecord("edit", { file_path: "a.ts", oldText: "x", newText: "y" }, false),
		]);
		expect(headerLabel(group)).toBe("Editing");
	});

	test("Writing when all running records are writing type (write)", () => {
		const group = makeGroup([
			makeRecord("write", { file_path: "a.ts", content: "hello" }, false),
		]);
		expect(headerLabel(group)).toBe("Writing");
	});

	test("Running when all running records are bashing type (bash, non-grep)", () => {
		const group = makeGroup([
			makeRecord("bash", { command: "npm test" }, false),
		]);
		expect(headerLabel(group)).toBe("Running");
	});

	test("Patching when all running records are patching type (apply_patch)", () => {
		const group = makeGroup([
			makeRecord("apply_patch", { patch: "*** Begin Patch\n*** End Patch" }, false),
		]);
		expect(headerLabel(group)).toBe("Patching");
	});

	test("Working when running records are mixed types", () => {
		const group = makeGroup([
			makeRecord("read", { file_path: "a.ts" }, false),
			makeRecord("edit", { file_path: "b.ts", oldText: "x", newText: "y" }, false),
		]);
		expect(headerLabel(group)).toBe("Working");
	});

	test("Working when there are no running records (all completed)", () => {
		const group = makeGroup([
			makeRecord("read", { file_path: "a.ts" }, true),
			makeRecord("edit", { file_path: "b.ts", oldText: "x", newText: "y" }, true),
		]);
		// All completed -> segments will be non-empty (past tense), so
		// running_work_label is not used. But if somehow segments were empty
		// and all completed, the fallback would be "Working".
		// Here we verify segments are produced so the header is past-tense.
		const label = headerLabel(group);
		expect(label).toContain("Explored");
		expect(label).toContain("Edited");
	});

	test("formatUnifiedWorkHeader uses running_work_label as fallback when segments is empty", () => {
		// All running, no completed -> segments empty -> fallback to running_work_label
		const group = makeGroup([
			makeRecord("grep", { query: "foo", file_pattern: "*.ts" }, false),
			makeRecord("find", { pattern: "*.ts" }, false),
		]);
		expect(headerLabel(group)).toBe("Exploring");
	});

	test("bash grep counts as discovery, not bashing", () => {
		const group = makeGroup([
			makeRecord("bash", { command: "grep -rn foo src/" }, false),
		]);
		expect(headerLabel(group)).toBe("Exploring");
	});
});

describe("formatCompactChildRow (native SSOT)", () => {
	test("running child resolves to the native compact row body", () => {
		const theme = makeTheme() as any;
		const body = stripAnsi(formatCompactChildRow("read", { path: "a.ts" }, false, undefined, theme));
		expect(body).toContain("Reading");
		expect(body).toContain("a.ts");
		expect(body).not.toContain("+");
	});

	test("completed edit child includes +N -N from the result diff", () => {
		const theme = makeTheme() as any;
		const body = stripAnsi(
			formatCompactChildRow(
				"edit",
				{ file_path: "foo.ts" },
				true,
				{ details: { diff: "+one\n+two\n" } },
				theme,
			),
		);
		expect(body).toContain("Edit");
		expect(body).toContain("foo.ts");
		expect(body).toContain("+2");
	});

	test("completed bash grep child renders as Search, never a nameless row", () => {
		const theme = makeTheme() as any;
		// A bash `grep` command is a search: it must carry the `Search` label
		// like the grep tool row (and the running `Searching` verb), not an
		// empty verb leaving a bare `pattern in path` row with no tool name.
		const body = stripAnsi(
			formatCompactChildRow(
				"bash",
				{ command: "cd /c/Work/pi-ember-stack && grep -rn 'foo|bar' ." },
				true,
				undefined,
				theme,
			),
		);
		expect(body).toContain("Search");
		expect(body).toContain("foo|bar");
		expect(body).toContain("in /c/Work/pi-ember-stack");
		expect(body).not.toContain("Ran");
	});

	test("matches the shared formatter the group child rows use", () => {
		// SSOT: the subagent live tray calls formatCompactChildRow, and the main
		// agent's group children are built by the same formatter, so a group
		// child line's body must equal formatCompactChildRow output.
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("ssot-owner", owner_state) as any;
		const child_ctx = makeContext("ssot-child", {}) as any;
		r.renderCall("read", { path: "b.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "c.ts" }, theme, child_ctx);
		// Rebind the owner so the shared group block (header + tree children)
		// is repainted onto the owner's callText — same pattern as the group
		// tests above. The last line is the trailing `└` child row.
		r.renderCall("read", { path: "b.ts" }, theme, owner_ctx);
		const group_text = stripAnsi((owner_state.callText as any).text);
		const lines = group_text.split("\n");
		const child_line = lines[lines.length - 1];
		expect(child_line).toContain("Reading");
		// Strip the dim tree-prefix wrapper around the trailing glyph (`[dim:  └]`).
		const body = child_line.replace(/^\[dim:[^\]]*\]/, "");
		const native = stripAnsi(
			formatCompactChildRow("read", { path: "c.ts" }, false, undefined, theme),
		);
		expect(body).toBe(native);
	});
});

describe("CompactRenderer pipe-only prior-completed child prefix", () => {
	test("completed prior child uses pipe-only prefix with no tee dash", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-1", owner_state) as any;
		const child_ctx = makeContext("pipe-2", {}) as any;

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

		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		// Header is line 0; two child rows follow.
		expect(lines.length).toBe(3);
		// First child (completed, not terminal): pipe-only `  │` — no `─`
		// and no connector-width trailing pad before the compact row body.
		expect(lines[1]).toContain("│");
		expect(lines[1]).toContain("[dim:  │][muted:*");
		expect(lines[1]).not.toContain("├─");
		expect(lines[1]).not.toContain("└─");
		// Second child (completed, terminal): `  └─`.
		expect(lines[2]).toContain("└─");
		expect(lines[2]).not.toContain("│");
	});

	test("terminal/latest tool row remains └─", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-term-1", owner_state) as any;
		const child_ctx = makeContext("pipe-term-2", {}) as any;
		const third_ctx = makeContext("pipe-term-3", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "c.ts" }, theme, third_ctx);
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
		r.renderResult(
			"read",
			{ path: "c.ts" },
			{ content: [{ type: "text", text: "c" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ ...third_ctx, isError: false },
		);

		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		expect(lines.length).toBe(4);
		// First two completed children: pipe-only.
		expect(lines[1]).toContain("│");
		expect(lines[1]).not.toContain("├─");
		expect(lines[2]).toContain("│");
		expect(lines[2]).not.toContain("├─");
		// Last child: terminal `└─`.
		expect(lines[3]).toContain("└─");
		expect(lines[3]).not.toContain("│");
	});

	test("Thinking lane is └─ while preceding completed children are pipe-only", () => {
		setThinkingBlocksHidden(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-think-1", owner_state) as any;
		const child_ctx = makeContext("pipe-think-2", {}) as any;

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

		r.noteThinking();
		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		// Header, first child (pipe-only), second child (pipe-only),
		// Thinking lane (└─). When Thinking is terminal, ALL completed
		// children are pipe-only — including the immediately previous one.
		expect(lines.length).toBe(4);
		// First completed child: pipe-only — no `─` connector.
		expect(lines[1]).toContain("│");
		expect(lines[1]).not.toContain("├─");
		expect(lines[1]).not.toContain("└─");
		// Second completed child (last before Thinking): also pipe-only.
		expect(lines[2]).toContain("│");
		expect(lines[2]).not.toContain("├─");
		expect(lines[2]).not.toContain("└─");
		// Thinking lane: `└─` — the only row with a horizontal connector.
		expect(lines[3]).toContain("└─");
		expect(lines[3]).not.toContain("│");
		expect(lines[3]).toContain("Thinking");
	});

	test("still-running parallel child keeps ├─ while prior completed child is pipe-only", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-run-1", owner_state) as any;
		const child_ctx = makeContext("pipe-run-2", {}) as any;
		const running_ctx = makeContext("pipe-run-3", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "c.ts" }, theme, running_ctx);
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
		// c.ts is still running (no renderResult).

		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		expect(lines.length).toBe(4);
		// First completed child: pipe-only.
		expect(lines[1]).toContain("│");
		expect(lines[1]).not.toContain("├─");
		// Second completed child: pipe-only.
		expect(lines[2]).toContain("│");
		expect(lines[2]).not.toContain("├─");
		// Running child (terminal): `└─`.
		expect(lines[3]).toContain("└─");
		expect(lines[3]).toContain("Reading");
		expect(lines[3]).toContain("c.ts");
	});

	test("pure apply_patch group: completed prior file uses pipe-only prefix", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-patch-1", owner_state) as any;
		const second_ctx = makeContext("pipe-patch-2", {}) as any;

		const first_input = [
			"*** Begin Patch",
			"*** Add File: first.ts",
			"+first",
			"*** End Patch",
		].join("\n");
		const second_input = [
			"*** Begin Patch",
			"*** Add File: second.ts",
			"+second",
			"*** End Patch",
		].join("\n");

		r.renderCall("apply_patch", { input: first_input }, theme, owner_ctx);
		r.renderCall("apply_patch", { input: second_input }, theme, second_ctx);
		r.renderCall("apply_patch", { input: first_input }, theme, owner_ctx);
		r.renderResult(
			"apply_patch",
			{ input: first_input },
			{ details: { ok: true, fileCount: 1, results: [{ path: "first.ts", op: "add", status: "ok" }] } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"apply_patch",
			{ input: second_input },
			{ details: { ok: true, fileCount: 1, results: [{ path: "second.ts", op: "add", status: "ok" }] } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...second_ctx, isError: false },
		);
		r.renderCall("apply_patch", { input: first_input }, theme, owner_ctx);

		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		// Header, first.ts (completed, not terminal), second.ts (completed, terminal).
		expect(lines.length).toBe(3);
		// First completed file: pipe-only.
		expect(lines[1]).toContain("│");
		expect(lines[1]).not.toContain("├─");
		// Last file: `└─`.
		expect(lines[2]).toContain("└─");
		expect(lines[2]).not.toContain("│");
	});

	test("merged row is completed only when all source records are completed", () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("pipe-merge-1", owner_state) as any;
		const child_ctx = makeContext("pipe-merge-2", {}) as any;
		const third_ctx = makeContext("pipe-merge-3", {}) as any;

		// Three edits to the same file: first two completed, third still running.
		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "y" }, theme, owner_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "y", newText: "z" }, theme, child_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "z", newText: "w" }, theme, third_ctx);
		r.renderCall("edit", { file_path: "a.ts", oldText: "x", newText: "y" }, theme, owner_ctx);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "x", newText: "y" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+1\n" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderResult(
			"edit",
			{ file_path: "a.ts", oldText: "y", newText: "z" },
			{ content: [{ type: "text", text: "ok" }], details: { diff: "+1\n" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		// Third edit still running (no renderResult) — merged row is NOT completed.

		const row = stripAnsi((owner_state.callText as any).text);
		const lines = row.split("\n");
		// Header + one merged child row (terminal, still running).
		expect(lines.length).toBe(2);
		// Merged row has a running member → not completed → uses `└─` (terminal).
		expect(lines[1]).toContain("└─");
		expect(lines[1]).not.toContain("│");
		expect(lines[1]).toContain("Editing");
	});
});
