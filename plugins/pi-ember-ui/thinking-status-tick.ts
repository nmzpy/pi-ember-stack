import {
	EXTERNAL_THINKING_RENDER_INTERVAL_MS,
	subscribe_gradient_tick,
	unsubscribe_gradient_tick,
} from "./gradient.ts";
import { CompactGroupText } from "../pi-compact-tools/compact-text.ts";

type ThinkingStatusHost = {
	invalidate?: () => void;
};
type ThinkingStatusHostKind = "in_message" | "widget" | null;

let widget_host: ThinkingStatusHost | undefined;
let in_message_host: ThinkingStatusHost | undefined;
let thinking_status_tick_cb: (() => void) | undefined;
let should_paint_fn: () => boolean = () => false;
let resolve_host_fn: (() => ThinkingStatusHostKind) | undefined;
let build_thinking_row_fn: ((host: "widget" | "in_message") => string) | undefined;
let last_external_render_at = Number.NEGATIVE_INFINITY;

/**
 * Pre-baked gradient text for the external Thinking status row. The 20 FPS
 * gradient tick colorizes the label here (same pattern as the in-group
 * `└ Thinking` lane writing into a group's `CompactGroupText`), so Pi's
 * `render()` only truncates this cached string instead of re-running the
 * ANSI gradient colorization on every frame.
 */
const cached_thinking_text = new CompactGroupText();
let cached_thinking_host: "widget" | "in_message" | null = null;
/** Last staged gradient string — used to skip redundant invalidations. */
let last_staged_text = "";

/** Wire the live should-paint predicate from pi-ember-ui/index.ts (avoids circular imports). */
export function bind_thinking_status_tick_should_paint(fn: () => boolean): void {
	should_paint_fn = fn;
}

/** Wire the SSOT host resolver without importing the host owner (circularly). */
export function bind_thinking_status_tick_host_resolver(
	fn: () => ThinkingStatusHostKind,
): void {
	resolve_host_fn = fn;
}

/** Wire the SSOT row builder (leftPad + gradient label + elapsed + rightPad). */
export function bind_thinking_status_tick_builder(
	fn: (host: "widget" | "in_message") => string,
): void {
	build_thinking_row_fn = fn;
}

/** Build the gradient row into the cache for the resolved host. Returns the
 *  built string, or undefined when no builder is available. */
function stage_cached_thinking_row(host: "widget" | "in_message"): string | undefined {
	if (!build_thinking_row_fn) return undefined;
	const text = build_thinking_row_fn(host);
	cached_thinking_text.setText(text);
	cached_thinking_host = host;
	return text;
}

/** Read the cached gradient row for `host`, rebuilding once when the host
 *  changes or the cache is empty (first frame / host-change race recovery).
 *  Returns the ANSI-aware, width-truncated lines, or [] when no builder is
 *  bound (test seam) so the caller can fall back to an inline build. */
export function render_cached_thinking_status_lines(
	width: number,
	host: "widget" | "in_message",
): string[] {
	if (cached_thinking_host !== host || cached_thinking_text.text.length === 0) {
		const staged = stage_cached_thinking_row(host);
		if (staged !== undefined) last_staged_text = staged;
	}
	if (cached_thinking_text.text.length === 0) return [];
	return cached_thinking_text.render(width);
}

function invalidate_external_host(host: "widget" | "in_message"): void {
	const now = performance.now();
	// The shared clock advances at 20 FPS for compact/group consumers, but an
	// external host invalidation schedules a full native TUI frame. Do not even
	// rebuild the ANSI row on skipped ticks; the next permitted tick stages it
	// and repaints the one native frame that observes it.
	if (now - last_external_render_at < EXTERNAL_THINKING_RENDER_INTERVAL_MS) return;
	const prev = last_staged_text;
	const next = stage_cached_thinking_row(host);
	// Skip the invalidation when the staged text is identical to the last
	// frame (clock stopped / phase produced no visible change) so we do
	// not queue a redundant requestRender.
	if (next !== undefined && next === prev) return;
	if (next !== undefined) last_staged_text = next;
	last_external_render_at = now;
	if (host === "widget") widget_host?.invalidate?.();
	else in_message_host?.invalidate?.();
}

function dispatch_thinking_status_tick(): void {
	if (!should_paint_fn()) return;
	if (resolve_host_fn) {
		const host = resolve_host_fn();
		if (host === "widget" || host === "in_message") {
			invalidate_external_host(host);
			return;
		}
		// The compact group owns the status slot, so its own subscriber is
		// responsible for the render. Do not wake either external host.
		return;
	}
	// Keep the small unit-test seam useful before the production host resolver
	// is bound. Production always binds the resolver from index.ts, so only one
	// mutually-exclusive host is invalidated per tick.
	invalidate_external_host("widget");
}

function ensure_thinking_status_tick(): void {
	if (thinking_status_tick_cb) return;
	thinking_status_tick_cb = dispatch_thinking_status_tick;
	subscribe_gradient_tick(thinking_status_tick_cb);
}

function drop_thinking_status_tick(): void {
	if (!thinking_status_tick_cb) return;
	unsubscribe_gradient_tick(thinking_status_tick_cb);
	thinking_status_tick_cb = undefined;
}

/** Subscribe/unsubscribe the 20 FPS clock — owned by sync_thinking_gradient_clock only. */
export function sync_thinking_status_tick(should_run: boolean): void {
	if (should_run) ensure_thinking_status_tick();
	else drop_thinking_status_tick();
}

/** Store the above-editor Thinking widget host — does not subscribe the clock. */
export function bind_thinking_widget_host(host: ThinkingStatusHost | undefined): void {
	widget_host = host;
}

/** Store the in-message Thinking host — does not subscribe the clock. */
export function bind_thinking_in_message_host(host: ThinkingStatusHost | undefined): void {
	in_message_host = host;
}

/** Clear all thinking-status tick wiring on session shutdown. */
export function unbind_thinking_status_hosts(): void {
	widget_host = undefined;
	in_message_host = undefined;
	resolve_host_fn = undefined;
	build_thinking_row_fn = undefined;
	cached_thinking_text.setText("");
	cached_thinking_host = null;
	last_staged_text = "";
	last_external_render_at = Number.NEGATIVE_INFINITY;
	drop_thinking_status_tick();
}
