/**
 * /dcp decompress <id> and /dcp recompress <id>
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";

function notify(
	ctx: ExtensionCommandContext,
	msg: string,
	type: "info" | "warning" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(msg, type);
}

/** Strict positive-integer parse — rejects "5abc", negatives, NaN. */
function parse_strict_id(arg: string): number | undefined {
	if (!/^\d+$/.test(arg)) return undefined;
	const n = Number(arg);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function make_decompress_command(state: SessionState) {
	return async function handle_decompress(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const arg = args.trim();
		if (!arg) {
			const active = [...state.compressions.values()].filter((r) => !r.suspended);
			if (active.length === 0) {
				notify(ctx, "pi-dcp: no active compressions to decompress");
				return;
			}
			const lines = ["pi-dcp / active compressions (run /dcp decompress <id>):"];
			for (const r of active) {
				lines.push(
					`  #${r.id} — ${r.topic} (${r.toolCallIds.length} call(s))`,
				);
			}
			notify(ctx, lines.join("\n"));
			return;
		}
		const id = parse_strict_id(arg);
		if (id === undefined) {
			notify(
				ctx,
				`pi-dcp: invalid compression id "${arg}" (must be a positive integer)`,
				"warning",
			);
			return;
		}
		const rec = state.compressions.get(id);
		if (!rec) {
			notify(ctx, `pi-dcp: no compression with id ${id}`, "warning");
			return;
		}
		if (rec.suspended) {
			notify(ctx, `pi-dcp: compression #${id} is already decompressed`);
			return;
		}
		rec.suspended = true;
		notify(ctx, `pi-dcp: compression #${id} decompressed (originals restored)`);
	};
}

export function make_recompress_command(state: SessionState) {
	return async function handle_recompress(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const arg = args.trim();
		if (!arg) {
			const suspended = [...state.compressions.values()].filter((r) => r.suspended);
			if (suspended.length === 0) {
				notify(ctx, "pi-dcp: no decompressed entries to recompress");
				return;
			}
			const lines = [
				"pi-dcp / suspended compressions (run /dcp recompress <id>):",
			];
			for (const r of suspended) lines.push(`  #${r.id} — ${r.topic}`);
			notify(ctx, lines.join("\n"));
			return;
		}
		const id = parse_strict_id(arg);
		if (id === undefined) {
			notify(
				ctx,
				`pi-dcp: invalid compression id "${arg}" (must be a positive integer)`,
				"warning",
			);
			return;
		}
		const rec = state.compressions.get(id);
		if (!rec) {
			notify(ctx, `pi-dcp: no compression with id ${id}`, "warning");
			return;
		}
		if (!rec.suspended) {
			notify(ctx, `pi-dcp: compression #${id} is already active`);
			return;
		}
		rec.suspended = false;
		notify(ctx, `pi-dcp: compression #${id} re-applied`);
	};
}

// Re-exported for unit tests.
export const _internal = { parse_strict_id };
