/**
 * User-visible feedback when the pipeline does work.
 *
 * Two surfaces, gated by `config.pruneNotification`:
 *
 *   - Footer status (minimal + detailed): `ctx.ui.setStatus("dcp", …)`
 *   - Inline notification (detailed only): `ctx.ui.notify(…)`
 *
 * No raw ANSI/hex styling — theme tokens and Pi's notify/setStatus only.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { PipelineResult } from "./pipeline.ts";
import type { SessionState } from "./state.ts";

const STATUS_KEY = "dcp";

/**
 * Repaint the footer status chip immediately (e.g. after state restore on
 * session_start). No-ops silently if ctx.hasUI is false or setStatus throws.
 */
export function refresh_footer_status(ctx: ExtensionContext, state: SessionState): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, build_footer_text(state));
	} catch {
		// best effort
	}
}

function format_tokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function build_footer_text(state: SessionState): string {
	const s = state.stats;
	const total = s.dedupPruned + s.errorInputsPurged + s.compressionsApplied;
	if (total === 0) return "DCP: idle";
	return `DCP: ~${format_tokens(s.tokensSaved)} saved`;
}

function build_notify_text(result: PipelineResult): string {
	const parts: string[] = [];
	if (result.dedupPruned > 0) {
		parts.push(
			`${result.dedupPruned} duplicate${result.dedupPruned > 1 ? "s" : ""}`,
		);
	}
	if (result.errorInputsPurged > 0) {
		parts.push(
			`${result.errorInputsPurged} errored call${result.errorInputsPurged > 1 ? "s" : ""} purged`,
		);
	}
	if (result.compressionsApplied > 0) {
		parts.push(
			`${result.compressionsApplied} compression${result.compressionsApplied > 1 ? "s" : ""} applied`,
		);
	}
	const summary = parts.join(", ");
	return `pi-dcp: ${summary} (~${format_tokens(result.tokensSaved)} tokens)`;
}

/**
 * Called from the `context` handler after every pipeline pass. Cheap when
 * the pipeline did no work (early return). Otherwise emits the configured
 * notifications.
 */
export function notify_pipeline_result(
	ctx: ExtensionContext,
	config: DcpConfig,
	state: SessionState,
	result: PipelineResult,
	logger?: Logger,
): void {
	const mode = config.pruneNotification;
	if (mode === "off") {
		logger?.info("notify skipped: pruneNotification=off");
		return;
	}
	if (!ctx.hasUI) {
		logger?.info("notify skipped: ctx.hasUI=false (non-interactive mode)");
		return;
	}

	const did_work =
		result.dedupPruned > 0 ||
		result.errorInputsPurged > 0 ||
		result.compressionsApplied > 0;

	const footer_text = build_footer_text(state);

	let footer_ok = false;
	try {
		ctx.ui.setStatus(STATUS_KEY, footer_text);
		footer_ok = true;
	} catch (err) {
		logger?.warn("setStatus failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	let notify_fired = false;
	if (mode === "detailed" && did_work) {
		const text = build_notify_text(result);
		try {
			ctx.ui.notify(text, "info");
			notify_fired = true;
		} catch (err) {
			logger?.warn("notify failed", {
				error: err instanceof Error ? err.message : String(err),
				text,
			});
		}
	}

	logger?.info("notify pass", {
		mode,
		didWork: did_work,
		footerText: footer_text,
		footerOk: footer_ok,
		notifyFired: notify_fired,
		result: {
			dedupPruned: result.dedupPruned,
			errorInputsPurged: result.errorInputsPurged,
			compressionsApplied: result.compressionsApplied,
		},
	});
}
