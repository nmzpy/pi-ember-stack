/**
 * Output encoding for captures — one owner for format, quality, extensions,
 * and MIME types, shared by both platform backends.
 *
 * Defaults are chosen from measurement, not taste. On a real 2103x1537 UI
 * capture (text and panels): PNG 195KB, WebP lossless 49KB (0.25x, identical
 * pixels), WebP q90 81KB, JPEG q90 160KB (0.82x). Screenshots are sharp-edged
 * text, which JPEG compresses poorly and smears, so JPEG is available but never
 * a default. WebP without an explicit quality is lossless: strictly smaller
 * than PNG with nothing lost, which is what an agent needs to read a UI.
 */

import type { Sharp } from "sharp";

export type CaptureFormat = "png" | "webp" | "jpeg";

export const CAPTURE_FORMATS: readonly CaptureFormat[] = ["png", "webp", "jpeg"];
/**
 * WebP (lossless) is the default: on a real 2103x1537 UI capture it was 49KB
 * against PNG 195KB with byte-identical pixels, and every vision provider plus
 * this stack already accepts webp (pi-ember-images re-encodes attachments to
 * it). Pass "png" when a consumer needs the PNG container specifically — some
 * terminal image protocols only render PNG inline, and pi converts non-PNG for
 * those asynchronously.
 */
export const DEFAULT_FORMAT: CaptureFormat = "webp";
export const DEFAULT_JPEG_QUALITY = 90;

/** Quality 0 means "lossless for webp, the encoder default for jpeg". */
export const QUALITY_UNSET = 0;

export function parse_format(value: unknown): CaptureFormat {
	if (value === undefined || value === null || value === "") return DEFAULT_FORMAT;
	if (typeof value === "string" && (CAPTURE_FORMATS as readonly string[]).includes(value)) {
		return value as CaptureFormat;
	}
	throw new Error(`Unsupported capture format '${String(value)}'. Use one of: ${CAPTURE_FORMATS.join(", ")}.`);
}

export function format_extension(format: CaptureFormat): string {
	return format === "jpeg" ? "jpg" : format;
}

export function format_mime_type(format: CaptureFormat): string {
	if (format === "webp") return "image/webp";
	if (format === "jpeg") return "image/jpeg";
	return "image/png";
}

export function match_quality(raw: string | undefined): number {
	if (raw === undefined) return QUALITY_UNSET;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new Error(`--quality requires a numeric value, got '${raw}'`);
	const rounded = Math.trunc(value);
	if (rounded <= 0) return QUALITY_UNSET;
	return Math.min(100, rounded);
}

/**
 * Apply the requested encoder to an already-configured sharp pipeline.
 * `quality` of 0 selects the lossless/encoder-default path.
 */
export function encode_with(pipeline: Sharp, format: CaptureFormat, quality: number): Sharp {
	if (format === "webp") {
		return quality > 0 ? pipeline.webp({ quality }) : pipeline.webp({ lossless: true });
	}
	if (format === "jpeg") {
		return pipeline.jpeg({ quality: quality > 0 ? quality : DEFAULT_JPEG_QUALITY });
	}
	return pipeline.png({ compressionLevel: 9 });
}
