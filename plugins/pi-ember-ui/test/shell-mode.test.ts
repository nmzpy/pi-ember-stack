import { describe, expect, test } from "bun:test";
import { intercept_shell_input } from "../shell-mode.ts";
import { isShellMode, setShellMode } from "../mode-colors.ts";

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

describe("shell mode", () => {
	test("'!' on empty input enters shell mode and eats the '!'", () => {
		setShellMode(false);
		const editor = makeEditor("");
		const consumed = intercept_shell_input(BANG, editor);
		expect(consumed).toBe(true);
		expect(isShellMode()).toBe(true);
		expect(editor.getText()).toBe("");
	});

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

	test("backspace on empty in shell mode exits", () => {
		setShellMode(true);
		const editor = makeEditor("");
		const consumed = intercept_shell_input(BACKSPACE, editor);
		expect(consumed).toBe(true);
		expect(isShellMode()).toBe(false);
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
});
