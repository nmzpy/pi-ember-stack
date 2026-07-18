/**
 * Context pipeline.
 *
 * Heart of pi-ember-dcp. Runs on every `context` event — just before pi sends a
 * request to the model. We receive `event.messages` whose entries share
 * object identity with the persisted session entries; mutating them in place
 * would corrupt the on-disk session. We therefore:
 *
 *   1. Build a working array, swapping any message we plan to touch with a
 *      cloned copy (clone_for_mutation). Untouched messages keep their original
 *      reference.
 *   2. Apply stored compressions, then deduplication, then errored-input
 *      purge — each step mutates only the cloned copies.
 *   3. Return the working array so pi can hand it to the provider.
 *
 * Order matters: compressions first (cheapest + most aggressive), then dedup
 * (keeps newest of each signature), then purge (independent of the others).
 *
 * Every step is idempotent so re-running on the same conversation is safe.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { Logger } from "./logger.ts";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "./config.ts";
import {
	type AnyMessage,
	clone_for_mutation,
	compression_placeholder_tool_result,
	is_already_placeholder,
	is_assistant,
	is_tool_call,
	is_tool_result,
	protected_by_recency,
} from "./messages.ts";
import { apply_deduplication } from "./strategies/deduplication.ts";
import { apply_purge_errors } from "./strategies/purge-errors.ts";
import type { CompressionRecord, SessionState } from "./state.ts";
import { bump_lifetime } from "./stats.ts";

export interface PipelineResult {
	/** New messages array to hand back to pi. Same shape as input, mutation-safe. */
	messages: AnyMessage[];
	dedupPruned: number;
	errorInputsPurged: number;
	compressionsApplied: number;
	tokensSaved: number;
}

/**
 * Decide whether a message needs to be cloned for this pass. We clone tool
 * results that may be overwritten and assistant messages whose tool-call
 * arguments may be rewritten. Everything else stays a shared reference.
 */
function needs_clone(
	m: AnyMessage,
	config: DcpConfig,
	compression_targets: Set<string>,
): boolean {
	const protected_tools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.compress.protectedTools,
	]);
	if (is_tool_result(m)) {
		if (protected_tools.has(m.toolName)) return false;
		if (compression_targets.has(m.toolCallId)) return true;
		// Could become a dedup placeholder or be left alone; clone to be safe.
		return true;
	}
	if (is_assistant(m)) {
		for (const c of m.content) {
			if (is_tool_call(c) && !protected_tools.has(c.name)) return true;
		}
		return false;
	}
	return false;
}

function compressions_by_tool_call_id(
	state: SessionState,
): Map<string, CompressionRecord> {
	const out = new Map<string, CompressionRecord>();
	for (const rec of state.compressions.values()) {
		if (rec.suspended) continue;
		for (const id of rec.toolCallIds) out.set(id, rec);
	}
	return out;
}

export function run_pipeline(
	original_messages: AnyMessage[],
	config: DcpConfig,
	state: SessionState,
	logger: Logger,
): PipelineResult {
	// Manual mode can optionally disable auto strategies (dedup + purgeErrors).
	// Compressions are user-triggered, so we always apply them.
	const manual_silent =
		(config.manualMode.enabled || state.manualMode) &&
		!config.manualMode.automaticStrategies;

	const protected_by_turn = config.turnProtection.enabled
		? protected_by_recency(original_messages, config.turnProtection.turns)
		: new Set<string>();

	const summaries = compressions_by_tool_call_id(state);
	const compression_targets = new Set(summaries.keys());

	// Build a fresh working array. Each entry is either the original message
	// or a clone we can mutate.
	const messages: AnyMessage[] = new Array(original_messages.length);
	for (let i = 0; i < original_messages.length; i++) {
		const m = original_messages[i];
		messages[i] = needs_clone(m, config, compression_targets)
			? clone_for_mutation(m)
			: m;
	}

	const result: PipelineResult = {
		messages,
		dedupPruned: 0,
		errorInputsPurged: 0,
		compressionsApplied: 0,
		tokensSaved: 0,
	};

	// 1. Apply stored compressions.
	if (summaries.size > 0) {
		const protected_tools = new Set([
			...ALWAYS_PROTECTED_TOOLS,
			...config.compress.protectedTools,
		]);
		for (const m of messages) {
			if (!is_tool_result(m)) continue;
			if (protected_tools.has(m.toolName)) continue;
			if (protected_by_turn.has(m.toolCallId)) continue;
			const rec = summaries.get(m.toolCallId);
			if (!rec || rec.suspended) continue;
			if (is_already_placeholder(m)) continue;
			const saved = compression_placeholder_tool_result(m, rec.id, rec.topic);
			if (!state.appliedCompressionTargets.has(m.toolCallId)) {
				state.appliedCompressionTargets.add(m.toolCallId);
				result.compressionsApplied++;
				result.tokensSaved += saved;
				state.stats.tokensSaved += saved;
			}
		}
	}

	if (!manual_silent) {
		// 2. Deduplication.
		const dedup = apply_deduplication(messages, config, state, protected_by_turn);
		result.dedupPruned = dedup.prunedCount;
		result.tokensSaved += dedup.tokensSaved;

		// 3. Purge errored tool inputs.
		const purged = apply_purge_errors(messages, config, state, protected_by_turn);
		result.errorInputsPurged = purged.purgedCount;
		result.tokensSaved += purged.tokensSaved;
	}

	if (result.dedupPruned || result.errorInputsPurged || result.compressionsApplied) {
		state.stats.compressionsApplied += result.compressionsApplied;
		logger.info("pipeline applied", {
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
			tokensSaved: result.tokensSaved,
		});
		bump_lifetime({
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
			tokensSaved: result.tokensSaved,
		});
	}

	return result;
}
