/**
 * Pi Ember Images.
 *
 * Image attachment flow adapted from the MIT-licensed pi-paster project:
 * https://github.com/beowulf11/pi-paster
 *
 * Ember owns the integration boundary, placeholder spelling, compact preview
 * sizing, and Windows clipboard backend here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EmberImagesEditor } from "./editor.ts";
import {
	describeReject,
	imagesForText,
	isImageFallbackMode,
	removeImagePlaceholders,
	replaceImagePathsInText,
	replaceImagePlaceholdersWithFallbackLabels,
} from "./image-utils.ts";
import { ImagePreviewMessage } from "./preview.ts";
import { AttachmentStore } from "./store.ts";
import type { ImageAttachment, ImagePreviewDetails } from "./types.ts";

const PREVIEW_MESSAGE_TYPE = "pi-ember-images-preview";

export default function piEmberImagesPlugin(pi: ExtensionAPI): void {
	const store = new AttachmentStore();
	let pendingPreview: ImageAttachment[] = [];
	let activeEditor: EmberImagesEditor | undefined;

	pi.registerMessageRenderer<ImagePreviewDetails>(
		PREVIEW_MESSAGE_TYPE,
		(message, _options, theme) => {
			const placeholders = message.details?.placeholders ?? [];
			const attachments = placeholders
				.map((placeholder) => store.get(placeholder))
				.filter((attachment): attachment is ImageAttachment => attachment !== undefined);
			if (attachments.length === 0) return undefined;
			return new ImagePreviewMessage(attachments, (text) => theme.fg("text", text));
		},
	);

	pi.registerCommand("paste-image", {
		description: "Attach an image from the system clipboard",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/paste-image requires interactive UI.", "error");
				return;
			}
			if (!activeEditor?.onPasteImage) {
				ctx.ui.notify("Image editor is not ready. Try /reload.", "warning");
				return;
			}
			activeEditor.onPasteImage();
		},
	});

	pi.on("session_start", (_event, ctx) => {
		store.clear();
		pendingPreview = [];
		activeEditor = undefined;
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeEditor = new EmberImagesEditor(tui, theme, keybindings, {
				cwd: ctx.cwd,
				store,
				notify: (message) => ctx.ui.notify(message, "warning"),
			});
			return activeEditor;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pendingPreview = [];
		activeEditor = undefined;
		store.clear();
		if (ctx.hasUI) ctx.ui.setEditorComponent(undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const pathTransform = replaceImagePathsInText(event.text, {
			cwd: ctx.cwd,
			store,
			onReject: (result) => describeReject(result, (message) => ctx.ui.notify(message, "warning")),
		});
		const submittedText = pathTransform.text;
		const attachments = store.matchingPlaceholders(submittedText);
		if (attachments.length === 0) return { action: "continue" as const };

		const images = imagesForText(store, submittedText, event.images);
		// Fallback terminals (no supported inline-image protocol): render each
		// image's fallback label inside the originating user-message text area
		// at that transcript position instead of injecting a separate preview
		// message. Native ImageContent is still attached for the model.
		if (isImageFallbackMode()) {
			return {
				action: "transform" as const,
				text: replaceImagePlaceholdersWithFallbackLabels(submittedText, attachments),
				images,
			};
		}

		if (ctx.isIdle()) {
			pendingPreview = attachments;
		} else {
			pi.sendMessage(
				{
					customType: PREVIEW_MESSAGE_TYPE,
					content: attachments.map((attachment) => attachment.placeholder).join(", "),
					display: true,
					details: { placeholders: attachments.map((attachment) => attachment.placeholder) },
				},
				{ deliverAs: "followUp" },
			);
		}

		return {
			action: "transform" as const,
			text: removeImagePlaceholders(submittedText),
			images,
		};
	});

	pi.on("before_agent_start", () => {
		if (pendingPreview.length === 0) return;
		const attachments = pendingPreview;
		pendingPreview = [];
		return {
			message: {
				customType: PREVIEW_MESSAGE_TYPE,
				content: attachments.map((attachment) => attachment.placeholder).join(", "),
				display: true,
				details: { placeholders: attachments.map((attachment) => attachment.placeholder) },
			},
		};
	});
}
