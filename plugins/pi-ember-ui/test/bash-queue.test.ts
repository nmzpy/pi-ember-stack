import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
	bash_queued_message_count,
	clear_bash_queued_messages,
	drain_bash_queued_messages,
	flush_bash_queue,
	install_bash_queue_input_listener,
	push_bash_queued_message,
	queue_bash_message,
	should_queue_bash_message,
	type BashQueueEditor,
	type BashQueueInteractiveHost,
	type BashQueueTui,
} from "../bash-queue.ts";
import { isUserBashRunning, setUserBashRunning } from "../mode-colors.ts";
import {
	bind_render_intent,
	reset_render_intent,
} from "../render-intent.ts";

function fakeEditor(text = ""): BashQueueEditor & { history: string[]; tuiRenders: number } {
	let current = text;
	const history: string[] = [];
	const tuiRenders: number[] = [];
	return {
		getText: () => current,
		setText: (next) => {
			current = next;
		},
		addToHistory: (entry) => history.push(entry),
		tui: { requestRender: () => tuiRenders.push(1) },
		history,
		tuiRenders,
	};
}

/** Render calls now route through the canonical render-intent module. */
let render_call_count = 0;

function bind_test_render_intent(): void {
	render_call_count = 0;
	bind_render_intent(() => { render_call_count++; });
}

function reset_test_render_intent(): void {
	reset_render_intent();
	render_call_count = 0;
}

function fakeHost(overrides?: Partial<BashQueueInteractiveHost>): BashQueueInteractiveHost {
	return {
		ui: { requestRender: () => {} } as unknown as TUI,
		session: {
			extensionRunner: { emitUserBash: async () => undefined },
			isStreaming: false,
			executeBash: async () => ({
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			}),
			recordBashResult: () => {},
		},
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: { addChild: () => {} },
		pendingMessagesContainer: { addChild: () => {} },
		pendingUserInputs: [],
		...overrides,
	};
}

describe("bash message queue (messages during Running)", () => {
	beforeEach(() => {
		setUserBashRunning(false);
		clear_bash_queued_messages();
		bind_test_render_intent();
	});

	afterEach(() => {
		reset_test_render_intent();
	});

	test("should_queue_bash_message gates on isUserBashRunning", () => {
		expect(should_queue_bash_message("hello")).toBe(false);
		setUserBashRunning(true);
		expect(should_queue_bash_message("hello")).toBe(true);
	});

	test("should_queue_bash_message never queues bang or slash text", () => {
		setUserBashRunning(true);
		expect(should_queue_bash_message("!git status")).toBe(false);
		expect(should_queue_bash_message("!!git status")).toBe(false);
		expect(should_queue_bash_message("/model")).toBe(false);
		expect(should_queue_bash_message("/compact")).toBe(false);
	});

	test("should_queue_bash_message ignores empty text", () => {
		setUserBashRunning(true);
		expect(should_queue_bash_message("")).toBe(false);
		expect(should_queue_bash_message("   ")).toBe(false);
	});

	test("queue_bash_message clears the editor, records history, and queues trimmed text", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("  hello world  ");
		const notified: string[] = [];
		queue_bash_message(editor, (message) => notified.push(message), editor.getText?.() ?? "");
		expect(editor.getText?.()).toBe("");
		expect(editor.history).toEqual(["hello world"]);
		expect(bash_queued_message_count()).toBe(1);
		expect(drain_bash_queued_messages()).toEqual(["hello world"]);
		expect(notified.length).toBe(1);
	});

	test("flush_bash_queue delivers through onInputCallback when the agent loop is awaiting input", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("queued message");
		queue_bash_message(editor, () => {}, editor.getText?.() ?? "");
		queue_bash_message(editor, () => {}, "second message");

		const delivered: string[] = [];
		const host = fakeHost({});
		// Pi's onInputCallback is one-shot: it resolves getUserInput and clears
		// itself, so only the first queued message is delivered that way.
		host.onInputCallback = (text) => {
			delivered.push(text);
			host.onInputCallback = undefined;
		};
		flush_bash_queue(host);

		expect(delivered).toEqual(["queued message"]);
		// onInputCallback is one-shot (Pi's normal submit contract): the
		// remaining message lands in pendingUserInputs for the next loop pass.
		expect(host.pendingUserInputs).toEqual(["second message"]);
		expect(bash_queued_message_count()).toBe(0);
	});

	test("flush_bash_queue falls back to pendingUserInputs when the agent is busy", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("queued message");
		queue_bash_message(editor, () => {}, editor.getText?.() ?? "");

		const host = fakeHost();
		flush_bash_queue(host);
		expect(host.pendingUserInputs).toEqual(["queued message"]);
		expect(bash_queued_message_count()).toBe(0);
	});

	test("flush_bash_queue is a no-op with an empty queue", () => {
		const host = fakeHost();
		flush_bash_queue(host);
		expect(host.pendingUserInputs).toEqual([]);
	});

	test("flush_bash_queue routes render through request_render()", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("queued message");
		queue_bash_message(editor, () => {}, editor.getText?.() ?? "");
		const host = fakeHost();
		const before = render_call_count;
		flush_bash_queue(host);
		expect(render_call_count).toBeGreaterThan(before);
	});

	test("flush_bash_queue does not call host.ui.requestRender directly", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("queued message");
		queue_bash_message(editor, () => {}, editor.getText?.() ?? "");
		let ui_render_called = false;
		const host = fakeHost({
			ui: { requestRender: () => { ui_render_called = true; } } as unknown as TUI,
		});
		flush_bash_queue(host);
		expect(ui_render_called).toBe(false);
		expect(render_call_count).toBeGreaterThanOrEqual(1);
	});
});

describe("bash queue TUI input listener", () => {
	beforeEach(() => {
		setUserBashRunning(false);
		clear_bash_queued_messages();
		bind_test_render_intent();
	});

	afterEach(() => {
		reset_test_render_intent();
	});

	function installWithFakeTui(editor: BashQueueEditor) {
		let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const tui: BashQueueTui = {
			focusedComponent: editor,
			hasOverlay: () => false,
			addInputListener: (l) => {
				listener = l;
				return () => {
					listener = undefined;
				};
			},
		};
		const notified: string[] = [];
		const unsubscribe = install_bash_queue_input_listener(
			() => tui,
			(message) => notified.push(message),
		);
		return { tui, listener: () => listener, notified, unsubscribe };
	}

	test("submit on a plain message while running queues it and consumes the key", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("do the thing");
		const { listener, notified } = installWithFakeTui(editor);

		const result = listener?.()("\r");
		expect(result?.consume).toBe(true);
		expect(editor.getText?.()).toBe("");
		expect(bash_queued_message_count()).toBe(1);
		expect(notified[0]).toContain("Queued message");
	});

	test("submit on a plain message routes render through request_render()", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("do the thing");
		const { listener } = installWithFakeTui(editor);
		const before = render_call_count;
		listener?.()("\r");
		expect(render_call_count).toBeGreaterThan(before);
	});

	test("bang and slash submits pass through while running", () => {
		setUserBashRunning(true);
		for (const text of ["!git status", "/model"]) {
			const editor = fakeEditor(text);
			const { listener } = installWithFakeTui(editor);
			const result = listener?.()("\r");
			expect(result).toBeUndefined();
			expect(editor.getText?.()).toBe(text);
		}
		expect(bash_queued_message_count()).toBe(0);
	});

	test("non-submit keys pass through", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("typing...");
		const { listener } = installWithFakeTui(editor);
		expect(listener?.()("a")).toBeUndefined();
		expect(listener?.()("\t")).toBeUndefined();
		expect(bash_queued_message_count()).toBe(0);
	});

	test("no queueing when bash is not running", () => {
		const editor = fakeEditor("normal message");
		const { listener } = installWithFakeTui(editor);
		expect(listener?.()("\r")).toBeUndefined();
		expect(bash_queued_message_count()).toBe(0);
	});

	test("no queueing when an overlay is focused", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("message");
		let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const tui: BashQueueTui = {
			focusedComponent: editor,
			hasOverlay: () => true,
			addInputListener: (l) => {
				listener = l;
				return () => {};
			},
		};
		install_bash_queue_input_listener(() => tui, () => {});
		expect(listener?.("\r")).toBeUndefined();
		expect(bash_queued_message_count()).toBe(0);
	});

	test("unsubscribe removes the listener", () => {
		setUserBashRunning(true);
		const editor = fakeEditor("message");
		const { listener, unsubscribe } = installWithFakeTui(editor);
		unsubscribe();
		expect(listener?.("\r")).toBeUndefined();
	});

	test("isUserBashRunning flag stays in sync", () => {
		expect(isUserBashRunning()).toBe(false);
		setUserBashRunning(true);
		expect(isUserBashRunning()).toBe(true);
	});
});
