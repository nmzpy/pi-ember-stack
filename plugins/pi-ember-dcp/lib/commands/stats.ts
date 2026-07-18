/**
 * /dcp stats
 *
 * Lifetime DCP savings via notify (no custom overlay / raw ANSI).
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { read_lifetime } from "../stats.ts";

function format_tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function humanize_ago(first_seen: number): string {
	if (!first_seen) return "—";
	const days = Math.round((Date.now() - first_seen) / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "1 day ago";
	return `${days} days ago`;
}

export async function handle_stats(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const s = read_lifetime();
	const lines = [
		"pi-dcp / lifetime stats",
		"",
		`active since: ${humanize_ago(s.firstSeen)}`,
		`sessions touched: ${s.sessionsTouched.toLocaleString()}`,
		"",
		"Across all sessions:",
		`  duplicate tool results pruned: ${s.dedupPruned.toLocaleString()}`,
		`  errored tool inputs purged:    ${s.errorInputsPurged.toLocaleString()}`,
		`  compressions applied:          ${s.compressionsApplied.toLocaleString()}`,
		`  estimated tokens saved:        ~${format_tokens(s.tokensSaved)}`,
	];
	if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
}
