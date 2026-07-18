/**
 * Deduplication strategy.
 *
 * Walks tool results newest-first. When we see a (toolName + canonical-args)
 * signature we have already kept, we replace the older tool result's content
 * with a placeholder. Newest result for each signature is preserved verbatim.
 *
 * Protected tools are NEVER deduplicated.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import {
	type AnyMessage,
	is_assistant,
	is_tool_result,
	placeholder_tool_result,
	tool_call_key,
	tool_calls_of,
} from "../messages.ts";
import type { SessionState } from "../state.ts";

export interface DedupResult {
	prunedCount: number;
	tokensSaved: number;
}

export function apply_deduplication(
	messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	protected_by_turn: Set<string> = new Set(),
): DedupResult {
	if (!config.strategies.deduplication.enabled) {
		return { prunedCount: 0, tokensSaved: 0 };
	}
	const protected_tools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.strategies.deduplication.protectedTools,
		...config.compress.protectedTools,
	]);

	// Map every toolCallId -> dedup-key from assistant tool calls (arguments).
	const call_id_to_key = new Map<string, string>();
	for (const m of messages) {
		if (!is_assistant(m)) continue;
		for (const call of tool_calls_of(m)) {
			if (protected_tools.has(call.name)) continue;
			call_id_to_key.set(call.id, tool_call_key(call));
		}
	}

	// Walk results newest -> oldest. Keep the first occurrence per key.
	const seen_keys = new Set<string>();
	let pruned_count = 0;
	let tokens_saved = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!is_tool_result(m)) continue;
		if (protected_tools.has(m.toolName)) continue;
		if (protected_by_turn.has(m.toolCallId)) continue;
		const key = call_id_to_key.get(m.toolCallId);
		if (!key) continue;
		if (!seen_keys.has(key)) {
			seen_keys.add(key);
			continue; // newest of its signature — keep
		}
		const saved = placeholder_tool_result(m, `duplicate ${m.toolName} call`);
		if (!state.dedupedCallIds.has(m.toolCallId)) {
			state.dedupedCallIds.add(m.toolCallId);
			pruned_count++;
			tokens_saved += saved;
		}
	}

	state.stats.dedupPruned += pruned_count;
	state.stats.tokensSaved += tokens_saved;
	return { prunedCount: pruned_count, tokensSaved: tokens_saved };
}
