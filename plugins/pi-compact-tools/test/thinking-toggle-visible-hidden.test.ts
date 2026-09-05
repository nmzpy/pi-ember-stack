import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CompactRenderer } from "../renderer.ts";
import { apply_assistant_stream_boundary } from "../../pi-ember-ui/assistant-stream-boundary.ts";
import {
	begin_work_group_boundary_suppression,
	end_work_group_boundary_suppression,
	resetToolExecutionInFlight,
	setAgentRunPending,
	setThinkingBlocksHidden,
	setTurnToolTranscriptActive,
	setUserTurnCommitted,
} from "../../pi-ember-ui/mode-colors.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme(): { fg: (t: string, s: string) => string; bold: (s: string) => string } {
	return { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
}

function makeContext(
	id: string,
	state: Record<string, unknown>,
): {
	args: Record<string, never>;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
} {
	return { args: {}, toolCallId: id, invalidate: () => {}, state };
}

beforeEach(() => {
	setAgentRunPending(true);
	setUserTurnCommitted(true);
	setTurnToolTranscriptActive(true);
	resetToolExecutionInFlight();
});

afterEach(() => {
	setAgentRunPending(false);
	setTurnToolTranscriptActive(false);
	setUserTurnCommitted(false);
	resetToolExecutionInFlight();
	setThinkingBlocksHidden(false);
});

function settle_discovery_pair(
	r: CompactRenderer,
	theme: any,
	owner_ctx: any,
	child_ctx: any,
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
		{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
		{ expanded: false, isPartial: false },
		theme,
		{ ...child_ctx, isError: false },
	);
	r.settleAllGroups();
}

describe("visible-to-hidden thinking toggle", () => {
	test("non-empty visible thinking hard-exits; toggle hidden reopens same group for next tool", () => {
		setThinkingBlocksHidden(false);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const child_state: Record<string, any> = {};
		const c_state: Record<string, any> = {};
		const owner_ctx = makeContext("s1", owner_state) as any;
		const child_ctx = makeContext("s2", child_state) as any;
		const c_ctx = makeContext("s3", c_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		expect(r.hasReopenableGroup()).toBe(true);

		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "reasoning between tool waves" });
		expect(r.hasReopenableGroup()).toBe(false);

		begin_work_group_boundary_suppression();
		setThinkingBlocksHidden(true);
		r.repaintAfterThinkingBlocksToggle(true, true);
		end_work_group_boundary_suppression();

		// The prior group is reopened. A real thinking stream is active, so the lane is armed.
		expect(r.hasReopenableGroup()).toBe(true);

		r.announceToolCall();
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, c_ctx);
		// Force the anchor owner to re-render (simulates the real invalidate -> requestRender path).
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("c.ts");
		expect((row.match(/Explored/gi) ?? [])).toHaveLength(1);
		expect(row.toLowerCase()).not.toMatch(/explored[\s\S]*explored/i);
	});

	test("non-empty visible thinking hard-exits; next tool creates new group; toggle hidden merges groups", () => {
		setThinkingBlocksHidden(false);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const child_state: Record<string, any> = {};
		const c_state: Record<string, any> = {};
		const owner_ctx = makeContext("m1", owner_state) as any;
		const child_ctx = makeContext("m2", child_state) as any;
		const c_ctx = makeContext("m3", c_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderResult(
			"read",
			{ path: "a.ts" },
			{ content: [{ type: "text", text: "a" }], details: { totalMatched: 2 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...owner_ctx, isError: false },
		);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderResult(
			"grep",
			{ pattern: "x", path: "b.ts" },
			{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...child_ctx, isError: false },
		);
		r.settleAllGroups();
		expect(r.hasReopenableGroup()).toBe(true);

		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "reasoning between tool waves" });
		expect(r.hasReopenableGroup()).toBe(false);

		// The model emits another tool BEFORE the user toggles. With visible blocks
		// this starts a new group below the visible thinking block.
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, c_ctx);
		r.renderResult(
			"grep",
			{ pattern: "y", path: "c.ts" },
			{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...c_ctx, isError: false },
		);

		// At this point there are two groups (hard-exited old + new). Verify.
		let row = stripAnsi((c_state.callText as any).text);
		expect(row).toContain("c.ts");
		expect((row.match(/Explored/gi) ?? [])).toHaveLength(0); // new group is still standalone

		begin_work_group_boundary_suppression();
		setThinkingBlocksHidden(true);
		// No live thinking stream at toggle time, so use restore_thinking_lane=false
		// to keep the latest tool child visible.
		r.repaintAfterThinkingBlocksToggle(true, false);
		end_work_group_boundary_suppression();

		expect(r.hasReopenableGroup()).toBe(true);

		// Force the anchor owner to re-render so the group text is fresh.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);

		row = stripAnsi((owner_state.callText as any).text);
		// After the toggle, the two groups should merge into one compact work bundle.
		expect(row).toContain("c.ts");
		expect((row.match(/Explored/gi) ?? [])).toHaveLength(1);
		expect(row.toLowerCase()).not.toMatch(/explored[\s\S]*explored/i);
	});

	test("visible thinking followed by visible text keeps groups split on hidden toggle", () => {
		setThinkingBlocksHidden(false);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const child_state: Record<string, any> = {};
		const c_state: Record<string, any> = {};
		const owner_ctx = makeContext("text1", owner_state) as any;
		const child_ctx = makeContext("text2", child_state) as any;
		const c_ctx = makeContext("text3", c_state) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		settle_discovery_pair(r, theme, owner_ctx, child_ctx);
		expect(r.hasReopenableGroup()).toBe(true);

		// Visible thinking hard-exits.
		apply_assistant_stream_boundary(r, { type: "thinking_delta", delta: "reasoning between tool waves" });
		expect(r.hasReopenableGroup()).toBe(false);

		// Then visible text appears before the next tool. This must prevent the
		// previous tool group from merging with the next one on a hidden toggle.
		apply_assistant_stream_boundary(r, { type: "text_delta", delta: "Some visible narration" });

		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, c_ctx);
		r.renderResult(
			"grep",
			{ pattern: "y", path: "c.ts" },
			{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...c_ctx, isError: false },
		);

		begin_work_group_boundary_suppression();
		setThinkingBlocksHidden(true);
		r.repaintAfterThinkingBlocksToggle(true, false);
		end_work_group_boundary_suppression();

		// Force the old owner to re-render.
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("grep", { pattern: "y", path: "c.ts" }, theme, c_ctx);
		
		const oldRow = stripAnsi((owner_state.callText as any).text);
		const newRow = stripAnsi((c_state.callText as any).text);
		// The new tool should NOT fold into the prior group because visible text came
		// between the visible thinking and the tool wave.
		expect(oldRow).not.toContain("c.ts");
		expect(newRow).toContain("c.ts");
		// The old group header should not absorb the new file.
		expect(oldRow).not.toContain("c.ts");
		expect(newRow).toContain("c.ts");
		expect(newRow).toContain("Search");
		expect(oldRow).toContain("Explored 1 file, 1 search");
	});
});
