import type { ImageContent as PiImageContent } from "@earendil-works/pi-ai";
import type { ImageDimensions } from "@earendil-works/pi-tui";

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
