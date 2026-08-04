import type { ImageContent as PiImageContent } from "@earendil-works/pi-ai";
import type { ImageDimensions } from "@earendil-works/pi-tui";

export const IMAGE_PLACEHOLDER_PREFIX = "[image ";
export const IMAGE_PLACEHOLDER_PATTERN = /\[image \d+\]/gi;
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageAttachment {
	id: number;
	placeholder: string;
	originalPath: string;
	mimeType: SupportedImageMimeType;
	data: string;
	dimensions?: ImageDimensions;
	createdAt: number;
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
