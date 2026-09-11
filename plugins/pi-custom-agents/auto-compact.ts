/**
 * Ember auto-compaction ceiling — one absolute context-token threshold shared by
 * the parent session, subagents, and fleet conversations.
 *
 * Pi's own auto-compaction is purely relative: it fires when
 * `contextTokens > contextWindow - reserveTokens`, so a 1M-token model would grow
 * to ~983k before anything is summarized. Ember compacts at
 * AUTO_COMPACT_CONTEXT_TOKENS instead, which bounds summary cost and keeps every
 * session in the same working range no matter how large the model's window is.
 *
 * Two delivery mechanisms, one constant:
 *
 * - Child sessions (subagent runner, fleet factory) build their own in-memory
 *   `SettingsManager`, so `auto_compact_reserve_tokens()` converts the child
 *   model's window into the `reserveTokens` that lands Pi's NATIVE threshold on
 *   the ceiling. Compaction then runs inside `session.prompt()` and Pi continues
 *   the turn itself — nothing is aborted and the task is never re-prompted.
 * - The parent session's settings belong to Pi, and its only public trigger
 *   (`ctx.compact()`) aborts the current agent operation and never continues the
 *   interrupted turn. Ember therefore watches `ctx.getContextUsage()` and
 *   compacts BETWEEN turns; during a run, Pi's native threshold stays the safety
 *   net.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { isAgentRunPending, isPlanAutoContinuing, isQuizActive } from "../pi-ember-ui/mode-colors.ts";

/** Absolute context-token ceiling at which Ember compacts a session. */
export const AUTO_COMPACT_CONTEXT_TOKENS = 300_000;

/**
 * `compaction.reserveTokens` that lands Pi's native threshold
 * (`contextTokens > contextWindow - reserveTokens`) exactly on the Ember ceiling
 * for a given model window.
 *
 * Windows at or below the ceiling keep Pi's OWN default reserve: the ceiling is
 * unreachable there, so Pi's threshold governs and Ember must never shrink the
 * room Pi leaves for the response.
 */
export function auto_compact_reserve_tokens(context_window: number | undefined): number {
	const pi_default_reserve = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	if (!context_window || context_window <= 0) return pi_default_reserve;
	return Math.max(context_window - AUTO_COMPACT_CONTEXT_TOKENS, pi_default_reserve);
}

/** True when reported context tokens have reached the Ember ceiling. */
export function should_auto_compact(tokens: number | null | undefined): boolean {
	return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= AUTO_COMPACT_CONTEXT_TOKENS;
}

/**
 * One compaction may be in flight at a time. Cleared by the compact callbacks
 * (Pi always invokes exactly one of them), by Pi's `session_compact` event, and on
 * session shutdown.
 */
let compact_in_flight = false;
let pending_check: ReturnType<typeof setTimeout> | undefined;

function clear_pending_check(): void {
	if (pending_check === undefined) return;
	clearTimeout(pending_check);
	pending_check = undefined;
}

/**
 * Defer the ceiling check to the next macrotask.
 *
 * `agent_settled` handlers run in registration order and the Plan Review and
 * loop-recovery quiz open inside them. A compaction started in that same tick
 * would rebuild the transcript under an overlay that is still mounting, so the
 * check runs after every handler has finished and reads the live overlay flags.
 */
export function maybe_auto_compact(ctx: ExtensionContext): void {
	clear_pending_check();
	pending_check = setTimeout(() => {
		pending_check = undefined;
		compact_at_ceiling(ctx);
	}, 0);
}

/**
 * Ceiling check: needs a settled, idle session that no overlay owns.
 *
 * Skipped while output-limit recovery is running (`isPlanAutoContinuing`) or an
 * agent run is still pending — `ctx.compact()` aborts a running operation, so a
 * turn must never look idle while its continuation is already queued.
 *
 * `ctx.isIdle()` is Pi's `!agentRunActive && !isCompacting`, so a manual `/compact`
 * already in flight also blocks this check: starting a second compaction would
 * call `abort()` and cancel the user's run.
 */
function compact_at_ceiling(ctx: ExtensionContext): void {
	if (compact_in_flight) return;
	if (isQuizActive() || isPlanAutoContinuing() || isAgentRunPending()) return;
	try {
		// Print/JSON runs tear the session down as soon as the run settles: there is
		// no next turn to compact for, and a summarization call would only delay exit.
		if (!ctx.hasUI) return;
		if (!ctx.isIdle()) return;
		if (!should_auto_compact(ctx.getContextUsage()?.tokens)) return;
		compact_in_flight = true;
		ctx.compact({
			onComplete: () => {
				compact_in_flight = false;
			},
			onError: () => {
				compact_in_flight = false;
			},
		});
	} catch {
		// Session replaced between the settle event and this deferred check: the
		// live ctx is gone, and the replacement session's own settle re-arms it.
		compact_in_flight = false;
	}
}

/** Wire the parent session's ceiling check into Pi's lifecycle events. */
export function install_auto_compact(pi: ExtensionAPI): void {
	pi.on("agent_settled", (_event, ctx) => {
		maybe_auto_compact(ctx);
	});
	pi.on("session_compact", () => {
		compact_in_flight = false;
	});
	pi.on("session_shutdown", () => {
		compact_in_flight = false;
		clear_pending_check();
	});
}
