import type { ImageContent as PiImageContent } from "@earendil-works/pi-ai";
import type { ImageDimensions } from "@earendil-works/pi-tui";
import { hexToRgb, SUCCESS_GREEN, TEXT_COLOR } from "../pi-ember-ui/mode-colors.ts";

export const IMAGE_PLACEHOLDER_PREFIX = "[image ";
export const IMAGE_PLACEHOLDER_PATTERN = /\[image \d+\]/gi;
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_WEBP_QUALITY = 80;
export const ATTACHMENT_MAX_DIMENSION_PX = 2000;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageAttachment {
	id: number;
	placeholder: string;
	originalPath: string;
	mimeType: SupportedImageMimeType;
	data: string;
	dimensions?: ImageDimensions;
	createdAt: number;
	compressed?: boolean;
}

export interface LoadedImage {
	originalPath: string;
	mimeType: SupportedImageMimeType;
	data: string;
	dimensions?: ImageDimensions;
}

export type ImageContent = PiImageContent;

export function make_image_placeholder(id: number): string {
	return `${IMAGE_PLACEHOLDER_PREFIX}${id}]`;
}

/** Terminal-fallback transcript label for an image attachment. The editor
 *  placeholder stays `[image N]` (SSOT for matching/removal/submission); only
 *  the fallback text renders the dimensions INSIDE the brackets so the label
 *  reads `[image 3: 345x175]` instead of `[image 3] 345x175`. */
export function format_image_fallback_label(id: number, dimensions?: ImageDimensions): string {
	return dimensions
		? `${IMAGE_PLACEHOLDER_PREFIX}${id}: ${dimensions.widthPx}x${dimensions.heightPx}]`
		: make_image_placeholder(id);
}

const IMAGE_FALLBACK_TEXT_COLOR = "#000000";

/** Styled terminal-fallback label for an image attachment. The label is
 *  painted with the SSOT success green as its background and black text so
 *  it reads as a compact "pill" in the user-message transcript. If a
 *  `resumeBackground` color is supplied, that background is restored after
 *  the label so surrounding text on the same row (e.g. user-message code)
 *  keeps its normal background. SSOT for the green is `SUCCESS_GREEN` in
 *  `mode-colors.ts`. */
function format_styled_image_label(label: string, resume_background?: string): string {
	const bg = `\x1b[48;2;${hexToRgb(SUCCESS_GREEN)}m`;
	const fg = `\x1b[38;2;${hexToRgb(IMAGE_FALLBACK_TEXT_COLOR)}m`;
	const resumeFg = `\x1b[38;2;${hexToRgb(TEXT_COLOR)}m`;
	const resumeBg = resume_background ? `\x1b[48;2;${hexToRgb(resume_background)}m` : "";
	return `${bg}${fg}${label}\x1b[39;49m${resumeFg}${resumeBg}`;
}

export function format_image_styled_fallback_label(
	id: number,
	dimensions?: ImageDimensions,
	resumeBackground?: string,
): string {
	return format_styled_image_label(format_image_fallback_label(id, dimensions), resumeBackground);
}

/** Styled editor placeholder for an image attachment. The text `[image N]` is
 *  painted with the SSOT success green as its background and black text so a
 *  pasted or path-replaced image marker is visually distinct in the chatbox
 *  before the user submits. The stored editor text stays plain so the
 *  placeholder pattern still matches on submit. The editor variant resets to
 *  the terminal's existing background instead of painting PAGE_BG across the
 *  rest of the input row. */
export function format_image_styled_editor_placeholder(id: number): string {
	return format_styled_image_label(make_image_placeholder(id));
}

export type LoadImageResult =
	| { ok: true; image: LoadedImage }
	| {
			ok: false;
			reason: "missing" | "not-file" | "too-large" | "unsupported" | "read-error";
			path: string;
	  };

export interface ImagePreviewDetails {
	placeholders: string[];
}
