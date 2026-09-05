import { describe, expect, test } from "bun:test";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

import {
	format_image_fallback_label,
	format_image_styled_editor_placeholder,
	make_image_placeholder,
} from "../types.ts";
import {
	detectImageMimeType,
	isWindowsDrivePath,
	isWindowsLikePath,
	MAX_IMAGE_PATH_SCAN_CHARS,
	removeImagePlaceholders,
	replaceImagePathsInText,
	replaceImagePlaceholdersWithFallbackLabels,
	tokenizePathLikeText,
} from "../image-utils.ts";
import type { AttachmentStore } from "../store.ts";

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

	test("editor placeholder does not leak a background across the input row", () => {
		const result = format_image_styled_editor_placeholder(3);
		const resetIndex = result.indexOf("\x1b[39;49m");
		expect(resetIndex).toBeGreaterThan(-1);
		expect(result.slice(resetIndex)).not.toContain("\x1b[48;2;");
		expect(`${result}typed text`).toContain("\x1b[39;49m");
	});
});

describe("replaceImagePlaceholdersWithFallbackLabels", () => {
	test("replaces each placeholder with its styled, dimensioned label in place", () => {
		const text = "Review [image 1] and [image 2] please";
		const attachments = [
			attachment(1, { widthPx: 2, heightPx: 2 }),
			attachment(2, { widthPx: 345, heightPx: 175 }),
		];
		const result = replaceImagePlaceholdersWithFallbackLabels(text, attachments);
		expect(stripAnsi(result)).toBe("Review [image 1: 2x2] and [image 2: 345x175] please");
	});

	test("image-only prompt keeps the visible label as the whole message text", () => {
		const attachments = [attachment(1, { widthPx: 2, heightPx: 2 })];
		const result = replaceImagePlaceholdersWithFallbackLabels("[image 1]", attachments);
		expect(stripAnsi(result)).toBe("[image 1: 2x2]");
	});

	test("keeps bare placeholder when dimensions are unknown", () => {
		const attachments = [attachment(1)];
		const result = replaceImagePlaceholdersWithFallbackLabels("see [image 1]", attachments);
		expect(stripAnsi(result)).toBe("see [image 1]");
	});

	test("preserves submission order and surrounding text", () => {
		const attachments = [
			attachment(1, { widthPx: 10, heightPx: 20 }),
			attachment(2, { widthPx: 30, heightPx: 40 }),
		];
		const result = replaceImagePlaceholdersWithFallbackLabels(
			"[image 2] vs [image 1]",
			attachments,
		);
		expect(stripAnsi(result)).toBe("[image 2: 30x40] vs [image 1: 10x20]");
	});
	test("ignores placeholders that are not present in the text", () => {
		const attachments = [attachment(1, { widthPx: 2, heightPx: 2 })];
		const result = replaceImagePlaceholdersWithFallbackLabels("plain text", attachments);
		expect(stripAnsi(result)).toBe("plain text");
	});
});

describe("deterministic paste scan budget", () => {
	test("large pasted blocks skip the sync image-path scan entirely (same reference, store untouched)", () => {
		let addCalls = 0;
		const store = {
			add: () => {
				addCalls++;
				throw new Error("store.add must not be called for oversized text");
			},
		} as unknown as AttachmentStore;

		const token = String.raw`C:\\nope\\dir\\img.png `;
		const large = token.repeat(Math.ceil(MAX_IMAGE_PATH_SCAN_CHARS / token.length) + 1);
		expect(large.length).toBeGreaterThan(MAX_IMAGE_PATH_SCAN_CHARS);

		const result = replaceImagePathsInText(large, {
			cwd: "/cwd",
			store,
		});
		// Same string reference — the guard returns before tokenize + fs probes.
		expect(result.text).toBe(large);
		expect(result.replaced).toBe(0);
		expect(result.accepted).toHaveLength(0);
		expect(addCalls).toBe(0);
	});

	test("short text without path-like tokens returns unchanged within the budget", () => {
		const store = {
			add: () => {
				throw new Error("no image should load");
			},
		} as unknown as AttachmentStore;
		const short = "plain text without paths";

		const result = replaceImagePathsInText(short, { cwd: "/cwd", store });
		expect(result.text).toBe(short);
		expect(result.replaced).toBe(0);
		expect(result.accepted).toHaveLength(0);
	});
});
