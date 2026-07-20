import {
	decodeKittyPrintable,
	isKeyRelease,
	Key,
	matchesKey,
	parseKey,
	Editor,
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

/** Optional callback installed from pi-ember-ui for render/footer refresh. */
let on_shell_sync: (() => void) | undefined;

/** Install a callback fired after a successful history→shell conversion. */
export function set_shell_sync_callback(fn: (() => void) | undefined): void {
	on_shell_sync = fn;
}

/** Reentrancy guard for the setTextInternal patch. */
let suppress_shell_history_sync = 0;

/** Run a function with the setTextInternal shell-history sync temporarily suppressed.
 *  Used when Pi submits a bang-prefixed bash command so the submit `!` is not stripped.
 */
export function with_suppressed_shell_history_sync<T>(fn: () => T): T {
	suppress_shell_history_sync++;
	try {
		return fn();
	} finally {
		suppress_shell_history_sync--;
	}
}

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
 * Inspect the editor text and activate shell mode when it begins with one or
 * more `!` characters (Pi bash command prefix). The leading bangs are removed
 * from the editor body; the shell prompt glyph (`!`) and muted border are then
 * rendered by `render_shell_aware_editor` because `isShellMode()` is true.
 *
 * This is the SSOT path for restoring a bash command from editor history
 * (up/down arrows) without the literal `!` stuck next to the command text.
 * It is safe to call after every editor input: if the text does not start
 * with `!`, it is a no-op.
 *
 * Typed `!` on an empty editor is consumed by `process_shell_input` before the
 * `!` reaches the buffer, so any leading `!` seen here is either a paste or a
 * history restore and should always become shell mode.
 *
 * Returns true when shell mode was entered and/or the text was rewritten.
 */
function compute_shell_body(raw: string): { newText: string; changed: boolean } {
	const trimmedStart = raw.trimStart();
	if (!trimmedStart.startsWith("!")) {
		return { newText: raw, changed: false };
	}

	const leadingWhitespace = raw.slice(0, raw.length - trimmedStart.length);
	let body = trimmedStart;
	while (body.startsWith("!")) {
		body = body.slice(1);
	}
	const trailingWhitespaceMatch = body.match(/(\s*)$/);
	const trailingWhitespace = trailingWhitespaceMatch ? trailingWhitespaceMatch[1] : "";
	const bodyCore = body.trimEnd();

	const newText = `${leadingWhitespace}${bodyCore}${trailingWhitespace}`;
	return { newText, changed: newText !== raw || !isShellMode() };
}

/**
 * Inspect the editor text and activate shell mode when it begins with one or
 * more `!` characters (Pi bash command prefix). The leading bangs are removed
 * from the editor body; the shell prompt glyph (`!`) and muted border are then
 * rendered by `render_shell_aware_editor` because `isShellMode()` is true.
 *
 * This is the SSOT path for restoring a bash command from editor history
 * (up/down arrows) without the literal `!` stuck next to the command text.
 * It is safe to call after every editor input: if the text does not start
 * with `!`, it is a no-op.
 *
 * Typed `!` on an empty editor is consumed by `process_shell_input` before the
 * `!` reaches the buffer, so any leading `!` seen here is either a paste or a
 * history restore and should always become shell mode.
 *
 * Returns true when shell mode was entered and/or the text was rewritten.
 */
export function sync_shell_mode_from_editor_text(editor: ShellModeEditor): boolean {
	const raw = editor.getText?.() ?? "";
	const { newText, changed } = compute_shell_body(raw);
	if (!changed) return false;

	setShellMode(true);
	editor.setText?.(newText);
	return true;
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
		// Suppress the setTextInternal shell-history sync while we write the
		// submit text, otherwise the re-entry would strip the leading `!` that
		// Pi's onSubmit needs to identify a bash command.
		with_suppressed_shell_history_sync(() => editor.setText?.(`!${text}`));
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

const SHELL_HISTORY_SYNC_PATCH_MARKER = Symbol.for("pi-ember-ui:shell-history-sync-patched");

/**
 * Patch `Editor.prototype.setTextInternal` (used by `navigateHistory`) so any
 * bang-prefixed history restore is automatically converted into shell mode.
 * This is the most reliable path because up/down arrows write text directly
 * without necessarily traversing our editor `handleInput` wrappers.
 *
 * The patch is guarded by:
 * - a once-only marker symbol
 * - a suppression counter for intentional bang-prefixed writes (submit)
 * - a per-call recursion guard via `syncInProgress`
 */
export function install_shell_history_sync_patch(): void {
	const proto = (Editor as any).prototype as { setTextInternal?: (...args: any[]) => void };
	if (!proto.setTextInternal) return;
	if ((proto as any)[SHELL_HISTORY_SYNC_PATCH_MARKER]) return;
	(proto as any)[SHELL_HISTORY_SYNC_PATCH_MARKER] = true;

	const originalSetTextInternal = proto.setTextInternal;

	proto.setTextInternal = function setTextInternalPatched(this: any, text: string, ...rest: any[]): any {
		let syncInProgress = false;
		const doSync = () => {
			if (syncInProgress) return;
			if (suppress_shell_history_sync > 0) return;
			if (this === undefined) return;
			syncInProgress = true;
			try {
				const { newText, changed } = compute_shell_body(text);
				if (!changed) return;
				setShellMode(true);
				// Rewrite without resetting history browsing state. Prefer the
				// patched setTextInternal if available; fall back to setText.
				if (typeof originalSetTextInternal === "function" && typeof this.setTextInternal === "function") {
					// Avoid recursion by re-entering our own patched method; call the
					// stored original directly. restore cursor at end like navigateHistory.
					originalSetTextInternal.call(this, newText, "end");
				} else {
					this.setText?.(newText);
				}
				on_shell_sync?.();
			} finally {
				syncInProgress = false;
			}
		};

		const result = originalSetTextInternal.call(this, text, ...rest);
		// Defer the conversion until after the editor state has been updated,
		// then inspect and rewrite if needed. Skip the deferred sync when the
		// caller is intentionally suppressing (e.g. submit-time `!` prefix), so
		// we don't rewrite the editor after `submitValue()` has already cleared it.
		if (suppress_shell_history_sync === 0) {
			queueMicrotask(doSync);
		}
		return result;
	};
}
