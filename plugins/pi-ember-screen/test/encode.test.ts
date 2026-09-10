import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
	DEFAULT_FORMAT,
	encode_with,
	format_extension,
	format_mime_type,
	match_quality,
	parse_format,
	QUALITY_UNSET,
} from "../encode.ts";

/**
 * Encoder contract for captures.
 *
 * The default is PNG because the terminal image path is PNG-native and PNG is
 * lossless, but on a real 2103x1537 UI capture PNG was 195KB while WebP
 * lossless was 49KB with identical pixels — so the format is selectable and
 * these tests pin what each option actually produces (bytes, not intentions).
 */

/** A text-like image: hard edges and flat fills, which is what a UI capture is. */
async function text_like_image(): Promise<Buffer> {
	const rows = Array.from({ length: 40 }, (_, i) => {
		const y = 20 + i * 12;
		return `<text x="10" y="${y}" font-family="Consolas" font-size="9" fill="#d4d4d4">row ${i} forge_bootstrap_task.py 120ms PASS</text>`;
	}).join("\n");
	return sharp(
		Buffer.from(
			`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="520"><rect width="640" height="520" fill="#1e1e1e"/>${rows}</svg>`,
		),
	)
		.png()
		.toBuffer();
}

describe("capture encoding", () => {
	test("each format writes its own container", async () => {
		const source = await text_like_image();
		const png = await encode_with(sharp(source), "png", QUALITY_UNSET).toBuffer();
		const webp = await encode_with(sharp(source), "webp", QUALITY_UNSET).toBuffer();
		const jpeg = await encode_with(sharp(source), "jpeg", QUALITY_UNSET).toBuffer();

		expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(webp.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(webp.subarray(8, 12).toString("ascii")).toBe("WEBP");
		expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
	});

	test("all formats decode back to the same dimensions", async () => {
		const source = await text_like_image();
		for (const format of ["png", "webp", "jpeg"] as const) {
			const bytes = await encode_with(sharp(source), format, QUALITY_UNSET).toBuffer();
			const metadata = await sharp(bytes).metadata();
			expect(metadata.width).toBe(640);
			expect(metadata.height).toBe(520);
		}
	});

	test("webp without a quality is lossless and smaller than png on UI content", async () => {
		const source = await text_like_image();
		const png = await encode_with(sharp(source), "png", QUALITY_UNSET).toBuffer();
		const webp = await encode_with(sharp(source), "webp", QUALITY_UNSET).toBuffer();
		expect(webp.byteLength).toBeLessThan(png.byteLength);

		// ensureAlpha so the 3-channel webp and 4-channel png decode alike.
		const pngRaw = await sharp(png).ensureAlpha().raw().toBuffer();
		const webpRaw = await sharp(webp).ensureAlpha().raw().toBuffer();
		expect(webpRaw.equals(pngRaw)).toBe(true);
	});

	test("lossy webp only pays off on photographic content, not flat UI", async () => {
		// Flat UI text: lossless wins outright, which is why it is the default.
		const ui = await text_like_image();
		const uiLossless = await encode_with(sharp(ui), "webp", QUALITY_UNSET).toBuffer();
		const uiLossy = await encode_with(sharp(ui), "webp", 60).toBuffer();
		expect(uiLossless.byteLength).toBeLessThan(uiLossy.byteLength);

		// A gradient with noise stands in for a photo/video frame, where lossy wins.
		const photo = await sharp({
			create: { width: 800, height: 600, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } },
		})
			.png()
			.toBuffer();
		const photoLossless = await encode_with(sharp(photo), "webp", QUALITY_UNSET).toBuffer();
		const photoLossy = await encode_with(sharp(photo), "webp", 60).toBuffer();
		expect(photoLossy.byteLength).toBeLessThan(photoLossless.byteLength);
	});

	test("jpeg uses a quality that keeps text legible when none is given", async () => {
		const source = await text_like_image();
		const defaults = await encode_with(sharp(source), "jpeg", QUALITY_UNSET).toBuffer();
		const explicit = await encode_with(sharp(source), "jpeg", 90).toBuffer();
		expect(defaults.byteLength).toBe(explicit.byteLength);
	});
});

describe("format metadata", () => {
	test("extensions and MIME types follow the format", () => {
		expect(format_extension("png")).toBe("png");
		expect(format_extension("webp")).toBe("webp");
		expect(format_extension("jpeg")).toBe("jpg");
		expect(format_mime_type("png")).toBe("image/png");
		expect(format_mime_type("webp")).toBe("image/webp");
		expect(format_mime_type("jpeg")).toBe("image/jpeg");
	});

	test("quality is bounded and absent means encoder default", () => {
		expect(match_quality(undefined)).toBe(QUALITY_UNSET);
		expect(match_quality("90")).toBe(90);
		expect(match_quality("0")).toBe(QUALITY_UNSET);
		expect(match_quality("500")).toBe(100);
		expect(() => match_quality("high")).toThrow();
	});

	test("an unsupported format is rejected rather than silently downgraded", () => {
		expect(parse_format("webp")).toBe("webp");
		expect(parse_format("png")).toBe("png");
		expect(parse_format(undefined)).toBe(DEFAULT_FORMAT);
		expect(() => parse_format("avif")).toThrow();
	});
});
