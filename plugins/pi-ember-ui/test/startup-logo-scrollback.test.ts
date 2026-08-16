import { afterEach, describe, expect, test } from "bun:test";
import { Container, Text, TUI } from "@earendil-works/pi-tui";
import piEmberUiPlugin, { startup_logo_should_animate } from "../index.ts";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import { gradient_clock_is_idle, shutdown_gradient_clock } from "../gradient.ts";

/**
 * Scrollback-safety regression tests for the startup logo.
 *
 * Root cause of "after long sessions, one scroll-wheel tick or selecting text
 * snaps the Pi TUI to the top": the ember logo header lives at line 0 of the
 * TUI buffer. Animating it at the shared 20 FPS cadence changes line 0 every
 * tick, and pi-tui's differential renderer issues a scrollback-clearing full
 * redraw (`\x1b[2J` + `\x1b[H` + `\x1b[3J`) whenever the first changed line
 * sits above the previous viewport top. On a resumed/reloaded long session
 * the viewport is far below line 0, so every logo tick snaps the terminal to
 * the top and wipes the user's scrollback.
 *
 * Ember never owns scroll. The fix is to animate line 0 ONLY on the empty
 * first startup screen; every resumed/non-empty session renders the header
 * statically, so no plugin-owned render loop can ever touch a line above the
 * live viewport. These tests pin the decision, the subscription lifecycle,
 * and the TUI-level mechanism.
 */

describe("startup logo decision (SSOT helper)", () => {
	test("animates only on the empty first startup screen", () => {
		expect(startup_logo_should_animate("startup", false)).toBe(true);
		// Startup that restored a session (crash recovery): static.
		expect(startup_logo_should_animate("startup", true)).toBe(false);
		// Resumed/reloaded/forked/new sessions are never animated, even when
		// the transcript is empty.
		for (const reason of ["resume", "new", "fork", "reload"] as const) {
			expect(startup_logo_should_animate(reason, false)).toBe(false);
			expect(startup_logo_should_animate(reason, true)).toBe(false);
		}
		expect(startup_logo_should_animate(undefined, false)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Fake pi bus (same registration order as plugins/index.ts) so the REAL
// session_start handler drives the logo decision and gradient clock.
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => any;

function makeUi(): Record<string, unknown> {
	const widgets: Record<string, unknown> = {};
	const base: Record<string, unknown> = {
		widgets,
		mode: "tui",
		setWidget(name: string, factory?: (tui: unknown, theme: unknown) => unknown): void {
			if (factory) widgets[name] = factory({ requestRender() {}, invalidate() {} }, { fg: () => "" });
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

function makeCtx(extra: Record<string, unknown> = {}): Record<string, unknown> {
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
		...extra,
	};
}

function installPlugins(): { handlers: Record<string, Handler[]> } {
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
	piEmberUiPlugin(pi as never);
	return { handlers };
}

function fire(handlers: Record<string, Handler[]>, name: string, event: any, ctx: any): void {
	for (const h of handlers[name] ?? []) h(event, ctx);
}

afterEach(() => {
	shutdown_gradient_clock();
	getSharedRenderer().resetForSession();
});

describe("startup logo subscription lifecycle (real session_start handler)", () => {
	test("resumed long session: logo never subscribes the gradient clock", () => {
		const { handlers } = installPlugins();
		const base_ctx = makeCtx();
		const ctx = makeCtx({
			sessionManager: {
				...base_ctx.sessionManager,
				getEntries: () => [
					{ type: "message", id: "old1", message: { role: "user", content: [] } },
					{
						type: "message",
						id: "old2",
						message: {
							role: "assistant",
							content: [],
							usage: { cost: { total: 0 }, input: 0, output: 0, reasoning: 0 },
						},
					},
				],
			},
		});
		expect(gradient_clock_is_idle()).toBe(true);
		fire(handlers, "session_start", { reason: "resume" }, ctx);
		// No logo tick, no thinking reasons: the shared clock stays idle. A
		// live clock over a long transcript would repaint line 0 at 20 FPS and
		// force scrollback-clearing full redraws.
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("startup with a restored transcript: logo stays static", () => {
		const { handlers } = installPlugins();
		const base_ctx = makeCtx();
		const ctx = makeCtx({
			sessionManager: {
				...base_ctx.sessionManager,
				getEntries: () => [
					{ type: "message", id: "old", message: { role: "user", content: [] } },
				],
			},
		});
		fire(handlers, "session_start", { reason: "startup" }, ctx);
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("empty startup screen only: logo subscribes, then agent_settled stops it", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		fire(handlers, "session_start", { reason: "startup" }, ctx);
		// The empty first screen is the one legitimate animated state; the
		// logo tick keeps the shared clock live until a boundary stops it.
		expect(gradient_clock_is_idle()).toBe(false);

		fire(handlers, "agent_settled", {}, ctx);
		// agent_settled drops the logo tick and all animation reasons: no
		// plugin-owned render loop survives a settled agent.
		expect(gradient_clock_is_idle()).toBe(true);
	});

	test("session_shutdown always returns the clock to idle", () => {
		const { handlers } = installPlugins();
		const ctx = makeCtx();
		fire(handlers, "session_start", { reason: "startup" }, ctx);
		expect(gradient_clock_is_idle()).toBe(false);
		fire(handlers, "session_shutdown", { reason: "quit" }, ctx);
		expect(gradient_clock_is_idle()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TUI-level mechanism: changing line 0 above a long transcript forces the
// scrollback-clearing full redraw; a static top-of-buffer header does not.
// ---------------------------------------------------------------------------

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTerminal {
	buffer = "";
	readonly columns = 120;
	readonly rows = 40;
	readonly kittyProtocolActive = false;
	write(data: string): void {
		this.buffer += data;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function make_tui(header: { render(width: number): string[] }, transcript_lines: number): {
	term: FakeTerminal;
	tui: TUI;
} {
	const term = new FakeTerminal();
	const tui = new TUI(term, false);
	const header_container = new Container();
	header_container.addChild({ render: header.render, invalidate: () => {} } as never);
	const chat = new Container();
	for (let i = 0; i < transcript_lines; i++) chat.addChild(new Text(`line ${i}`, 1, 0));
	tui.addChild(header_container);
	tui.addChild(chat);
	return { term, tui };
}

describe("TUI-level scrollback safety", () => {
	test("animated line-0 header over a long transcript clears scrollback (the snap)", async () => {
		let frame = 0;
		const { term, tui } = make_tui(
			{
				render(): string[] {
					// Simulates the animated logo: line 0 changes every frame.
					return [`frame ${frame++}`, "logo 1", "logo 2", "logo 3"];
				},
			},
			220,
		);
		tui.requestRender();
		await wait(80);
		term.buffer = "";
		tui.requestRender();
		await wait(80);
		// Any line-0 change above the bottom-anchored viewport forces
		// fullRender(true): clear screen + home + clear scrollback.
		expect(term.buffer).toContain("\x1b[3J");
		expect(term.buffer).toContain("\x1b[2J");
	});

	test("static top-of-buffer header never clears scrollback", async () => {
		const { term, tui } = make_tui(
			{
				render(): string[] {
					// Byte-identical rows every frame — the resumed/static logo.
					return ["logo 0", "logo 1", "logo 2", "logo 3"];
				},
			},
			220,
		);
		tui.requestRender();
		await wait(80);
		term.buffer = "";
		tui.requestRender();
		await wait(80);
		expect(term.buffer).not.toContain("\x1b[3J");
		expect(term.buffer).not.toContain("\x1b[2J");
	});
});
