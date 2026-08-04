import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { readClipboardImage } from "./clipboard.ts";
import { describeReject, replaceImagePathsInText } from "./image-utils.ts";
import type { AttachmentStore } from "./store.ts";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

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
		const text = this.getText();
		const mayContainPath = data.length > 1 || text.includes("\\") || text.includes("/");
		if (!mayContainPath) return;
		const transformed = this.transform(text);
		if (transformed.replaced === 0 || transformed.text === text) return;
		super.setText(transformed.text);
		this.tui.requestRender();
	}

	private pasteClipboardImage(): void {
		const result = readClipboardImage();
		if (!result.ok) {
			if (result.reason !== "empty" && result.reason !== "unsupported-platform") {
				this.options.notify(`Clipboard image could not be attached (${result.reason}).`);
			}
			return;
		}
		const attachment = this.options.store.add(result.image);
		super.insertTextAtCursor(attachment.placeholder);
		this.tui.requestRender();
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
