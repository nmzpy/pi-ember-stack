/**
 * `compress` tool, RANGE mode.
 *
 * The model gives two toolCallIds — the first and last call in a contiguous
 * closed work-stream — and we resolve the span by walking the current
 * session branch root→leaf.
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
	branch_tool_call_ids,
	preflight,
	reply,
	store_compression,
} from "./shared.ts";

const Schema = Type.Object({
	startToolCallId: Type.String({
		description:
			"Tool-call ID of the FIRST call in the closed work-stream you want to compress. Must be visible in your conversation history.",
	}),
	endToolCallId: Type.String({
		description:
			"Tool-call ID of the LAST call in the closed work-stream. Everything between start and end (inclusive) is compressed. NEVER pick a tool call from your most recent turn or in-flight work.",
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

type CompressRangeParams = {
	startToolCallId: string;
	endToolCallId: string;
	topic: string;
	summary: string;
};

function branch_messages(branch: unknown[]): AnyMessage[] {
	return (branch as Array<{ type?: string; message?: unknown }>)
		.filter((e) => e?.type === "message" && e.message)
		.map((e) => e.message as AnyMessage);
}

export function create_compress_range_tool(
	ctx: CompressToolContext,
): ToolDefinition<typeof Schema> {
	return defineTool({
		name: "compress",
		label: "Compress",
		description: ctx.prompts.read(PROMPTS.compressRange),
		promptSnippet:
			"compress(startToolCallId, endToolCallId, topic, summary) — replace a contiguous span of tool outputs with a lossless technical summary.",
		parameters: Schema,
		executionMode: "sequential",
		async execute(
			_tool_call_id,
			params: CompressRangeParams,
			_signal,
			_on_update,
			ext: ExtensionContext,
		) {
			const stop = preflight(ctx);
			if (stop) return stop;

			if (!params.startToolCallId || !params.endToolCallId) {
				return reply(
					"compress refused: startToolCallId/endToolCallId are required.",
					{
						refused: true,
						reason: "missing_endpoints",
					},
				);
			}

			let branch: unknown[];
			try {
				branch = ext.sessionManager.getBranch();
			} catch (e) {
				ctx.logger.error("compress range: failed to read branch", {
					error: e instanceof Error ? e.message : String(e),
				});
				return reply("compress refused: could not read session branch.", {
					refused: true,
					reason: "branch_read_failed",
				});
			}
			const ordered_ids = branch_tool_call_ids(branch, ctx.config);
			const start_idx = ordered_ids.findIndex((x) => x.id === params.startToolCallId);
			const end_idx = ordered_ids.findIndex((x) => x.id === params.endToolCallId);

			if (start_idx === -1 || end_idx === -1) {
				return reply(
					`compress refused: ${start_idx === -1 ? "startToolCallId" : "endToolCallId"} not found in current session branch (or it points to a protected tool).`,
					{ refused: true, reason: "endpoint_not_found" },
				);
			}

			const lo = Math.min(start_idx, end_idx);
			const hi = Math.max(start_idx, end_idx);
			const ids = ordered_ids.slice(lo, hi + 1).map((x) => x.id);

			if (ids.length === 0) {
				return reply("compress refused: resolved range was empty.", {
					refused: true,
					reason: "empty_range",
				});
			}

			if (ctx.config.turnProtection.enabled) {
				const protected_set = protected_by_recency(
					branch_messages(branch),
					ctx.config.turnProtection.turns,
				);
				const overlap = ids.filter((id) => protected_set.has(id));
				if (overlap.length > 0) {
					return reply(
						`compress refused: ${overlap.length} of ${ids.length} tool call(s) in the range are inside the protected window (turnProtection.turns=${ctx.config.turnProtection.turns}). Pick endpoints older than the last ${ctx.config.turnProtection.turns} user message(s).`,
						{ refused: true, reason: "protected_window_overlap" },
					);
				}
			}

			return store_compression(ctx, ids, params.topic, params.summary);
		},
	});
}
