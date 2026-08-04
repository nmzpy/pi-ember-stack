import { afterEach, describe, expect, test } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TUI } from "@earendil-works/pi-tui";
import {
	install_header_persistence_patch,
	is_ember_header_active,
	reset_header_persistence_for_tests,
	set_active_ember_header_factory,
	set_active_ember_header_factory_for_tests,
	type EmberHeaderFactory,
} from "../header-persistence.ts";

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

/** A fixed ember-style header factory: tall logo header at the top of the buffer. */
function make_ember_factory(label: string): EmberHeaderFactory {
	return () => ({
		render(width: number): string[] {
			return ["logo 0", "logo 1", "logo 2", "logo 3", "logo 4", "logo 5", "logo 6", label];
		},
		invalidate(): void {},
	});
}

const built_in_header = (): Text => new Text("builtin", 1, 0);

function make_interactive_like(
	ui: TUI,
	built_in: Text,
): {
	builtInHeader: Text;
	customHeader: unknown;
	headerContainer: Container;
	ui: TUI;
	toolOutputExpanded: boolean;
} {
	const headerContainer = new Container();
	headerContainer.addChild(new Spacer(1));
	headerContainer.addChild(built_in);
	headerContainer.addChild(new Spacer(1));
	return {
		builtInHeader: built_in,
		customHeader: undefined,
		headerContainer,
		ui,
		toolOutputExpanded: false,
	};
}

/** The patched setExtensionHeader (installed once by the module under test). */
function patched_set_extension_header(): (factory?: unknown) => void {
	const proto = InteractiveMode.prototype as unknown as {
		setExtensionHeader: (factory?: unknown) => void;
	};
	return proto.setExtensionHeader;
}

afterEach(() => {
	reset_header_persistence_for_tests();
});

describe("ember header persistence patch", () => {
	test("skips Pi's built-in header restore while the ember header is active", () => {
		install_header_persistence_patch();
		const ember_factory = make_ember_factory("model • dir");
		set_active_ember_header_factory(ember_factory);
		expect(is_ember_header_active()).toBe(true);

		const term = new FakeTerminal();
		const tui = new TUI(term, false);
		const fake = make_interactive_like(tui, built_in_header());
		// A pre-existing custom header (the ember one) is live.
		const live = ember_factory(tui, undefined);
		fake.customHeader = live;
		fake.headerContainer.children[1] = live as never;

		patched_set_extension_header().call(fake as never, undefined);

		// The teardown restore was skipped: the ember header stays live.
		expect(fake.customHeader).toBe(live);
		expect(fake.headerContainer.children[1]).toBe(live);
	});

	test("delegates the restore when the ember header is not active", () => {
		install_header_persistence_patch();
		set_active_ember_header_factory_for_tests(undefined);

		const term = new FakeTerminal();
		const tui = new TUI(term, false);
		const fake = make_interactive_like(tui, built_in_header());

		patched_set_extension_header().call(fake as never, undefined);

		// Delegated: the built-in header is restored (customHeader cleared).
		expect(fake.customHeader).toBeUndefined();
		expect(fake.headerContainer.children).toContain(fake.builtInHeader);
	});

	test("clears the active marker when another extension installs its own header", () => {
		install_header_persistence_patch();
		const ember_factory = make_ember_factory("a");
		set_active_ember_header_factory(ember_factory);

		const term = new FakeTerminal();
		const tui = new TUI(term, false);
		const fake = make_interactive_like(tui, built_in_header());
		const other_factory = () => ({ render: () => ["other"], invalidate: () => {} });

		patched_set_extension_header().call(fake as never, other_factory);

		expect(fake.customHeader).toBeDefined();
		expect(fake.customHeader).not.toBe(ember_factory(tui, undefined));
		expect(is_ember_header_active()).toBe(false);
	});
});

describe("ember header persistence keeps terminal scrollback (TUI level)", () => {
	test("session teardown + startup header re-install emit no scrollback clear", async () => {
		install_header_persistence_patch();
		const term = new FakeTerminal();
		const tui = new TUI(term, false);
		const built_in = built_in_header();
		const fake = make_interactive_like(tui, built_in);
		const set_header = patched_set_extension_header().bind(fake as never);

		const chat = new Container();
		const editorContainer = new Container();
		editorContainer.addChild(new Text("> ", 1, 0));
		const footer = new Text("footer", 1, 0);
		tui.addChild(fake.headerContainer);
		tui.addChild(chat);
		tui.addChild(editorContainer);
		tui.addChild(footer);

		// Long session: 220 transcript rows keep the viewport far from the top.
		for (let i = 0; i < 220; i++) chat.addChild(new Text(`line ${i}`, 1, 0));

		// First session startup: install the ember header.
		const ember_factory = make_ember_factory("model • dir");
		set_active_ember_header_factory(ember_factory);
		set_header(ember_factory);
		tui.requestRender();
		await wait(80);

		// --- session_shutdown: Pi's resetExtensionUI restores the header ---
		term.buffer = "";
		set_header(undefined);
		expect((fake as { customHeader?: unknown }).customHeader).toBeDefined();
		tui.requestRender();
		await wait(80);
		expect(term.buffer).not.toContain("\x1b[3J");
		expect(term.buffer).not.toContain("\x1b[2J");

		// --- resumed session rebuild (shorter transcript) ---
		term.buffer = "";
		chat.clear();
		for (let i = 0; i < 30; i++) chat.addChild(new Text(`line ${i}`, 1, 0));
		tui.requestRender();
		await wait(80);

		// --- session_start: re-install the ember header (identical rows) ---
		term.buffer = "";
		set_header(make_ember_factory("model • dir"));
		tui.requestRender();
		await wait(80);
		expect(term.buffer).not.toContain("\x1b[3J");
		expect(term.buffer).not.toContain("\x1b[2J");
	});

	test("without the ember header the teardown restore still delegates (old behavior)", async () => {
		install_header_persistence_patch();
		reset_header_persistence_for_tests();
		const term = new FakeTerminal();
		const tui = new TUI(term, false);
		const built_in = built_in_header();
		const fake = make_interactive_like(tui, built_in);
		const set_header = patched_set_extension_header().bind(fake as never);

		const chat = new Container();
		tui.addChild(fake.headerContainer);
		tui.addChild(chat);
		for (let i = 0; i < 220; i++) chat.addChild(new Text(`line ${i}`, 1, 0));
		tui.requestRender();
		await wait(80);

		term.buffer = "";
		set_header(undefined);
		expect((fake as { customHeader?: unknown }).customHeader).toBeUndefined();
		tui.requestRender();
		await wait(80);
		// pi-tui's own shrink/first-changed logic may clear; the point is the
		// patch did NOT suppress the delegate: the built-in header is restored.
		expect(fake.headerContainer.children).toContain(built_in);
	});
});
