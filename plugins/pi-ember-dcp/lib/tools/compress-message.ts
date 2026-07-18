/**
 * `compress` tool, MESSAGE mode.
 *
 * The model picks individual tool-call IDs to summarize away.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import { Type } from "typebox";
import {
	type ExtensionContext,
	type ToolDefinition,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import { protected_by_recency, type AnyMessage } from "../messages.ts";
import { PROMPTS } from "../prompts/index.ts";
import {
	type CompressToolContext,
	preflight,
	reply,
	store_compression,
} from "./shared.ts";

const Schema = Type.Object({
	toolCallIds: Type.Array(Type.String(), {
		description:
			"IDs of tool calls (visible in your conversation history) whose results should be replaced with the summary. At least one. Older / closed work-streams are best candidates. NEVER include calls from your most recent turn.",
		minItems: 1,
	}),
	topic: Type.String({
		description:
			"Short heading (max ~120 chars) describing what the compressed work was about. E.g. 'Initial repo scan' or 'Failed dependency install attempts'.",
		minLength: 3,
		maxLength: 120,
	}),
	summary: Type.String({
		description:
			"High-fidelity technical summary of the compressed work. Include: 1) what was accomplished, 2) all concrete facts the model may need later (file paths, line numbers, error messages, decisions), 3) what is still open. Be terse but lossless on facts.",
		minLength: 30,
	}),
});

type CompressMessageParams = {
	toolCallIds: string[];
	topic: string;
	summary: string;
};

function branch_messages(branch: unknown[]): AnyMessage[] {
	return (branch as Array<{ type?: string; message?: unknown }>)
		.filter((e) => e?.type === "message" && e.message)
		.map((e) => e.message as AnyMessage);
}

export function create_compress_message_tool(
	ctx: CompressToolContext,
): ToolDefinition<typeof Schema> {
	return defineTool({
		name: "compress",
		label: "Compress",
		description: ctx.prompts.read(PROMPTS.compressMessage),
		promptSnippet:
			"compress(toolCallIds, topic, summary) — replace older tool outputs with a lossless technical summary to reclaim context.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(
			_tool_call_id,
			params: CompressMessageParams,
			_signal,
			_on_update,
			ext: ExtensionContext,
		) {
			const stop = preflight(ctx);
			if (stop) return stop;

			const ids = [...new Set(params.toolCallIds)].filter((s) => s && s.length > 0);
			if (ids.length === 0) {
				return reply("compress refused: toolCallIds was empty after deduplication.", {
					refused: true,
					reason: "empty_ids",
				});
			}

			// turnProtection guard: refuse upfront if any id is inside the protected
			// window. Fail-closed when the branch can't be read.
			if (ctx.config.turnProtection.enabled) {
				let branch: unknown[];
				try {
					branch = ext.sessionManager.getBranch();
				} catch (e) {
					ctx.logger.error("compress message: failed to read branch", {
						error: e instanceof Error ? e.message : String(e),
					});
					return reply("compress refused: could not read session branch.", {
						refused: true,
						reason: "branch_read_failed",
					});
				}
				if (branch.length > 0) {
					const protected_set = protected_by_recency(
						branch_messages(branch),
						ctx.config.turnProtection.turns,
					);
					const overlap = ids.filter((id) => protected_set.has(id));
					if (overlap.length > 0) {
						return reply(
							`compress refused: ${overlap.length} of ${ids.length} tool-call id(s) are inside the protected window (turnProtection.turns=${ctx.config.turnProtection.turns}). Pick older calls.`,
							{ refused: true, reason: "protected_window_overlap" },
						);
					}
				}
			}

			return store_compression(ctx, ids, params.topic, params.summary);
		},
	});
}
