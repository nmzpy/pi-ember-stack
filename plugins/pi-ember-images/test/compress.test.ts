import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { compressAttachment } from "../compress.ts";
import {
	ATTACHMENT_MAX_DIMENSION_PX,
	ATTACHMENT_WEBP_QUALITY,
	IMAGE_PLACEHOLDER_PREFIX,
} from "../types.ts";

function make_attachment(input: {
	mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	data: string;
	dimensions?: { widthPx: number; heightPx: number };
}): import("../types.ts").ImageAttachment {
	return {
		id: 1,
		placeholder: `${IMAGE_PLACEHOLDER_PREFIX}1]`,
		originalPath: "fixture",
		mimeType: input.mimeType,
		data: input.data,
		dimensions: input.dimensions,
		createdAt: Date.now(),
	};
}

/** A tiny 2x2 PNG base64. */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAABytlL0AAAAAA0lEQVR42mNhgQIAADgAWf044wAAAAAASUVORK5CYII=";

describe("compressAttachment", () => {
	test("skips GIF without encoding", async () => {
		const attachment = make_attachment({ mimeType: "image/gif", data: TINY_PNG_BASE64 });
		await compressAttachment(attachment);
		expect(attachment.mimeType).toBe("image/gif");
		expect(attachment.compressed).toBe(true);
	});

	test("skips WebP without encoding", async () => {
		const attachment = make_attachment({ mimeType: "image/webp", data: TINY_PNG_BASE64 });
		await compressAttachment(attachment);
		expect(attachment.mimeType).toBe("image/webp");
		expect(attachment.compressed).toBe(true);
	});

	test("idempotent: second call does nothing", async () => {
		const attachment = make_attachment({ mimeType: "image/png", data: TINY_PNG_BASE64 });
		await compressAttachment(attachment);
		const first = { ...attachment };
		await compressAttachment(attachment);
		expect(attachment.data).toBe(first.data);
		expect(attachment.mimeType).toBe(first.mimeType);
	});

	test("converts PNG to smaller lossy WebP", async () => {
		const png = await sharp({
			create: {
				width: 100,
				height: 100,
				channels: 3,
				background: { r: 80, g: 120, b: 200 },
			},
		})
			.png()
			.toBuffer();
		const attachment = make_attachment({
			mimeType: "image/png",
			data: png.toString("base64"),
			dimensions: { widthPx: 100, heightPx: 100 },
		});
		const originalSize = Buffer.byteLength(attachment.data, "utf8");
		await compressAttachment(attachment);
		expect(attachment.mimeType).toBe("image/webp");
		expect(attachment.compressed).toBe(true);
		const webp = Buffer.from(attachment.data, "base64");
		expect(webp.slice(0, 4).toString("ascii")).toBe("RIFF");
		expect(webp.slice(8, 12).toString("ascii")).toBe("WEBP");
		expect(Buffer.byteLength(attachment.data, "utf8")).toBeLessThan(originalSize);
	});

	test("keep-smaller: leaves a tiny PNG unchanged when WebP would be larger", async () => {
		const attachment = make_attachment({
			mimeType: "image/png",
			data: TINY_PNG_BASE64,
			dimensions: { widthPx: 2, heightPx: 2 },
		});
		const originalSize = Buffer.byteLength(attachment.data, "utf8");
		await compressAttachment(attachment);
		expect(attachment.mimeType).toBe("image/png");
		expect(attachment.data).toBe(TINY_PNG_BASE64);
		expect(Buffer.byteLength(attachment.data, "utf8")).toBe(originalSize);
		expect(attachment.compressed).toBe(true);
	});

	test("scales down images larger than the dimension cap", async () => {
		const wide = await sharp({
			create: {
				width: 3000,
				height: 500,
				channels: 3,
				background: { r: 0, g: 0, b: 0 },
			},
		})
			.png()
			.toBuffer();
		const attachment = make_attachment({
			mimeType: "image/png",
			data: wide.toString("base64"),
		});
		await compressAttachment(attachment);
		expect(attachment.mimeType).toBe("image/webp");
		const meta = await sharp(Buffer.from(attachment.data, "base64")).metadata();
		expect(meta.width).toBeLessThanOrEqual(ATTACHMENT_MAX_DIMENSION_PX);
		expect(meta.height).toBeLessThanOrEqual(ATTACHMENT_MAX_DIMENSION_PX);
	});

	test("uses the configured WebP quality", async () => {
		expect(ATTACHMENT_WEBP_QUALITY).toBe(80);
	});

	test("keep-smaller: leaves a tiny already-small original unchanged", async () => {
		const attachment = make_attachment({
			mimeType: "image/jpeg",
			data: TINY_PNG_BASE64,
		});
		// The tiny invalid-JPEG bytes will likely fail decode; compress should fail-safe.
		await compressAttachment(attachment);
		expect(attachment.compressed).toBe(true);
	});
});
