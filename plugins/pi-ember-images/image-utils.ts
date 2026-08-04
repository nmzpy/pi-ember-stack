import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { compressAttachment } from "./compress.ts";
import type { AttachmentStore } from "./store.ts";
import {
	MAX_IMAGE_BYTES,
	type ImageAttachment,
	type ImageContent,
	type LoadImageResult,
	type SupportedImageMimeType,
	IMAGE_PLACEHOLDER_PATTERN,
} from "./types.ts";

interface PathToken {
	value: string;
	start: number;
	end: number;
	bare: boolean;
}

const MAX_BARE_PATH_EXTENSIONS = 8;
const WINDOWS_DRIVE_PATH = /^([a-zA-Z]):[\\/](.*)$/;

export function detectImageMimeType(bytes: Uint8Array): SupportedImageMimeType | undefined {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	)
		return "image/gif";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return "image/webp";
	return undefined;
}

export function isWindowsDrivePath(value: string): boolean {
	return WINDOWS_DRIVE_PATH.test(value);
}

export function isWindowsUncPath(value: string): boolean {
	return value.startsWith("\\\\") && value.length > 2;
}

export function isWindowsLikePath(value: string): boolean {
	return isWindowsDrivePath(value) || isWindowsUncPath(value);
}

let cachedIsWsl: boolean | undefined;

function isWsl(): boolean {
	if (cachedIsWsl !== undefined) return cachedIsWsl;
	if (process.platform !== "linux") {
		cachedIsWsl = false;
		return cachedIsWsl;
	}
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
		cachedIsWsl = true;
		return cachedIsWsl;
	}
	try {
		cachedIsWsl = /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		cachedIsWsl = false;
	}
	return cachedIsWsl;
}

function windowsToWslPath(value: string): string {
	const driveMatch = WINDOWS_DRIVE_PATH.exec(value);
	if (driveMatch) {
		const drive = driveMatch[1];
		const rest = driveMatch[2];
		if (drive && rest !== undefined) {
			const normalizedRest = rest.replace(/\\/g, "/");
			return normalizedRest.length > 0
				? `/mnt/${drive.toLowerCase()}/${normalizedRest}`
				: `/mnt/${drive.toLowerCase()}`;
		}
	}
	return value.replace(/\\/g, "/");
}

function isPathLike(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.startsWith("~/") ||
		value === "~" ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		isWindowsLikePath(value)
	);
}

function startsWithWindowsPath(text: string, index: number): boolean {
	return (
		(index + 2 < text.length &&
			/[a-zA-Z]/.test(text[index] ?? "") &&
			text[index + 1] === ":" &&
			(text[index + 2] === "\\" || text[index + 2] === "/")) ||
		(index + 1 < text.length && text[index] === "\\" && text[index + 1] === "\\")
	);
}

function shellUnescape(input: string): string {
	let result = "";
	for (let index = 0; index < input.length; index++) {
		if (input[index] === "\\" && index + 1 < input.length) result += input[++index];
		else result += input[index];
	}
	return result;
}

export function tokenizePathLikeText(text: string): PathToken[] {
	const tokens: PathToken[] = [];
	let index = 0;
	while (index < text.length) {
		if (/\s/.test(text[index] ?? "")) {
			index++;
			continue;
		}

		const start = index;
		const quote = text[index] === "'" || text[index] === '"' ? text[index] : undefined;
		if (quote) {
			index++;
			const windowsMode = startsWithWindowsPath(text, index);
			let value = "";
			let closed = false;
			while (index < text.length) {
				const current = text[index] ?? "";
				if (!windowsMode && current === "\\" && quote === '"' && index + 1 < text.length) {
					value += text[index + 1];
					index += 2;
					continue;
				}
				if (current === quote) {
					index++;
					closed = true;
					break;
				}
				value += current;
				index++;
			}
			if (closed && isPathLike(value)) tokens.push({ value, start, end: index, bare: false });
			continue;
		}

		const windowsMode = startsWithWindowsPath(text, index);
		let rawValue = "";
		while (index < text.length) {
			const current = text[index] ?? "";
			if (/\s/.test(current)) break;
			if (!windowsMode && current === "\\" && index + 1 < text.length) {
				rawValue += current + text[index + 1];
				index += 2;
				continue;
			}
			rawValue += current;
			index++;
		}
		const value = windowsMode ? rawValue : shellUnescape(rawValue);
		if (isPathLike(value)) tokens.push({ value, start, end: index, bare: true });
	}
	return tokens;
}

export function resolveImagePath(input: string, cwd: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
	if (isWindowsLikePath(input)) {
		if (process.platform === "win32") return input;
		return isWsl() ? windowsToWslPath(input) : input;
	}
	if (isAbsolute(input)) return input;
	return resolve(cwd, input);
}

export function dimensionsForImage(data: string, mimeType: SupportedImageMimeType) {
	return getImageDimensions(data, mimeType) ?? undefined;
}

export function loadImageFromPath(
	inputPath: string,
	cwd: string,
	maxBytes = MAX_IMAGE_BYTES,
): LoadImageResult {
	const path = resolveImagePath(inputPath, cwd);
	try {
		if (!existsSync(path)) return { ok: false, reason: "missing", path };
		const stats = statSync(path);
		if (!stats.isFile()) return { ok: false, reason: "not-file", path };
		if (stats.size > maxBytes) return { ok: false, reason: "too-large", path };
		const bytes = readFileSync(path);
		const mimeType = detectImageMimeType(bytes);
		if (!mimeType) return { ok: false, reason: "unsupported", path };
		const data = bytes.toString("base64");
		return {
			ok: true,
			image: { originalPath: path, mimeType, data, dimensions: dimensionsForImage(data, mimeType) },
		};
	} catch {
		return { ok: false, reason: "read-error", path };
	}
}

function tryExtendBareToken(
	text: string,
	token: PathToken,
	attempt: (path: string) => LoadImageResult,
): { end: number; result: LoadImageResult } {
	let value = token.value;
	let end = token.end;
	let result = attempt(value);
	if (result.ok || result.reason === "too-large" || !token.bare) return { end, result };

	let scan = end;
	for (let index = 0; index < MAX_BARE_PATH_EXTENSIONS; index++) {
		let whitespaceEnd = scan;
		while (whitespaceEnd < text.length && /\s/.test(text[whitespaceEnd] ?? "")) whitespaceEnd++;
		if (whitespaceEnd === scan) break;
		let wordEnd = whitespaceEnd;
		while (wordEnd < text.length && !/\s/.test(text[wordEnd] ?? "")) wordEnd++;
		const nextWord = shellUnescape(text.slice(whitespaceEnd, wordEnd));
		if (isPathLike(nextWord)) break;
		value += text.slice(scan, whitespaceEnd) + nextWord;
		result = attempt(value);
		scan = wordEnd;
		end = wordEnd;
		if (result.ok || result.reason === "too-large") return { end, result };
	}
	return { end, result };
}

export function replaceImagePathsInText(
	text: string,
	options: {
		cwd: string;
		store: AttachmentStore;
		onReject?: (result: Exclude<LoadImageResult, { ok: true }>) => void;
	},
): { text: string; replaced: number; accepted: ImageAttachment[] } {
	const tokens = tokenizePathLikeText(text);
	if (tokens.length === 0) return { text, replaced: 0, accepted: [] };

	let output = "";
	let cursor = 0;
	let replaced = 0;
	const accepted: ImageAttachment[] = [];
	for (const token of tokens) {
		if (token.start < cursor) continue;
		const extended = tryExtendBareToken(text, token, (path) =>
			loadImageFromPath(path, options.cwd),
		);
		if (!extended.result.ok) {
			if (extended.result.reason === "too-large") options.onReject?.(extended.result);
			continue;
		}
		const attachment = options.store.add(extended.result.image);
		accepted.push(attachment);
		void compressAttachment(attachment);
		output += text.slice(cursor, token.start) + attachment.placeholder;
		cursor = extended.end;
		replaced++;
	}
	if (replaced === 0) return { text, replaced: 0, accepted: [] };
	return { text: output + text.slice(cursor), replaced, accepted };
}

export function imagesForText(
	store: AttachmentStore,
	text: string,
	existing: ImageContent[] = [],
): ImageContent[] {
	return [
		...existing,
		...store.matchingPlaceholders(text).map((attachment) => ({
			type: "image" as const,
			mimeType: attachment.mimeType,
			data: attachment.data,
		})),
	];
}

export function removeImagePlaceholders(text: string): string {
	return text
		.replace(IMAGE_PLACEHOLDER_PATTERN, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

export function describeReject(
	result: Exclude<LoadImageResult, { ok: true }>,

	notify?: (message: string) => void,
): void {
	if (!notify) return;
	if (result.reason === "too-large")
		notify(`Image is too large and was not attached: ${result.path}`);
	else if (result.reason === "unsupported") notify(`Unsupported image format: ${result.path}`);
	else if (result.reason === "missing") notify(`Image path was not found: ${result.path}`);
}
