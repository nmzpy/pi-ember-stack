import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, ExtractOptions, FrameResult } from "./extract.ts";
import { getWebSearchConfigPath, mapFfmpegError, readExecError, trimErrorText } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

const VIDEO_EXTENSIONS: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3gpp": "video/3gpp",
};

interface VideoFileInfo {
	absolutePath: string;
	mimeType: string;
	sizeBytes: number;
}

interface VideoConfig {
	enabled: boolean;
	maxSizeMB: number;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeMaxSizeMB(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

const VIDEO_CONFIG_DEFAULTS: VideoConfig = {
	enabled: true,
	maxSizeMB: 50,
};

let cachedVideoConfig: VideoConfig | null = null;

function loadVideoConfig(): VideoConfig {
	if (cachedVideoConfig) return cachedVideoConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedVideoConfig = { ...VIDEO_CONFIG_DEFAULTS };
		return cachedVideoConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { video?: { enabled?: boolean; maxSizeMB?: number } };
	try {
		raw = JSON.parse(rawText) as { video?: { enabled?: boolean; maxSizeMB?: number } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const v = raw.video ?? {};
	cachedVideoConfig = {
		enabled: normalizeEnabled(v.enabled, VIDEO_CONFIG_DEFAULTS.enabled),
		maxSizeMB: normalizeMaxSizeMB(v.maxSizeMB, VIDEO_CONFIG_DEFAULTS.maxSizeMB),
	};
	return cachedVideoConfig;
}

export function isVideoFile(input: string): VideoFileInfo | null {
	const config = loadVideoConfig();
	if (!config.enabled) return null;

	const isFilePath =
		input.startsWith("/") ||
		input.startsWith("./") ||
		input.startsWith("../") ||
		input.startsWith("file://");
	if (!isFilePath) return null;

	let filePath = input;
	if (input.startsWith("file://")) {
		try {
			filePath = decodeURIComponent(new URL(input).pathname);
		} catch {
			return null;
		}
	}

	const ext = extname(filePath).toLowerCase();
	const mimeType = VIDEO_EXTENSIONS[ext];
	if (!mimeType) return null;

	const absolutePath = resolveFilePath(filePath);
	if (!absolutePath) return null;

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolutePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;

	const maxBytes = config.maxSizeMB * 1024 * 1024;
	if (stat.size > maxBytes) return null;

	return { absolutePath, mimeType, sizeBytes: stat.size };
}

function resolveFilePath(filePath: string): string | null {
	const absolutePath = resolve(filePath);
	if (existsSync(absolutePath)) return absolutePath;

	const dir = dirname(absolutePath);
	const base = basename(absolutePath);
	if (!existsSync(dir)) return null;

	try {
		const normalizedBase = normalizeSpaces(base);
		const match = readdirSync(dir).find((f) => normalizeSpaces(f) === normalizedBase);
		return match ? join(dir, match) : null;
	} catch {
		return null;
	}
}

function normalizeSpaces(s: string): string {
	return s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

export async function extractVideo(
	info: VideoFileInfo,
	signal?: AbortSignal,
	_options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const displayName = basename(info.absolutePath);
	const activityId = activityMonitor.logStart({ type: "fetch", url: `video:${displayName}` });

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, "no video content extraction provider available");
	return null;
}

function mapFfprobeError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffprobe is not installed. Install ffmpeg which includes ffprobe";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffprobe failed: ${snippet}` : "ffprobe failed";
}

export async function extractVideoFrame(
	filePath: string,
	seconds: number = 1,
): Promise<FrameResult> {
	try {
		const buffer = execFileSync(
			"ffmpeg",
			[
				"-ss",
				String(seconds),
				"-i",
				filePath,
				"-frames:v",
				"1",
				"-f",
				"image2pipe",
				"-vcodec",
				"mjpeg",
				"pipe:1",
			],
			{ maxBuffer: 5 * 1024 * 1024, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
		);
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function getLocalVideoDuration(filePath: string): Promise<number | { error: string }> {
	try {
		const output = execFileSync(
			"ffprobe",
			["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
			{ timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		).trim();
		const duration = Number.parseFloat(output);
		if (!Number.isFinite(duration)) return { error: "ffprobe failed: invalid duration output" };
		return duration;
	} catch (err) {
		return { error: mapFfprobeError(err) };
	}
}
