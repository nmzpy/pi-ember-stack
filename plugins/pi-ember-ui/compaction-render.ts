import { truncateToWidth } from "@earendil-works/pi-tui";
import { statusBulletColor } from "../pi-compact-tools/renderer.ts";
import {
	type GradientPreset,
	get_gradient_phase,
	render_gradient,
	request_gradient_render,
	subscribe_gradient_tick,
	unsubscribe_gradient_tick,
} from "./gradient.ts";

type CompactionStatusIndicator = {
	invalidate?: () => void;
};

let active_compaction_indicator: CompactionStatusIndicator | undefined;
let compaction_tick_cb: (() => void) | undefined;

function ensure_compaction_status_tick(): void {
	// Self-healing subscription: a prior compaction end (or session reset) may
	// have dropped this cb from the subscriber set while compaction_tick_cb
	// stayed set, so the `if (compaction_tick_cb) return` guard would leave a
	// new compaction with NO live tick — the frozen "• Compacting" row.
	// Unsubscribing is a no-op when the cb is absent; re-subscribing the same
	// cb is idempotent in the Set, so every bind is safe to re-attach it.
	if (!compaction_tick_cb) {
		compaction_tick_cb = (): void => {
			active_compaction_indicator?.invalidate?.();
			// Text.invalidate() only drops Pi's component cache. The native TUI still
			// needs its public render request to observe the new gradient phase — but
			// the gradient clock owns that single per-tick render, so mark the clock
			// dirty instead of requesting a frame from the subscriber.
			request_gradient_render();
		};
	}
	unsubscribe_gradient_tick(compaction_tick_cb);
	subscribe_gradient_tick(compaction_tick_cb);
}

function drop_compaction_status_tick(): void {
	if (!compaction_tick_cb) return;
	unsubscribe_gradient_tick(compaction_tick_cb);
	compaction_tick_cb = undefined;
}

/** Wire the live compaction status row to the shared 20 FPS gradient clock. */
export function bind_compaction_status_indicator(indicator: unknown): void {
	active_compaction_indicator = indicator as CompactionStatusIndicator;
	ensure_compaction_status_tick();
}

/** Clear compaction status tick wiring when the indicator is removed.
 *  Pass the indicator being cleared so a stale clear from an earlier
 *  compaction cannot kill the live tick of a newer compaction that is still
 *  running (sequential compaction_start/end events interleave: end of run 1
 *  may arrive after start of run 2). With no argument (session shutdown) the
 *  wiring is always dropped. */
export function unbind_compaction_status_indicator(indicator?: unknown): void {
	if (indicator !== undefined && active_compaction_indicator !== indicator) return;
	active_compaction_indicator = undefined;
	drop_compaction_status_tick();
}

/** Minimal theme shape for compaction rows. */
export type CompactionThemeLike = {
	fg(tag: string, text: string): string;
	bold(text: string): string;
};

/** Same dim→text sweep as the Thinking header — one shared 20 FPS clock. */
export const COMPACTION_GRADIENT_PRESET: GradientPreset = "thinking";

/** Gradient `Compacting` label at the live sweep phase. */
export function render_compacting_gradient_label(): string {
	return render_gradient("Compacting", COMPACTION_GRADIENT_PRESET, get_gradient_phase());
}

/** Running compaction row: muted bullet + gradient `Compacting`.
 *  One blank row above so it does not sit flush against prior output. */
export function format_compacting_row(theme: CompactionThemeLike, width: number): string[] {
	const bullet = statusBulletColor(false, false, theme);
	const line = bullet + render_compacting_gradient_label();
	return ["", truncateToWidth(line, Math.max(1, width))];
}

/** Completed compaction row: success bullet + `Compacted N tokens into ~M.` */
export function format_compacted_row(
	theme: CompactionThemeLike,
	tokens_before: number,
	summary_length: number,
	is_error = false,
): string {
	const bullet = statusBulletColor(is_error, !is_error, theme);
	const before = tokens_before.toLocaleString();
	const after = Math.ceil(summary_length / 4).toLocaleString();
	const label = theme.fg("muted", theme.bold("Compacted"));
	const stats = theme.fg("muted", ` ${before} tokens into ~${after}.`);
	return bullet + label + stats;
}
