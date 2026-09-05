import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { compressAttachment } from "./compress.ts";
import { describeReject, replaceImagePathsInText } from "./image-utils.ts";
import { readClipboardImage } from "./clipboard.ts";
import type { AttachmentStore } from "./store.ts";
import {
	format_image_styled_editor_placeholder,
	IMAGE_PLACEHOLDER_PATTERN,
	IMAGE_PLACEHOLDER_PREFIX,
} from "./types.ts";
import { request_render } from "../pi-ember-ui/render-intent.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * Max length of a single non-bracketed input chunk that may continue an
 * image path. Bracketed pastes are handled by `handleBracketedPaste` and
 * never reach `transformPastedPathAlreadyInEditor`; this guard stops the
 * per-chunk full-text rescan during non-bracketed fast pastes while still
 * detecting a path being typed character by character.
 */
const MAX_SINGLE_PATH_CHUNK_LEN = 256;

export class EmberImagesEditor extends CustomEditor {
	private emberPasteBuffer: string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly options: {
			cwd: string;
			store: AttachmentStore;
			notify: (message: string) => void;
		},
	) {
		super(tui, theme, keybindings);
		this.onPasteImage = () => this.pasteClipboardImage();
	}

	override insertTextAtCursor(text: string): void {
		const transformed = this.transform(text);
		super.insertTextAtCursor(transformed.replaced > 0 ? transformed.text : text);
	}

	override handleInput(data: string): void {
		if (this.handleBracketedPaste(data)) return;
		super.handleInput(data);
		this.transformPastedPathAlreadyInEditor(data);
	}

	private transformPastedPathAlreadyInEditor(data: string): void {
		// Only revisit when the current input chunk is plausibly contributing
		// to a file path. Large paste chunks and ordinary keystrokes outside a
		// path token skip the full-text rescan entirely — scanning the whole
		// editor per character froze the TUI on large non-bracketed pastes
		// (tokenize + synchronous fs probes per path-like token). The scan
		// budget in `replaceImagePathsInText` bounds the actual transform; this
		// gate just avoids the getText() walk.
		if (data.length === 0 || data.length > MAX_SINGLE_PATH_CHUNK_LEN) return;
		const carriesPathChar =
			data.includes("/") || data.includes("\\") || data.includes(":");
		if (!carriesPathChar && (data.length !== 1 || !this.isTypingPathTail())) return;
		const text = this.getText();
		if (text.length === 0) return;
		const transformed = this.transform(text);
		if (transformed.replaced === 0 || transformed.text === text) return;
		super.setText(transformed.text);
		request_render();
	}

	/** True when the cursor sits inside a token that already looks like a path.
	 *  Bounded to the current line — never a whole-text scan. Lets a typed or
	 *  streamed filename/extension complete a path placeholder live.
	 */
	private isTypingPathTail(): boolean {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const col = Math.max(0, Math.min(cursor.col, line.length));
		const beforeCursor = line.slice(0, col);
		let tokenStart = beforeCursor.length;
		for (let index = beforeCursor.length - 1; index >= 0; index--) {
			const ch = beforeCursor[index] ?? "";
			if (/\s/.test(ch) || ch === '"' || ch === "'" || ch === "(" || ch === ")") {
				tokenStart = index + 1;
				break;
			}
		}
		const token = beforeCursor.slice(tokenStart);
		if (token.length === 0) return false;
		return (
			token.includes("/") ||
			token.includes("\\") ||
			token.includes(":") ||
			token.startsWith("~/") ||
			token.startsWith("./") ||
			token.startsWith("../")
		);
	}

	private async pasteClipboardImage(): Promise<void> {
		const result = await readClipboardImage();
		if (!result.ok) {
			if (result.reason !== "empty" && result.reason !== "unsupported-platform") {
				const detail = result.reason === "timed-out" ? "timed out" : result.reason;
				this.options.notify(`Clipboard image could not be attached (${detail}).`);
			}
			return;
		}
		const attachment = this.options.store.add(result.image);
		void compressAttachment(attachment);
		super.insertTextAtCursor(attachment.placeholder);
		request_render();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const pattern = new RegExp(IMAGE_PLACEHOLDER_PATTERN.source, IMAGE_PLACEHOLDER_PATTERN.flags);
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (!line?.includes(IMAGE_PLACEHOLDER_PREFIX)) continue;
			lines[index] = line.replace(pattern, (match) => {
				const id = Number.parseInt(match.match(/\d+/)?.[0] ?? "0", 10);
				return format_image_styled_editor_placeholder(id);
			});
		}
		return lines;
	}

	private transform(text: string): { text: string; replaced: number } {
		const transformed = replaceImagePathsInText(text, {
			cwd: this.options.cwd,
			store: this.options.store,
			onReject: (result) => describeReject(result, this.options.notify),
		});
		return { text: transformed.text, replaced: transformed.replaced };
	}

	private handleBracketedPaste(data: string): boolean {
		let prefix = "";
		const original = data;
		const wasBuffered = this.emberPasteBuffer !== undefined;

		if (this.emberPasteBuffer === undefined) {
			const start = data.indexOf(PASTE_START);
			if (start < 0) return false;
			prefix = data.slice(0, start);
			this.emberPasteBuffer = data.slice(start + PASTE_START.length);
			if (!this.emberPasteBuffer.includes(PASTE_END)) {
				if (prefix) super.handleInput(prefix);
				return true;
			}
		} else {
			this.emberPasteBuffer += data;
			if (!this.emberPasteBuffer.includes(PASTE_END)) return true;
		}

		const end = this.emberPasteBuffer.indexOf(PASTE_END);
		const content = this.emberPasteBuffer.slice(0, end);
		const remaining = this.emberPasteBuffer.slice(end + PASTE_END.length);
		this.emberPasteBuffer = undefined;
		const transformed = this.transform(content);
		if (transformed.replaced === 0) {
			super.handleInput(
				wasBuffered ? `${PASTE_START}${content}${PASTE_END}${remaining}` : original,
			);
			return true;
		}

		if (prefix) super.handleInput(prefix);
		super.insertTextAtCursor(transformed.text);
		if (remaining) super.handleInput(remaining);
		return true;
	}
}
