import { afterEach, describe, expect, test } from "bun:test";
import { CompactRenderer } from "../renderer.ts";
import {
	isThinkingBlocksHidden,
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

afterEach(() => {
	setAgentRunPending(false);
	setTurnToolTranscriptActive(false);
	setUserTurnCommitted(false);
	resetToolExecutionInFlight();
	setThinkingBlocksHidden(false);
});

describe("scratch: real event sequence", () => {
	test("toolcall_start gap leaves in-group Thinking lane armed", async () => {
		setThinkingBlocksHidden(true);
		setAgentRunPending(true);
		setUserTurnCommitted(true);
		setTurnToolTranscriptActive(true);
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("s1", owner_state) as any;
		const child_ctx = makeContext("s2", {}) as any;

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
		r.armInGroupThinking();
		let row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Thinking");
		expect(r.hasGroupThinkingChild()).toBe(true);

		// Model announces the next tool call (message_update toolcall_start).
		// The in-group lane must disappear immediately — it currently lingers
		// until tool_call fires after args finish streaming.
		r.announceToolCall?.();
		row = stripAnsi((owner_state.callText as any).text);
		expect(r.hasGroupThinkingChild()).toBe(false);
		expect(row).not.toContain("Thinking");

		// New tool joins the same work group — one header, not a second bullet row.
		r.renderCall("grep", { pattern: "x", path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		row = stripAnsi((owner_state.callText as any).text);
		expect(row).toContain("Searching");
		expect(row).not.toMatch(/Explored[\s\S]*Explored/);
		expect(row.toLowerCase()).toContain("explored");
	});

	test("two groupable tool calls without text join one group", async () => {
		const r = new CompactRenderer();
		const theme = makeTheme() as any;
		const owner_state: Record<string, any> = {};
		const owner_ctx = makeContext("g1", owner_state) as any;
		const child_ctx = makeContext("g2", {}) as any;

		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		r.renderCall("read", { path: "b.ts" }, theme, child_ctx);
		r.renderCall("read", { path: "a.ts" }, theme, owner_ctx);
		const row = stripAnsi((owner_state.callText as any).text);
		// One unified header (single bullet); both reads are child rows with
		// their own running verbs under the same header, never a second bullet.
		expect(row).toContain("Reading");
		expect(row).toContain("b.ts");
		expect((row.match(/•/g) ?? [])).toHaveLength(1);
	});
});
