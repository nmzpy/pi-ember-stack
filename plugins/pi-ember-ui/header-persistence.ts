/**
 * Sticky ember startup header across session replacement.
 *
 * Pi's TUI owns terminal scrollback. Its differential renderer issues a full
 * redraw that clears the screen AND the terminal scrollback (`\x1b[2J` + `\x1b[H`
 * + `\x1b[3J`) whenever the first changed line sits above the previous
 * viewport top. Any top-of-buffer content change during a `/resume` / `/new` /
 * `/fork` switch therefore destroys the user's scrollback ("jump-to-top" +
 * "scroll lock").
 *
 * The ember startup logo header lives at the very top of the buffer. On every
 * session switch Pi's `resetExtensionUI()` restores the built-in header
 * (ember → builtIn at line 0), the resumed transcript rebuilds, and the
 * `session_start` handler re-installs the ember header (builtIn → ember at
 * line 0). Each swap is a top-of-buffer change that forces the scrollback-
 * clearing full redraw — including one final redraw *after* the resumed
 * content is already painted (the visible "one-scroll-tick jump-to-top").
 *
 * This patch makes the ember header sticky across session replacement: Pi's
 * teardown restore is skipped while the ember header is active, and the
 * session_start re-install renders byte-identical rows (same logo, model, and
 * cwd on a normal resume), so the top-of-buffer content never changes during
 * the switch and no extra full redraw is issued. Pi's native rebuild render
 * (inherent to any transcript replacement) remains the only possible clear.
 *
 * This is a public-method wrap (delegates to the original) — it never touches
 * TUI render/differential state, never writes terminal output, and never
 * intercepts scroll input.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

/** A `ctx.ui.setHeader` factory (duck-typed; Pi's signature is dynamic). */
export type EmberHeaderFactory = (tui: unknown, theme: unknown) => unknown;

const ACTIVE_FACTORY_KEY = Symbol.for("pi-ember-ui:active-ember-header-factory");
const PATCH_MARKER = Symbol.for("pi-ember-ui:header-persistence-patch");

interface ActiveFactorySlot {
	factory?: EmberHeaderFactory;
}

function active_factory_slot(): ActiveFactorySlot {
	const g = globalThis as Record<symbol, ActiveFactorySlot | undefined>;
	if (!g[ACTIVE_FACTORY_KEY]) g[ACTIVE_FACTORY_KEY] = {};
	return g[ACTIVE_FACTORY_KEY] as ActiveFactorySlot;
}

/** SSOT: register the factory currently rendering the ember startup header.
 *  Shared via `Symbol.for` so jiti module duplication cannot desync the
 *  sticky-header decision across Pi rebuilds.
 */
export function set_active_ember_header_factory(factory: EmberHeaderFactory | undefined): void {
	active_factory_slot().factory = factory;
}

/** True while the ember startup header owns the custom-header slot. */
export function is_ember_header_active(): boolean {
	return active_factory_slot().factory !== undefined;
}

type SetExtensionHeaderFn = (factory?: unknown) => void;

interface SetExtensionHeaderSurface {
	setExtensionHeader?: SetExtensionHeaderFn;
	[PATCH_MARKER]?: boolean;
}

/** Install the sticky-header wrap on `InteractiveMode.prototype`. Idempotent
 *  across jiti module copies. */
export function install_header_persistence_patch(): void {
	const proto = InteractiveMode.prototype as unknown as SetExtensionHeaderSurface;
	if (proto[PATCH_MARKER]) return;
	proto[PATCH_MARKER] = true;

	const original = proto.setExtensionHeader;
	if (typeof original !== "function") return;

	proto.setExtensionHeader = function emberStickyHeader(factory?: unknown): void {
		if (factory === undefined && is_ember_header_active()) {
			// Pi's session teardown (resetExtensionUI) restores the built-in
			// header. Keep the ember header so the top-of-buffer content does
			// not change during session replacement — a change there forces
			// pi-tui to clear the screen + scrollback. The session_start
			// re-install re-binds the live factory with identical rows.
			return;
		}
		if (factory !== undefined && factory !== active_factory_slot().factory) {
			// A different extension took over the custom header; the ember
			// header is no longer the live one, so later teardown restores are
			// delegated normally.
			set_active_ember_header_factory(undefined);
		}
		original.call(this, factory);
	};
}

/** Test seam: force the active-factory decision for unit tests without
 *  installing a real header factory. Returns the previous active factory. */
export function set_active_ember_header_factory_for_tests(
	factory: EmberHeaderFactory | undefined,
): EmberHeaderFactory | undefined {
	const previous = active_factory_slot().factory;
	active_factory_slot().factory = factory;
	return previous;
}

/** Test seam: restore the sticky-header patch state (no-op in production). */
export function reset_header_persistence_for_tests(): void {
	active_factory_slot().factory = undefined;
}
