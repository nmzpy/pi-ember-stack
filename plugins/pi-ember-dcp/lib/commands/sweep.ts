/**
 * /dcp sweep [n]
 *
 * Stages a synthetic compression covering the last `n` tool results in the
 * current branch (default: all tool results since the most recent user
 * message).
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ALWAYS_PROTECTED_TOOLS, type DcpConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { CompressionRecord, SessionState } from "../state.ts";

function notify(
	ctx: ExtensionCommandContext,
	msg: string,
	type: "info" | "warning" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(msg, type);
}

export function make_sweep_command(
	state: SessionState,
	config: DcpConfig,
	logger: Logger,
) {
	return async function handle_sweep(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const arg = args.trim();
		// Strict: only accept pure positive-integer arguments.
		let user_limit: number | undefined;
		if (arg) {
			if (/^\d+$/.test(arg)) {
				const n = Number(arg);
				if (Number.isInteger(n) && n > 0) user_limit = n;
			}
			if (user_limit === undefined) {
				notify(
					ctx,
					`pi-dcp sweep: "${arg}" is not a positive integer; ignoring`,
					"warning",
				);
			}
		}

		const sm = ctx.sessionManager;
		let branch: ReturnType<typeof sm.getBranch>;
		try {
			branch = sm.getBranch();
		} catch (e) {
			notify(ctx, "pi-dcp sweep: could not read session branch", "warning");
			logger.error("sweep failed to read branch", {
				error: e instanceof Error ? e.message : String(e),
			});
			return;
		}

		const protected_tools = new Set([
			...ALWAYS_PROTECTED_TOOLS,
			...config.compress.protectedTools,
		]);

		// Walk newest-first across the branch.
		const ids: string[] = [];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as {
				type?: string;
				message?: { role?: string; toolName?: string; toolCallId?: string };
			};
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			if (msg.role === "user") break;
			if (msg.role !== "toolResult") continue;
			if (!msg.toolCallId || !msg.toolName) continue;
			if (protected_tools.has(msg.toolName)) continue;
			ids.push(msg.toolCallId);
			if (user_limit !== undefined && ids.length >= user_limit) break;
		}

		if (ids.length === 0) {
			notify(ctx, "pi-dcp sweep: no eligible tool results found");
			return;
		}

		const id = state.nextCompressionId++;
		const rec: CompressionRecord = {
			id,
			createdAt: Date.now(),
			toolCallIds: ids,
			summary: "(manual sweep — no summary; original outputs no longer in context)",
			topic: "manual sweep",
			tokensSaved: 0,
			suspended: false,
		};
		state.compressions.set(id, rec);
		logger.info("sweep staged", { id, count: ids.length });
		notify(
			ctx,
			`pi-dcp sweep: staged compression #${id} over ${ids.length} tool result(s). Run "/dcp decompress ${id}" to undo before the next message.`,
		);
	};
}
