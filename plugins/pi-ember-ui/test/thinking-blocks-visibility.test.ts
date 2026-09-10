import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apply_assistant_stream_boundary } from "../assistant-stream-boundary.ts";
import { shutdown_gradient_clock } from "../gradient.ts";
import { apply_thinking_blocks_hidden } from "../index.ts";
import {
	resetToolExecutionInFlight,
	setAgentRunPending,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	setThinkingBlocksHidden,
	setToolGroupActive,
	setTurnToolTranscriptActive,
	setUserTurnCommitted,
} from "../mode-colors.ts";
import { bind_render_intent, reset_render_intent } from "../render-intent.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function make_theme(): { fg: (t: string, s: string) => string; bold: (s: string) => string } {
	return { fg: (t: string, s: string) => `[${t}:${s}]`, bold: (s: string) => s };
}

function make_context(
	id: string,
	state: Record<string, unknown>,
): { args: Record<string, never>; toolCallId: string; invalidate: () => void; state: Record<string, unknown> } {
	return { args: {}, toolCallId: id, invalidate: () => {}, state };
}

/** Drain the handler's two deferred microtasks (paint pass + suppression release). */
async function flush_visibility_transition(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

function render_read(
	renderer: ReturnType<typeof getSharedRenderer>,
	context: ReturnType<typeof make_context>,
	path: string,
	theme: ReturnType<typeof make_theme>,
) {
	renderer.renderCall("read", { path }, theme as never, context as never);
	renderer.renderResult(
		"read",
		{ path },
		{ content: [{ type: "text", text: "a" }], details: { totalMatched: 1 } },
		{ expanded: false, isPartial: false },
		theme as never,
		{ ...context, isError: false } as never,
	);
}

function render_grep(
	renderer: ReturnType<typeof getSharedRenderer>,
	context: ReturnType<typeof make_context>,
	pattern: string,
	path: string,
	theme: ReturnType<typeof make_theme>,
) {
	renderer.renderCall("grep", { pattern, path }, theme as never, context as never);
	renderer.renderResult(
		"grep",
		{ pattern, path },
		{ content: [{ type: "text", text: "hit" }], details: { totalMatched: 1 } },
		{ expanded: false, isPartial: false },
		theme as never,
		{ ...context, isError: false } as never,
	);
}

/** The component Pi renders for a call — renderCall's return value. */
function render_call_component(
	renderer: ReturnType<typeof getSharedRenderer>,
	name: string,
	args: Record<string, unknown>,
	context: ReturnType<typeof make_context>,
	theme: ReturnType<typeof make_theme>,
) {
	return renderer.renderCall(name, args, theme as never, context as never);
}

beforeEach(() => {
	bind_render_intent(() => {});
	setAgentRunPending(true);
	setUserTurnCommitted(true);
	setTurnToolTranscriptActive(true);
	resetToolExecutionInFlight();
});

afterEach(async () => {
	// Drain any pending transition microtask (paint pass + suppression release)
	// before resetting shared flags.
	await flush_visibility_transition();
	setThinkingBlocksHidden(false);
	setAgentRunPending(false);
	setTurnToolTranscriptActive(false);
	setUserTurnCommitted(false);
	resetToolExecutionInFlight();
	reset_render_intent();
	shutdown_gradient_clock();
	setToolGroupActive(false);
	setGroupThinkingChildActive(false);
	setGroupReopenableActive(false);
	getSharedRenderer().resetForSession();
});

describe("thinking blocks visibility transition", () => {
	test("both assistant-message seams observe the transition", () => {
		const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
		// Ctrl+T rebuild replay (fresh component constructor -> updateContent)
		// and the live streaming component / settings selector.
		const seam_calls = source.match(/apply_thinking_blocks_hidden\(hide === true\)/g) ?? [];
		expect(seam_calls).toHaveLength(2);
	});

	test("Ctrl+T after the turn settled folds waves split only by reasoning", async () => {
		setThinkingBlocksHidden(false);
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = make_theme();

		// Live turn with thinking blocks VISIBLE: wave A (read + grep), visible
		// reasoning, then wave B (grep) which starts its own group.
		render_read(renderer, make_context("call-a", {}), "a.ts", theme);
		render_grep(renderer, make_context("call-b", {}), "x", "b.ts", theme);
		renderer.settleAllGroups();
		apply_assistant_stream_boundary(renderer, {
			type: "thinking_delta",
			delta: "reasoning between tool waves",
		});
		render_grep(renderer, make_context("call-c", {}), "y", "c.ts", theme);

		// Ctrl+T with nothing streaming: Pi flips `hideThinkingBlock`, clears the
		// chat, and replays the branch. The flag flips while the first replayed
		// assistant message is constructed — before this turn's tool components
		// replay — so the structural merge must land before the replay.
		apply_thinking_blocks_hidden(true);

		const a_state: Record<string, unknown> = {};
		const b_state: Record<string, unknown> = {};
		const c_state: Record<string, unknown> = {};
		const a_ctx = make_context("call-a", a_state);
		const b_ctx = make_context("call-b", b_state);
		const c_ctx = make_context("call-c", c_state);
		render_read(renderer, a_ctx, "a.ts", theme);
		render_grep(renderer, b_ctx, "x", "b.ts", theme);
		const absorbed = render_call_component(renderer, "grep", { pattern: "y", path: "c.ts" }, c_ctx, theme);
		await flush_visibility_transition();

		// Exactly one compact work group absorbs both waves, matching what the
		// transcript would have looked like if blocks had been hidden all along.
		const header = stripAnsi((a_state.callText as { text: string }).text);
		expect((header.match(/Explored/gi) ?? [])).toHaveLength(1);
		expect(header).toContain("c.ts");
		// The absorbed wave renders zero rows — no stale standalone row beside
		// the merged block.
		expect(absorbed.render(80).join("").trim()).toBe("");
		expect(c_state.callText).toBeUndefined();
	});

	test("switching back to visible drops the in-group Thinking lane", async () => {
		apply_thinking_blocks_hidden(true);
		await flush_visibility_transition();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const theme = make_theme();
		render_read(renderer, make_context("t-a", {}), "a.ts", theme);
		render_grep(renderer, make_context("t-b", {}), "x", "b.ts", theme);
		renderer.settleAllGroups();
		// Hidden reasoning owns the in-group `└ Thinking` lane.
		apply_assistant_stream_boundary(renderer, {
			type: "thinking_delta",
			delta: "hidden reasoning between tool waves",
		});
		expect(renderer.hasAnyGroupThinkingChild()).toBe(true);

		apply_thinking_blocks_hidden(false);
		await flush_visibility_transition();

		expect(renderer.hasAnyGroupThinkingChild()).toBe(false);
	});
});
