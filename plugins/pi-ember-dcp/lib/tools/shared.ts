/**
 * Shared logic between the message-mode and range-mode compress tools.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import { approx_tokens } from "../messages.ts";
import type { CompressionRecord } from "../state.ts";
import type { DcpRuntime } from "../runtime.ts";

/** Compress tools close over the shared runtime bag (live config/state/logger). */
export type CompressToolContext = DcpRuntime;

export interface CompressDetails {
	compressionId?: number;
	topic?: string;
	resolvedToolCallIds?: string[];
	refused?: boolean;
	reason?: string;
}

export function reply(
	text: string,
	details: CompressDetails,
): AgentToolResult<CompressDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/**
 * Common pre-flight checks. Returns a reply to short-circuit the tool, or
 * undefined if the caller should proceed.
 */
export function preflight(
	ctx: CompressToolContext,
): AgentToolResult<CompressDetails> | undefined {
	if (ctx.config.compress.permission === "deny") {
		return reply("compress is disabled by configuration.", {
			refused: true,
			reason: "permission_deny",
		});
	}
	if (ctx.state.manualMode) {
		return reply(
			"compress is disabled because pi-dcp manual mode is on. The user must run /dcp sweep or /dcp manual off to re-enable autonomous compression.",
			{ refused: true, reason: "manual_mode" },
		);
	}
	return undefined;
}

/**
 * Store a compression record and return a success reply.
 * Caller is responsible for validating/deduping toolCallIds first.
 */
export function store_compression(
	ctx: CompressToolContext,
	ids: string[],
	topic: string,
	summary: string,
): AgentToolResult<CompressDetails> {
	const id = ctx.state.nextCompressionId++;
	const rec: CompressionRecord = {
		id,
		createdAt: Date.now(),
		toolCallIds: ids,
		summary,
		topic: topic.slice(0, 120),
		tokensSaved: approx_tokens(summary),
		suspended: false,
	};
	ctx.state.compressions.set(id, rec);
	ctx.logger.info("compression stored", {
		id,
		topic: rec.topic,
		calls: rec.toolCallIds.length,
	});
	return reply(
		`Compression #${id} stored ("${rec.topic}"). ${rec.toolCallIds.length} tool result(s) will be replaced with the summary on the next request. User can restore them with "/dcp decompress ${id}".`,
		{
			compressionId: id,
			topic: rec.topic,
			resolvedToolCallIds: rec.toolCallIds,
		},
	);
}

/**
 * Walk a session branch (root→leaf) and return ordered tool-call IDs for every
 * tool result entry, with protected tools filtered out.
 */
export function branch_tool_call_ids(
	branch: unknown[],
	config: DcpConfig,
): Array<{ id: string; toolName: string }> {
	const protected_tools = new Set([
		...ALWAYS_PROTECTED_TOOLS,
		...config.compress.protectedTools,
	]);
	const out: Array<{ id: string; toolName: string }> = [];
	for (const entry of branch as Array<{
		type?: string;
		message?: { role?: string; toolCallId?: string; toolName?: string };
	}>) {
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult") continue;
		if (!msg.toolCallId || !msg.toolName) continue;
		if (protected_tools.has(msg.toolName)) continue;
		out.push({ id: msg.toolCallId, toolName: msg.toolName });
	}
	return out;
}
