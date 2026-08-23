// render-intent.ts — Canonical, session-safe render-intent entry point.
//
// This is the ONLY place in Ember UI allowed to invoke Pi's public
// `requestRender`. It is NOT a render scheduler: no timers, no microtask
// batching, no render loop, no terminal output, no TUI private-state access,
// no `tui.render`, and no invalidate calls. It merely holds the live public
// request callback, is safely bound/reset across session replacement, and
// invokes it synchronously only while live.
//
// Jiti-duplication safety: the live callback is stored on `globalThis` via a
// `Symbol.for` key so that duplicated module instances (caused by jiti caching
// across importer chains) always read and write the same slot. A stale
// session's callback is cleared on `reset_render_intent()` so any late caller
// no-ops instead of firing against a dead TUI.

const RENDER_INTENT_KEY = Symbol.for("pi-ember-ui:render-intent");

type RenderIntentSlot = (() => void) | undefined;

function read_slot(): RenderIntentSlot {
	return (globalThis as unknown as Record<symbol, unknown>)[RENDER_INTENT_KEY] as RenderIntentSlot;
}

function write_slot(value: RenderIntentSlot): void {
	(globalThis as unknown as Record<symbol, unknown>)[RENDER_INTENT_KEY] = value;
}

/**
 * Bind Pi's public TUI render request callback. Called from `session_start`
 * after the live TUI is available. The callback must be the TUI's own
 * `requestRender` — never a parallel scheduler or wrapper that adds timers.
 */
export function bind_render_intent(cb: (() => void) | undefined): void {
	write_slot(cb);
}

/**
 * Clear the bound render callback. Called on `session_shutdown` and at the
 * top of `session_start` so stale callbacks from a previous session no-op.
 */
export function reset_render_intent(): void {
	write_slot(undefined);
}

/**
 * The single canonical render request. Synchronously invokes the bound
 * callback if and only if one is live. After `reset_render_intent()` this
 * is a no-op — stale session callers cannot fire against a dead TUI.
 */
export function request_render(): void {
	const cb = read_slot();
	if (cb) cb();
}

/** Whether a live render callback is currently bound. */
export function is_render_intent_bound(): boolean {
	return read_slot() !== undefined;
}
