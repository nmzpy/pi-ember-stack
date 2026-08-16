import { afterEach, describe, expect, mock, test } from "bun:test";
import { getSharedRenderer } from "../shared-renderer.ts";
import {
	dispatch_gradient_tick,
	gradient_clock_is_idle,
	reset_gradient_colorizer,
	set_gradient_colorizer,
	set_gradient_render_request,
	shutdown_gradient_clock,
} from "../../pi-ember-ui/gradient.ts";
import { setThinkingBlocksHidden } from "../../pi-ember-ui/mode-colors.ts";

/**
 * Session-replacement render hygiene for the compact renderer.
 *
 * Pi re-evaluates extension factories on /resume, /new, /fork, /reload but
 * jiti caches the module, so module-level state survives across sessions.
 * A render request queued by the OLD session must never fire against the NEW
 * session's TUI — a stale render at the wrong moment repaints the wrong
 * viewport and can force pi-tui's scrollback-clearing full redraw.
 *
 * Invariants pinned here:
 * 1. agent_settled / resetForSession stop every compact gradient subscription
 *    (the shared 20 FPS clock goes idle) even when a standalone tool call
 *    never receives a result callback.
 * 2. resetForSession bumps the render generation and drops queued
 *    invalidations, so stale microtasks self-cancel instead of requesting a
 *    native render against the replaced session.
 * 3. Every queued native-render path — the visual debounce
 *    (debouncedGroupRenderRequest), the record-shrink snap
 *    (scheduleRecordShrinkSnap), and the group invalidation
 *    (scheduleGroupInvalidation) — emits ZERO `requestTuiRender()` calls
 *    after resetForSession, and the same queued paths DO render when no
 *    session replacement happens (control). Removing the renderGeneration
 *    guard (or the pending-invalidation-set clear) makes the reset test fail.
 */

// ---------------------------------------------------------------------------
// Deterministic render observation
//
// The compact renderer imports `requestTuiRender` from pi-ember-ui/index.ts.
// Rather than depending on the module-global live-TUI binding (which is only
// valid while a session is installed), patch that one import with a counting
// sink via bun's mock.module (same pattern as renderer.test.ts's "pendingShrink
// on group requests a normal native render"). Every queued render becomes
// observable regardless of cross-file module state.
// ---------------------------------------------------------------------------

async function with_render_sink(run: (calls: number[]) => Promise<void>): Promise<void> {
	const calls: number[] = [];
	const real_index = await import("../../pi-ember-ui/index.ts");
	mock.module("../../pi-ember-ui/index.ts", () => ({
		...real_index,
		requestTuiRender: () => {
			calls.push(1);
		},
	}));
	try {
		await run(calls);
	} finally {
		mock.restore();
	}
}

const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function make_theme(): unknown {
	return { fg: (tag: string, text: string) => `[${tag}:${text}]`, bold: (s: string) => s };
}

afterEach(() => {
	mock.restore();
	shutdown_gradient_clock();
	set_gradient_render_request(undefined);
	reset_gradient_colorizer();
	getSharedRenderer().resetForSession();
	setThinkingBlocksHidden(false);
});

// ---------------------------------------------------------------------------
// Lifecycle: gradient subscriptions and queued state across session boundaries
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => any;

function makeUi(): Record<string, unknown> {
	const widgets: Record<string, unknown> = {};
	const base: Record<string, unknown> = {
		widgets,
		mode: "tui",
		setWidget(name: string, factory?: (tui: unknown, theme: unknown) => unknown): void {
			if (factory) widgets[name] = factory({ requestRender() {} }, { fg: () => "" });
			else delete widgets[name];
		},
		setHeader() {},
		setFooter() {},
		setWorkingVisible() {},
		setHiddenThinkingLabel() {},
		setStatus() {},
		addInputListener() {
			return () => {};
		},
		onTerminalInput() {
			return () => {};
		},
		notify() {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => "",
		editor: async () => "",
		custom: () => ({}),
		requestRender() {},
	};
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return () => undefined;
		},
	});
}

function makeCtx(): Record<string, unknown> {
	return {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: makeUi(),
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "sess",
			getCwd: () => process.cwd(),
			getEntries: () => [],
			getBranch: () => [],
		},
		model: { id: "test-model", name: "Test Model" },
		modelRegistry: { getAvailable: () => [] },
		isIdle: () => false,
		getContextUsage: () => undefined,
	};
}

async function install_plugins(): Promise<{ handlers: Record<string, Handler[]> }> {
	const { default: piCompactToolsPlugin } = await import("../index.ts");
	const { default: piEmberUiPlugin } = await import("../../pi-ember-ui/index.ts");
	const handlers: Record<string, Handler[]> = {};
	const events: Record<string, Handler[]> = {};
	const pi = {
		on(name: string, h: Handler) {
			(handlers[name] ??= []).push(h);
		},
		events: {
			on(name: string, h: Handler) {
				(events[name] ??= []).push(h);
			},
		},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		registerTool() {},
		sendMessage() {},
		setActiveTools() {},
		setModel() {},
		setThinkingLevel() {},
	};
	piCompactToolsPlugin(pi as never, { excludeTools: [] });
	piEmberUiPlugin(pi as never);
	return { handlers };
}

function fire(handlers: Record<string, Handler[]>, name: string, event: any, ctx: any): void {
	for (const h of handlers[name] ?? []) h(event, ctx);
}

/** Drive one completed read call under the live work group and hold the lane. */
function trigger_group_render(): void {
	const renderer = getSharedRenderer();
	const theme = make_theme() as never;
	const state: Record<string, any> = {};
	const ctx = { args: {}, toolCallId: "g1", invalidate: () => {}, state };
	renderer.renderCall("read", { path: "a.ts" }, theme, ctx as never);
	renderer.renderResult(
		"read",
		{ path: "a.ts" },
		{ content: [{ type: "text", text: "a" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: false } as never,
	);
	setThinkingBlocksHidden(true);
	renderer.holdToolLane();
}

describe("compact renderer session-replacement hygiene", () => {
	test("resetForSession cancels queued invalidations and stops every gradient subscription", async () => {
		const { handlers } = await install_plugins();
		fire(handlers, "session_start", { reason: "startup" }, makeCtx());
		// Drop the startup logo animation so the clock returns to idle.
		fire(handlers, "agent_settled", {}, makeCtx());

		trigger_group_render();
		// The held tool lane keeps a live 20 FPS group tick subscription.
		expect(gradient_clock_is_idle()).toBe(false);
		const internal = getSharedRenderer() as unknown as {
			pendingGroupRenderRequestTimer: unknown;
			pendingGroupInvalidations: Set<unknown>;
			renderGeneration: number;
		};

		// Session replacement (shutdown + start) happens synchronously BEFORE
		// the queued microtask can run.
		const generation_before = internal.renderGeneration;
		getSharedRenderer().resetForSession();
		expect(internal.renderGeneration).toBe(generation_before + 1);
		expect(internal.pendingGroupRenderRequestTimer).toBeUndefined();
		expect(internal.pendingGroupInvalidations.size).toBe(0);
		expect(gradient_clock_is_idle()).toBe(true);

		// Drain microtasks: stale debounce self-cancels (generation mismatch)
		// and never re-arms the pending timer.
		await drain();
		expect(internal.pendingGroupRenderRequestTimer).toBeUndefined();
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("a live group tick requests exactly one render per dispatch, and none after reset", async () => {
		const { handlers } = await install_plugins();
		fire(handlers, "session_start", { reason: "startup" }, makeCtx());
		fire(handlers, "agent_settled", {}, makeCtx());
		// Route gradient-clock renders (the compact group tick's render sink)
		// to the counter. This is the public gradient hook the renderer uses.
		const sink = { n: 0 };
		set_gradient_render_request(() => (sink.n += 1));

		trigger_group_render();
		sink.n = 0;
		const base = performance.now();
		const original_now = performance.now;
		// Deterministic gradient frames: the default chalk colorizer output can
		// collide across phases, so pin an injectable colorizer (same pattern as
		// the compact renderer tests) before asserting the per-tick render.
		set_gradient_colorizer((rgb, text) => `C${rgb[0]},${rgb[1]},${rgb[2]}:${text}`);
		try {
			// Advance the shared clock phase by half a sweep so the gradient
			// verb text deterministically differs from the bake above.
			performance.now = () => base + 800;
			dispatch_gradient_tick();
			// The group tick re-baked a changed gradient frame -> exactly one
			// render request.
			expect(sink.n).toBe(1);

			getSharedRenderer().resetForSession();
			sink.n = 0;
			dispatch_gradient_tick();
			// No subscribers survive resetForSession: the same dispatch requests
			// no render.
			expect(sink.n).toBe(0);
			expect(gradient_clock_is_idle()).toBe(true);
		} finally {
			performance.now = original_now;
		}
	});
});

// ---------------------------------------------------------------------------
// Queued native-render cancellation across session replacement
//
// Every queued render path is observed through the patched requestTuiRender:
// - the visual debounce (holdToolLane -> refreshGroupVisual ->
//   debouncedGroupRenderRequest, generation-guarded);
// - the group invalidation (clearGroupThinkingChild -> freezeGroup ->
//   scheduleGroupInvalidation, pending-set-guarded);
// - the record-shrink snap (scheduleRecordShrinkSnap, generation-guarded).
// After resetForSession all stale microtasks must emit ZERO renders; without
// reset the same paths DO render.
// ---------------------------------------------------------------------------

function queue_every_render_path(renderer: {
	renderCall(name: string, args: unknown, theme: unknown, ctx: unknown): unknown;
	renderResult(
		name: string,
		args: unknown,
		result: unknown,
		options: unknown,
		theme: unknown,
		ctx: unknown,
	): unknown;
	holdToolLane(): void;
	clearGroupThinkingChild(): void;
}): void {
	const theme = make_theme() as never;
	const state: Record<string, any> = {};
	const ctx = { args: {}, toolCallId: "g1", invalidate: () => {}, state };
	renderer.renderCall("read", { path: "a.ts" }, theme, ctx as never);
	renderer.renderResult(
		"read",
		{ path: "a.ts" },
		{ content: [{ type: "text", text: "a" }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...ctx, isError: false } as never,
	);
	setThinkingBlocksHidden(true);
	// (a) visual debounce -> debouncedGroupRenderRequest (generation-guarded)
	renderer.holdToolLane();
	// (b) group invalidation -> scheduleGroupInvalidation (pending-set-guarded)
	renderer.clearGroupThinkingChild();
	// (c) record-shrink snap -> scheduleRecordShrinkSnap (generation-guarded),
	// seeded via the private path like the renderer's own shrink flow does.
	(renderer as unknown as { scheduleRecordShrinkSnap(record: { pendingShrink: boolean }): void })
		.scheduleRecordShrinkSnap({ pendingShrink: true });
}

describe("queued native renders across session replacement", () => {
	test("resetForSession cancels every queued render (generation guard + pending-set clear)", async () => {
		await with_render_sink(async (calls) => {
			const { CompactRenderer } = await import("../renderer.ts");
			const r = new CompactRenderer();
			queue_every_render_path(r);

			// Session replacement happens synchronously BEFORE any microtask runs.
			r.resetForSession();
			await drain();

			// Zero native renders: the generation guard cancels the debounce and
			// record-shrink microtasks, and the pending-invalidation-set clear
			// cancels the group invalidation microtask. If the renderGeneration
			// guard were removed, the stale microtasks would call requestTuiRender
			// and this assertion fails.
			expect(calls.length).toBe(0);
			expect(gradient_clock_is_idle()).toBe(true);
		});
	});

	test("the same queued paths render without session replacement (control)", async () => {
		await with_render_sink(async (calls) => {
			const { CompactRenderer } = await import("../renderer.ts");
			const r = new CompactRenderer();
			queue_every_render_path(r);

			await drain();

			// The harness is live: without resetForSession the queued paths DO
			// issue native renders, so the zero assertion above is meaningful.
			expect(calls.length).toBeGreaterThan(0);
		});
	});
});
