import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { build_subagent_settings, load_subagent_extensions } from "../runner.ts";

/** Minimal assistant message shape accepted by pi-ai's canonical overflow utility. */
function overflowAssistantMessage(errorMessage: string) {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage,
	} as Parameters<typeof isContextOverflow>[0];
}

describe("subagent session settings", () => {
	test("build_subagent_settings enables auto-compaction and disables retry", () => {
		const settings = build_subagent_settings();
		expect(settings.compaction?.enabled).toBe(true);
		expect(settings.retry?.enabled).toBe(false);
	});

	test("child session extension set wires the real session_before_compact compaction hook", async () => {
		// Load the actual extension set every subagent child session receives
		// (task-list tool + Ember compaction wiring) through the runner's own
		// loading seam, then prove the compaction-wiring extension really
		// registers a session_before_compact handler. This is what makes native
		// reason=overflow compaction use Ember's structured stack summary.
		const tmp = mkdtempSync(join(tmpdir(), "pi-ember-wiring-"));
		const result = await load_subagent_extensions(tmp);
		expect(result.errors).toEqual([]);

		const wiring = result.extensions.find((extension) =>
			extension.path.replace(/\\/g, "/").endsWith("pi-custom-agents/compaction-wiring.ts"),
		);
		expect(wiring).toBeDefined();
		expect(wiring?.handlers.has("session_before_compact")).toBe(true);

		const todo = result.extensions.find((extension) =>
			extension.path.replace(/\\/g, "/").endsWith("pi-ember-todo/index.ts"),
		);
		expect(todo).toBeDefined();
		expect(todo?.tools.has("todo")).toBe(true);
	});

	test("compaction-enabled settings open Pi's native overflow recovery gate", () => {
		// AgentSession._checkCompaction returns early when compaction is disabled,
		// so the exact Codex overflow form never reaches native recovery. The
		// runner's only lever is the settings it hands to the child session.
		const settings = build_subagent_settings();
		expect(settings.compaction?.enabled).toBe(true);
	});
});

describe("context-overflow ownership: Pi AgentSession is the sole recovery owner", () => {
	test("pi-ai canonical isContextOverflow detects the exact Codex resolved overflow form", () => {
		// Codex emits overflow as a *resolved* assistant message (stopReason "error",
		// errorMessage "Codex error: Your input exceeds the context window..."), not
		// as a thrown prompt error. Native _checkCompaction classifies this exact
		// form via pi-ai's isContextOverflow and, with compaction enabled, runs
		// overflow compaction plus one bounded retry inside session.prompt().
		expect(
			isContextOverflow(
				overflowAssistantMessage(
					"Codex error: Your input exceeds the context window of this model",
				),
				128_000,
			),
		).toBe(true);
		expect(isContextOverflow(overflowAssistantMessage("prompt is too long: 213462 tokens > 200000 maximum"), 128_000)).toBe(
			true,
		);
	});

	test("non-overflow errors are never classified as overflow (no manual compact/retry)", () => {
		// 401/429/503/billing errors must not be treated as context overflow, so
		// neither native recovery nor any runner path compacts or retries them.
		for (const msg of [
			"401 Unauthorized: invalid api key",
			"429 rate limit exceeded",
			"503 Service Unavailable",
			"billing: insufficient credits",
			"Throttling error: Too many tokens, please wait before trying again.",
			"500 status code (no body)",
		]) {
			expect(isContextOverflow(overflowAssistantMessage(msg), 128_000)).toBe(false);
		}
	});

	test("generic retry stays disabled so unrelated provider failures are not re-prompted", () => {
		expect(build_subagent_settings().retry?.enabled).toBe(false);
	});

	test("the runner no longer owns a duplicate overflow classifier", async () => {
		// Regression: the previous runner-local catch recovery re-classified
		// overflow messages with its own pattern list and re-prompted the task.
		// With native ownership, the runner must not export a competing classifier.
		const runner = (await import("../runner.ts")) as Record<string, unknown>;
		expect(runner.is_context_overflow_error).toBeUndefined();
		expect(runner.CONTEXT_OVERFLOW_PATTERNS).toBeUndefined();
	});
});
