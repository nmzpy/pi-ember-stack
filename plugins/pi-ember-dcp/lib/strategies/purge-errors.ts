/**
 * Purge errored tool inputs.
 *
 * When a tool call returns isError=true we keep the error message but strip
 * the tool *arguments* from the matching assistant message once the failure
 * is N turns old. The arguments are replaced with a single-key marker object.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	PURGE_ARGS_MARKER,
	approx_tokens,
	canonical_json,
	is_assistant,
	is_tool_call,
	is_tool_result,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface PurgeResult {
	purgedCount: number;
	tokensSaved: number;
}

export function apply_purge_errors(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protected_by_turn: Set<string> = new Set(),
): PurgeResult {
	const cfg = config.strategies.purgeErrors;
	if (!cfg.enabled) return { purgedCount: 0, tokensSaved: 0 };

	const protected_tools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...cfg.protectedTools,
		...config.compress.protectedTools,
	]);

	// Find errored tool-call ids and record the turnIndex of first observation.
	const errored_call_ids = new Set<string>();
	for (const m of messages) {
		if (!is_tool_result(m)) continue;
		if (!m.isError) continue;
		if (protected_tools.has(m.toolName)) continue;
		if (protected_by_turn.has(m.toolCallId)) continue;
		errored_call_ids.add(m.toolCallId);
		if (!state.erroredAt.has(m.toolCallId)) {
			state.erroredAt.set(m.toolCallId, state.turnIndex);
		}
	}
	if (errored_call_ids.size === 0) return { purgedCount: 0, tokensSaved: 0 };

	let purged_count = 0;
	let tokens_saved = 0;

	for (const m of messages) {
		if (!is_assistant(m)) continue;
		for (const c of m.content) {
			if (!is_tool_call(c)) continue;
			if (protected_tools.has(c.name)) continue;
			if (protected_by_turn.has(c.id)) continue;
			if (!errored_call_ids.has(c.id)) continue;
			if (state.purgedErrorCallIds.has(c.id)) continue;

			const seen_at = state.erroredAt.get(c.id);
			if (seen_at === undefined) continue;
			if (state.turnIndex - seen_at < cfg.turns) continue;

			let before_tokens = 0;
			try {
				before_tokens = approx_tokens(canonical_json(c.arguments));
			} catch {
				before_tokens = 0;
			}
			c.arguments = { __purged: PURGE_ARGS_MARKER };
			const after_tokens = approx_tokens(canonical_json(c.arguments));
			state.purgedErrorCallIds.add(c.id);
			purged_count++;
			tokens_saved += Math.max(0, before_tokens - after_tokens);
		}
	}

	state.stats.errorInputsPurged += purged_count;
	state.stats.tokensSaved += tokens_saved;
	return { purgedCount: purged_count, tokensSaved: tokens_saved };
}
