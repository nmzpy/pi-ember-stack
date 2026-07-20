import { describe, expect, test } from "bun:test";
import { intercept_shell_input, process_shell_input } from "../shell-mode.ts";
import { isShellMode, setShellMode } from "../mode-colors.ts";

function makeEditorWithTui(initialText: string): {
	getText: () => string;
	setText: (t: string) => void;
	isEditorEmpty: () => boolean;
	tui: { requestRenderCalls: boolean[]; requestRender: (force?: boolean) => void };
} {
	const holder = { text: initialText };
	const tui = { requestRenderCalls: [] as boolean[], requestRender(force = false) {
		tui.requestRenderCalls.push(force);
	} };
	return {
		getText: () => holder.text,
		setText: (t: string) => {
			holder.text = t;
		},
		isEditorEmpty: () => holder.text.length === 0,
		tui,
	};
}

function makeEditor(initialText: string): { getText: () => string; setText: (t: string) => void } {
	const holder = { text: initialText };
	return {
		getText: () => holder.text,
		setText: (t: string) => {
			holder.text = t;
		},
	};
}

const ENTER = "\r";
const ESCAPE = "\x1b";
const BANG = "!";
const BACKSPACE = "\x7f";

// Every terminal encoding of `!` (Shift+1) that the detector must resolve.
// `is_bang_key` uses the public pi-tui key API (decodeKittyPrintable +
// matchesKey + parseKey + isKeyRelease) — the same decoders Pi's editor uses.
// Covers legacy raw byte, Kitty CSI-u (all variants), and xterm
// modifyOtherKeys (Ghostty/tmux fallback when Kitty protocol is off).
const BANG_ENCODINGS: Array<[string, string]> = [
	["legacy raw byte", BANG],
	["Kitty shifted-codepoint no mod (\\x1b[33u)", "\x1b[33u"],
	["Kitty shifted-codepoint mod=1 (\\x1b[33;1u)", "\x1b[33;1u"],
	["Kitty shifted-codepoint with shift (\\x1b[33;2u)", "\x1b[33;2u"],
	["Kitty base-key with full alt-keys (\\x1b[49:33:49;2u)", "\x1b[49:33:49;2u"],
	["Kitty base-digit with shift (\\x1b[49;2u)", "\x1b[49;2u"],
	["Kitty base-digit with shift + press event (\\x1b[49;2:1u)", "\x1b[49;2:1u"],
	["xterm modifyOtherKeys shift+! (\\x1b[27;2;33~)", "\x1b[27;2;33~"],
	["xterm modifyOtherKeys no mod (\\x1b[27;1;33~)", "\x1b[27;1;33~"],
	["xterm modifyOtherKeys shift+1 base-digit (\\x1b[27;2;49~)", "\x1b[27;2;49~"],
];

describe("shell mode", () => {
	for (const [label, data] of BANG_ENCODINGS) {
		test(`'!' (${label}) on empty input enters shell mode and eats the '!'`, () => {
			setShellMode(false);
			const editor = makeEditorWithTui("");
			const consumed = intercept_shell_input(data, editor);
			expect(consumed).toBe(true);
			expect(isShellMode()).toBe(true);
			expect(editor.getText()).toBe("");
			expect(editor.tui.requestRenderCalls.length).toBeGreaterThanOrEqual(1);
			expect(editor.tui.requestRenderCalls.every((f) => f === false)).toBe(true);
		});
	}

	test("'!' on non-empty input does not enter shell mode", () => {
		setShellMode(false);
		const editor = makeEditor("hello");
		const consumed = intercept_shell_input(BANG, editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(false);
	});

	test("escape in shell mode exits and clears editor", () => {
		setShellMode(true);
		const editor = makeEditor("ls -la");
		const consumed = intercept_shell_input(ESCAPE, editor);
		expect(consumed).toBe(true);
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("");
	});

	test("escape in shell mode requests a non-forced TUI render", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("ls -la");
		intercept_shell_input(ESCAPE, editor);
		expect(editor.tui.requestRenderCalls.length).toBeGreaterThanOrEqual(1);
		expect(editor.tui.requestRenderCalls.every((f) => f === false)).toBe(true);
	});

	test("backspace on empty in shell mode exits", () => {
		setShellMode(true);
		const editor = makeEditor("");
		const consumed = intercept_shell_input(BACKSPACE, editor);
		expect(consumed).toBe(true);
		expect(isShellMode()).toBe(false);
	});

	test("backspace on empty in shell mode requests a non-forced TUI render", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("");
		intercept_shell_input(BACKSPACE, editor);
		expect(editor.tui.requestRenderCalls.length).toBeGreaterThanOrEqual(1);
		expect(editor.tui.requestRenderCalls.every((f) => f === false)).toBe(true);
	});

	test("backspace on non-empty in shell mode falls through", () => {
		setShellMode(true);
		const editor = makeEditor("ls");
		const consumed = intercept_shell_input(BACKSPACE, editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(true);
	});

	test("enter with command prepends '!' and exits shell mode (falls through to submit)", () => {
		setShellMode(true);
		const editor = makeEditor("git status");
		const consumed = intercept_shell_input(ENTER, editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("!git status");
	});

	test("enter with empty command exits shell mode and clears editor", () => {
		setShellMode(true);
		const editor = makeEditor("   ");
		const consumed = intercept_shell_input(ENTER, editor);
		expect(consumed).toBe(true);
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("");
	});

	test("enter with empty command in shell mode requests a non-forced TUI render", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("   ");
		intercept_shell_input(ENTER, editor);
		expect(editor.tui.requestRenderCalls.length).toBeGreaterThanOrEqual(1);
		expect(editor.tui.requestRenderCalls.every((f) => f === false)).toBe(true);
	});

	test("regular key in shell mode falls through", () => {
		setShellMode(true);
		const editor = makeEditor("ls");
		const consumed = intercept_shell_input("a", editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(true);
	});

	test("key when not in shell mode and not '!' falls through", () => {
		setShellMode(false);
		const editor = makeEditor("hello");
		const consumed = intercept_shell_input("a", editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(false);
	});

	test("'1' (digit, not '!') does not enter shell mode", () => {
		setShellMode(false);
		const editor = makeEditor("");
		const consumed = intercept_shell_input("1", editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(false);
	});

	test("'!' key-release event (Kitty event-type :3) does not enter shell mode", () => {
		setShellMode(false);
		const editor = makeEditor("");
		// Kitty CSI-u key-release for shift+1: event-type suffix :3
		const consumed = intercept_shell_input("\x1b[33;2:3u", editor);
		expect(consumed).toBe(false);
		expect(isShellMode()).toBe(false);
	});
});

describe("shell mode input result", () => {
	test("bang on empty editor returns consume=true and clears text", () => {
		setShellMode(false);
		const editor = makeEditorWithTui("");
		const result = process_shell_input(BANG, editor);
		expect(result?.consume).toBe(true);
		expect(isShellMode()).toBe(true);
		expect(editor.getText()).toBe("");
	});

	test("bang on non-empty editor does not consume", () => {
		setShellMode(false);
		const editor = makeEditorWithTui("foo");
		const result = process_shell_input(BANG, editor);
		expect(result?.consume).toBeUndefined();
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("foo");
	});

	test("bang on whitespace-only editor enters shell mode and clears text", () => {
		setShellMode(false);
		const editor = makeEditorWithTui("   ");
		const result = process_shell_input(BANG, editor);
		expect(result?.consume).toBe(true);
		expect(isShellMode()).toBe(true);
		expect(editor.getText()).toBe("");
	});

	test("escape in shell mode consumes and clears", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("pwd");
		const result = process_shell_input(ESCAPE, editor);
		expect(result?.consume).toBe(true);
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("");
	});

	test("empty enter in shell mode consumes and clears", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("  ");
		const result = process_shell_input(ENTER, editor);
		expect(result?.consume).toBe(true);
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("");
	});

	test("non-empty enter in shell mode falls through with '!' prefix", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("git status");
		const result = process_shell_input(ENTER, editor);
		expect(result?.consume).toBeUndefined();
		expect(isShellMode()).toBe(false);
		expect(editor.getText()).toBe("!git status");
	});

	test("regular printable key is not consumed", () => {
		setShellMode(true);
		const editor = makeEditorWithTui("");
		const result = process_shell_input("a", editor);
		expect(result?.consume).toBeUndefined();
		expect(isShellMode()).toBe(true);
	});
});
