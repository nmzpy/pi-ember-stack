/**
 * /dcp context
 *
 * Show the current session's context usage and DCP savings via notify
 * (no custom overlay / raw ANSI — Ember theme rules).
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";

function format_tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function progress_bar(percent: number, width = 24): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
}

export function make_context_command(state: SessionState) {
	return async function handle_context(
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const u = ctx.getContextUsage();
		const lines: string[] = ["pi-dcp / current context", ""];

		if (!u || u.tokens === null) {
			lines.push("tokens: unknown (no recent LLM call yet)");
		} else {
			const pct = u.percent ?? 0;
			lines.push(
				`tokens: ${u.tokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} (${pct.toFixed(1)}%)`,
			);
			lines.push(progress_bar(pct));
		}

		lines.push("");
		lines.push("Session savings:");
		lines.push(`  duplicate tool results pruned: ${state.stats.dedupPruned}`);
		lines.push(`  errored tool inputs purged:    ${state.stats.errorInputsPurged}`);
		lines.push(
			`  compressions applied:          ${state.stats.compressionsApplied}`,
		);
		lines.push(
			`  estimated tokens saved:        ~${format_tokens(state.stats.tokensSaved)}`,
		);

		const active = [...state.compressions.values()].filter((r) => !r.suspended);
		lines.push("");
		lines.push("Active compressions:");
		if (active.length === 0) {
			lines.push("  (none)");
		} else {
			for (const r of active) {
				lines.push(
					`  #${r.id} — ${r.topic}  (${r.toolCallIds.length} call${r.toolCallIds.length === 1 ? "" : "s"})`,
				);
			}
		}

		lines.push("");
		lines.push(`manual mode: ${state.manualMode ? "ON" : "off"}`);

		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	};
}
