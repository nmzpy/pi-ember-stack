import { Key, matchesKey } from "@earendil-works/pi-tui";
import { isShellMode, setShellMode } from "./mode-colors.ts";

export type ShellModeEditor = {
	getText?: () => string;
	setText?: (text: string) => void;
};

/**
 * Intercept keystrokes for shell mode ('!' prefix on empty input).
 * Returns true when the keystroke is consumed (caller must NOT pass it
 * to the editor's original handleInput); false to let it fall through.
 *
 * Enter submits: the editor text is prefixed with '!' so Pi's built-in
 * onSubmit bash handler (interactive-mode.js, text.startsWith("!"))
 * picks it up and runs the command through the normal bash pipeline.
 */
export function intercept_shell_input(data: string, editor: ShellModeEditor): boolean {
	if (matchesKey(data, "!")) {
		if ((editor.getText?.() ?? "").length === 0) {
			setShellMode(true);
			return true;
		}
	}

	if (!isShellMode()) return false;

	if (matchesKey(data, "escape")) {
		setShellMode(false);
		editor.setText?.("");
		return true;
	}

	if (matchesKey(data, "backspace")) {
		if ((editor.getText?.() ?? "").length === 0) {
			setShellMode(false);
			return true;
		}
	}

	if (matchesKey(data, Key.enter)) {
		const text = (editor.getText?.() ?? "").trim();
		if (text.length === 0) {
			setShellMode(false);
			editor.setText?.("");
			return true;
		}
		editor.setText?.(`!${text}`);
		setShellMode(false);
		return false;
	}

	return false;
}
