/**
 * SSOT attachment compression.
 *
 * Converts PNG/JPEG clipboard screenshots and pasted images to lossy WebP
 * (quality 80, max 2000 px on any edge), keeping the smaller of the original
 * or encoded result. Failures are intentionally silent — the original bytes
 * are always preserved.
 */
import sharp from "sharp";
import { ATTACHMENT_MAX_DIMENSION_PX, ATTACHMENT_WEBP_QUALITY, type ImageAttachment } from "./types.ts";

export { ATTACHMENT_MAX_DIMENSION_PX, ATTACHMENT_WEBP_QUALITY };

const SKIP_MIME_TYPES = new Set<`${"image"}/${string}`>(["image/gif", "image/webp"]);

function base64_size(data: string): number {
	return Buffer.byteLength(data, "utf8");
}

export async function compressAttachment(attachment: ImageAttachment): Promise<void> {
	if (attachment.compressed) return;
	if (SKIP_MIME_TYPES.has(attachment.mimeType)) {
		attachment.compressed = true;
		return;
	}
	if (!attachment.mimeType.startsWith("image/")) return;
	const originalSize = base64_size(attachment.data);
	try {
		const raw = Buffer.from(attachment.data, "base64");
		if (raw.length === 0) return;
		const output = await sharp(raw, { animated: false })
			.rotate()
			.resize({
				width: ATTACHMENT_MAX_DIMENSION_PX,
				height: ATTACHMENT_MAX_DIMENSION_PX,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: ATTACHMENT_WEBP_QUALITY })
			.toBuffer();
		const outputData = output.toString("base64");
		if (Buffer.byteLength(outputData, "utf8") >= originalSize) {
			attachment.compressed = true;
			return;
		}
		const metadata = await sharp(output).metadata();
		attachment.data = outputData;
		attachment.mimeType = "image/webp";
		if (metadata.width && metadata.height) {
			attachment.dimensions = { widthPx: metadata.width, heightPx: metadata.height };
		}
		attachment.compressed = true;
	} catch {
		// Fail-safe: leave the original attachment untouched.
		attachment.compressed = true;
	}
}
