import {
	decodeKittyPrintable,
	isKeyRelease,
	Key,
	matchesKey,
	parseKey,
} from "@earendil-works/pi-tui";
import { isShellMode, setShellMode } from "./mode-colors.ts";

export type ShellModeEditor = {
	getText?: () => string;
	setText?: (text: string) => void;
	isEditorEmpty?: () => boolean;
	tui?: { requestRender?: (force?: boolean) => void };
};

export type ShellModeInputResult = {
	consume?: boolean;
	data?: string;
} | undefined;

/**
 * Detect a `!` (Shift+1) keystroke across every terminal encoding using only
 * the public pi-tui key API — the same decoders Pi's own editor uses. This is
 * terminal-agnostic and DRY: no hardcoded CSI sequences.
 *
 * Coverage:
 * - Legacy raw byte (`!`)
 * - Kitty CSI-u shifted-codepoint / base-key-with-alt-keys (`decodeKittyPrintable`)
 * - Kitty CSI-u base-digit-with-shift (Ghostty sends Shift+1 as `\x1b[49;2u`)
 * - xterm modifyOtherKeys (`\x1b[27;<mod>;<code>~`) — not covered by
 *   `decodeKittyPrintable`, resolved via `parseKey` / `matchesKey`
 * - Key-release events (Kitty event-type `:3`) are ignored so a held `!`
 *   does not re-trigger entry.
 */
function is_bang_key(data: string): boolean {
	if (isKeyRelease(data)) return false;
	if (decodeKittyPrintable(data) === "!") return true;
	if (
		matchesKey(data, "!") ||
		matchesKey(data, "shift+!") ||
		matchesKey(data, "shift+1")
	)
		return true;
	const id = parseKey(data);
	return id === "!" || id === "shift+!" || id === "shift+1";
}

function is_editor_empty(editor: ShellModeEditor): boolean {
	if (editor.isEditorEmpty?.()) return true;
	const text = editor.getText?.() ?? "";
	return text.length === 0 || text.trim().length === 0;
}

/**
 * Handle a raw terminal input sequence for shell mode ('!' prefix on empty
 * input). This function is intended to run as a TUI input listener or as an
 * editor handleInput wrapper. It returns an optional result:
 *
 * - `consume: true` means the caller must NOT pass the key to the editor.
 * - `data` is an optional replacement sequence for other listeners.
 *
 * When `consume` is true and the editor text did not change (empty → empty),
 * the caller must request a TUI re-render because Pi's differential renderer
 * will not repaint the chatbox row otherwise. The prompt glyph (`>` ↔ `!`)
 * and border color only update when `render` fires and re-reads `isShellMode()`.
 *
 * Enter submits: the editor text is prefixed with '!' so Pi's built-in
 * onSubmit bash handler (interactive-mode.js, text.startsWith("!"))
 * picks it up and runs the command through the normal bash pipeline.
 */
export function process_shell_input(
	data: string,
	editor: ShellModeEditor,
): ShellModeInputResult {
	if (is_bang_key(data)) {
		if (is_editor_empty(editor)) {
			setShellMode(true);
			// Clear any accidental whitespace from a previous exit state so the
			// prompt is truly empty. Also syncs text in case getText returned a
			// lone newline from prior navigation.
			editor.setText?.("");
			return { consume: true };
		}
	}

	if (!isShellMode()) return undefined;

	if (matchesKey(data, "escape")) {
		setShellMode(false);
		editor.setText?.("");
		return { consume: true };
	}

	if (matchesKey(data, "backspace")) {
		if (is_editor_empty(editor)) {
			setShellMode(false);
			return { consume: true };
		}
	}

	if (matchesKey(data, Key.enter)) {
		const text = (editor.getText?.() ?? "").trim();
		if (text.length === 0) {
			setShellMode(false);
			editor.setText?.("");
			return { consume: true };
		}
		editor.setText?.(`!${text}`);
		setShellMode(false);
		// Let the normal submit run; Pi's own render path repaints after setText.
		return undefined;
	}

	return undefined;
}

/**
 * Legacy editor handleInput wrapper API. Kept for compatibility with the
 * per-instance editor wrap in `pi-custom-agents`. Prefer `process_shell_input`
 * and TUI-level listeners for robust shell entry.
 */
export function intercept_shell_input(data: string, editor: ShellModeEditor): boolean {
	const result = process_shell_input(data, editor);
	if (result?.consume) {
		editor.tui?.requestRender?.(false);
		return true;
	}
	return false;
}
