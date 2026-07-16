import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent, FrameResult, VideoFrame } from "./extract.ts";
import {
	formatSeconds,
	getWebSearchConfigPath,
	isTimeoutError,
	mapFfmpegError,
	readExecError,
	trimErrorText,
} from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

const YOUTUBE_REGEX =
	/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface YouTubeConfig {
	enabled: boolean;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

const defaults: YouTubeConfig = { enabled: true };
let cachedConfig: YouTubeConfig | null = null;

function loadYouTubeConfig(): YouTubeConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = { ...defaults };
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { youtube?: { enabled?: boolean } };
	try {
		raw = JSON.parse(rawText) as { youtube?: { enabled?: boolean } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const yt = raw.youtube ?? {};
	cachedConfig = {
		enabled: normalizeEnabled(yt.enabled, defaults.enabled),
	};
	return cachedConfig;
}

export function isYouTubeURL(url: string): { isYouTube: boolean; videoId: string | null } {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/playlist") {
			return { isYouTube: false, videoId: null };
		}
	} catch {}

	const match = url.match(YOUTUBE_REGEX);
	if (!match) return { isYouTube: false, videoId: null };
	return { isYouTube: true, videoId: match[1] };
}

export function isYouTubeEnabled(): boolean {
	return loadYouTubeConfig().enabled;
}

export async function extractYouTube(
	url: string,
	signal?: AbortSignal,
	_prompt?: string,
	_model?: string,
): Promise<ExtractedContent | null> {
	const { videoId } = isYouTubeURL(url);
	const activityId = activityMonitor.logStart({
		type: "fetch",
		url: `youtube.com/${videoId ?? "video"}`,
	});

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, "no YouTube content extraction provider available");
	return null;
}

type StreamInfo = { streamUrl: string; duration: number | null };
type StreamResult = StreamInfo | { error: string };

function mapYtDlpError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "yt-dlp is not installed. Install with: brew install yt-dlp";
	if (isTimeoutError(err)) return "yt-dlp timed out fetching video info";
	const lower = stderr.toLowerCase();
	if (lower.includes("private")) return "Video is private or unavailable";
	if (lower.includes("sign in")) return "Video is age-restricted and requires authentication";
	if (lower.includes("not available"))
		return "Video is unavailable in your region or has been removed";
	if (lower.includes("live")) return "Cannot extract frames from a live stream";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `yt-dlp failed: ${snippet}` : "yt-dlp failed";
}

export async function getYouTubeStreamInfo(videoId: string): Promise<StreamResult> {
	try {
		const output = execFileSync(
			"yt-dlp",
			["--print", "duration", "-g", `https://www.youtube.com/watch?v=${videoId}`],
			{ timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		).trim();
		const lines = output.split(/\r?\n/);
		const rawDuration = lines[0]?.trim();
		const streamUrl = lines[1]?.trim();
		if (!streamUrl) return { error: "yt-dlp failed: missing stream URL" };
		const parsedDuration =
			rawDuration && rawDuration !== "NA" ? Number.parseFloat(rawDuration) : NaN;
		const duration = Number.isFinite(parsedDuration) ? parsedDuration : null;
		return { streamUrl, duration };
	} catch (err) {
		return { error: mapYtDlpError(err) };
	}
}

async function extractFrameFromStream(streamUrl: string, seconds: number): Promise<FrameResult> {
	try {
		const buffer = execFileSync(
			"ffmpeg",
			[
				"-ss",
				String(seconds),
				"-i",
				streamUrl,
				"-frames:v",
				"1",
				"-f",
				"image2pipe",
				"-vcodec",
				"mjpeg",
				"pipe:1",
			],
			{ maxBuffer: 5 * 1024 * 1024, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
		);
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function extractYouTubeFrame(
	videoId: string,
	seconds: number,
	streamInfo?: StreamInfo,
): Promise<FrameResult> {
	const info = streamInfo ?? (await getYouTubeStreamInfo(videoId));
	if ("error" in info) return info;
	return extractFrameFromStream(info.streamUrl, seconds);
}

export async function extractYouTubeFrames(
	videoId: string,
	timestamps: number[],
	streamInfo?: StreamInfo,
): Promise<{ frames: VideoFrame[]; duration: number | null; error: string | null }> {
	const info = streamInfo ?? (await getYouTubeStreamInfo(videoId));
	if ("error" in info) return { frames: [], duration: null, error: info.error };
	const results = await Promise.all(
		timestamps.map(async (t) => {
			const frame = await extractFrameFromStream(info.streamUrl, t);
			if ("error" in frame) return { error: frame.error };
			return { ...frame, timestamp: formatSeconds(t) };
		}),
	);
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const errorResult = results.find((f): f is { error: string } => "error" in f);
	return {
		frames,
		duration: info.duration,
		error: frames.length === 0 && errorResult ? errorResult.error : null,
	};
}
