import { describe, expect, test } from "bun:test";
import {
	format_image_fallback_label,
	make_image_placeholder,
} from "../types.ts";
import {
	detectImageMimeType,
	isWindowsDrivePath,
	isWindowsLikePath,
	removeImagePlaceholders,
	replaceImagePlaceholdersWithFallbackLabels,
	tokenizePathLikeText,
} from "../image-utils.ts";

function attachment(
	id: number,
	dimensions?: { widthPx: number; heightPx: number },
): import("../types.ts").ImageAttachment {
	return {
		id,
		placeholder: make_image_placeholder(id),
		originalPath: "fixture",
		mimeType: "image/png",
		data: "",
		dimensions,
		createdAt: Date.now(),
	};
}

describe("pi-ember-images path handling", () => {
	test("recognizes Windows drive paths", () => {
		const path = String.raw`C:\Users\nmz\Temp\pi-clipboard.png`;
		expect(isWindowsDrivePath(path)).toBe(true);
		expect(isWindowsLikePath(path)).toBe(true);
	});

	test("tokenizes Windows clipboard paths without treating backslashes as escapes", () => {
		const path = String.raw`C:\Users\nmz\AppData\Local\Temp\pi-clipboard-123.png`;
		expect(tokenizePathLikeText(path)).toEqual([
			{ value: path, start: 0, end: path.length, bare: true },
		]);
	});

	test("keeps quoted Windows paths with spaces as one token", () => {
		const path = String.raw`C:\Users\nmz\Pictures\My Screenshot.png`;
		const text = `Look at "${path}"`;
		const tokens = tokenizePathLikeText(text);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]?.value).toBe(path);
	});

	test("detects image bytes by magic rather than extension", () => {
		expect(detectImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
			"image/png",
		);
		expect(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
	});

	test("removes placeholders from submitted text", () => {
		expect(removeImagePlaceholders("Review [image 1] and [image 2] please")).toBe(
			"Review and please",
		);
		expect(removeImagePlaceholders("[image 1]")).toBe("");
	});

	test("editor placeholder stays bare while fallback label carries dimensions", () => {
		expect(make_image_placeholder(3)).toBe("[image 3]");
		expect(format_image_fallback_label(3)).toBe("[image 3]");
		expect(format_image_fallback_label(3, { widthPx: 345, heightPx: 175 })).toBe(
			"[image 3: 345x175]",
		);
	});
});

describe("replaceImagePlaceholdersWithFallbackLabels", () => {
	test("replaces each placeholder with its dimensioned label in place", () => {
		const text = "Review [image 1] and [image 2] please";
		const attachments = [
			attachment(1, { widthPx: 2, heightPx: 2 }),
			attachment(2, { widthPx: 345, heightPx: 175 }),
		];
		expect(replaceImagePlaceholdersWithFallbackLabels(text, attachments)).toBe(
			"Review [image 1: 2x2] and [image 2: 345x175] please",
		);
	});

	test("image-only prompt keeps the label as the whole message text", () => {
		const attachments = [attachment(1, { widthPx: 2, heightPx: 2 })];
		expect(replaceImagePlaceholdersWithFallbackLabels("[image 1]", attachments)).toBe(
			"[image 1: 2x2]",
		);
	});

	test("keeps bare placeholder when dimensions are unknown", () => {
		const attachments = [attachment(1)];
		expect(replaceImagePlaceholdersWithFallbackLabels("see [image 1]", attachments)).toBe(
			"see [image 1]",
		);
	});

	test("preserves submission order and surrounding text", () => {
		const attachments = [
			attachment(1, { widthPx: 10, heightPx: 20 }),
			attachment(2, { widthPx: 30, heightPx: 40 }),
		];
		expect(
			replaceImagePlaceholdersWithFallbackLabels("[image 2] vs [image 1]", attachments),
		).toBe("[image 2: 30x40] vs [image 1: 10x20]");
	});

	test("ignores placeholders that are not present in the text", () => {
		const attachments = [attachment(1, { widthPx: 2, heightPx: 2 })];
		expect(replaceImagePlaceholdersWithFallbackLabels("plain text", attachments)).toBe(
			"plain text",
		);
	});
});
