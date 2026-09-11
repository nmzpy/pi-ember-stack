/**
 * Timed burst capture — the screenshot timer.
 *
 * One capture answers "what does it look like"; a burst answers "what is it
 * doing". An agent starts a burst and drives the app in the same parallel tool
 * batch, then reads the frames as one contact sheet: motion, a layout that
 * reflows, a flash of state between two stills.
 *
 * The loop lives here, inside the helper process, and not in the plugin. Each
 * helper spawn costs process start plus FFI load, so a timer driven from the
 * parent would drift by hundreds of milliseconds per frame; in-process frames
 * keep the requested cadence and can report their real offsets. Every bound
 * (`MIN_INTERVAL_MS` … `MAX_FRAMES`) is defined once here and reused by the
 * argv parser, the tool schema, and the parent's deadline.
 */

import type { CaptureFormat } from "./encode.ts";
import { encode_with, format_extension } from "./encode.ts";

export const DEFAULT_FRAMES = 4;
export const MAX_FRAMES = 24;
/** Faster than this is pointless: one frame already costs a capture round trip. */
export const MIN_INTERVAL_MS = 50;
export const DEFAULT_INTERVAL_MS = 250;
export const MAX_INTERVAL_MS = 10_000;
export const MAX_DELAY_MS = 60_000;
export const DEFAULT_SHEET_WIDTH = 1600;
export const MAX_SHEET_WIDTH = 4000;
/**
 * Budget for one frame's capture (window read + encode). Frames are scheduled
 * from a fixed cadence, never from the previous frame's completion, so a slower
 * capture eats into the next slot instead of pushing the whole burst late.
 */
export const FRAME_CAPTURE_BUDGET_MS = 1500;
const MIN_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 240_000;

export type BurstPlan = {
	/** Number of frames. 1 means a single capture, no sheet. */
	frames: number;
	intervalMs: number;
	delayMs: number;
};

/** Everything a frame capture must report for the sheet and the tool result. */
export type CapturedFrame = {
	path: string;
	width: number;
	height: number;
	source_width?: number;
	source_height?: number;
	method?: string;
	process?: string;
	selection?: string;
};

export type BurstFrame = {
	path: string;
	/** Milliseconds from the start of the burst, after the delay, when it was taken. */
	offset_ms: number;
	width: number;
	height: number;
	method?: string;
};

export type SheetLayout = {
	cols: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	width: number;
	height: number;
};

export type BurstResult = {
	sheet: { path: string; width: number; height: number };
	frames: BurstFrame[];
	interval_ms: number;
	delay_ms: number;
	duration_ms: number;
	process?: string;
	selection?: string;
};

const SHEET_BACKGROUND = { r: 17, g: 17, b: 17, alpha: 1 } as const;

function clamp_int(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Defaults and bounds for a burst, shared by the parser, the schema and the deadline. */
export function plan_burst(input: {
	frames?: number;
	intervalMs?: number;
	delayMs?: number;
}): BurstPlan {
	return {
		frames: clamp_int(input.frames, 1, MAX_FRAMES, DEFAULT_FRAMES),
		intervalMs: clamp_int(input.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS),
		delayMs: clamp_int(input.delayMs, 0, MAX_DELAY_MS, 0),
	};
}

/**
 * Grid geometry for a count of frames, without the window's aspect: known
 * before the first capture, which is what lets every frame be captured at
 * sheet-cell size instead of full resolution.
 */
export function sheet_grid(count: number, sheetWidth: number): { cols: number; rows: number; cellWidth: number } {
	const frames = Math.max(1, Math.min(MAX_FRAMES, Math.trunc(count)));
	const cols = Math.ceil(Math.sqrt(frames));
	const rows = Math.ceil(frames / cols);
	const width = clamp_int(sheetWidth, cols, MAX_SHEET_WIDTH, DEFAULT_SHEET_WIDTH);
	return { cols, rows, cellWidth: Math.max(1, Math.floor(width / cols)) };
}

/**
 * Grid for the contact sheet: near-square, row-major, cells sized from the
 * window's own aspect so a frame is never distorted. Pure, so the tiling is
 * pinned by a test rather than eyeballed in a capture.
 */
export function sheet_layout(
	count: number,
	sheetWidth: number,
	frameWidth: number,
	frameHeight: number,
): SheetLayout {
	const { cols, rows, cellWidth } = sheet_grid(count, sheetWidth);
	const aspect = frameWidth > 0 && frameHeight > 0 ? frameHeight / frameWidth : 9 / 16;
	const cellHeight = Math.max(1, Math.round(cellWidth * aspect));
	return { cols, rows, cellWidth, cellHeight, width: cellWidth * cols, height: cellHeight * rows };
}

/** The sheet at `out`, its frames numbered beside it, all in one format. */
export function burst_paths(
	out: string,
	count: number,
	format: CaptureFormat,
): { sheet: string; frames: string[] } {
	const suffixes = ["jpeg", "jpg", "webp", "png"].map((name) => `.${name}`);
	const lower = out.toLowerCase();
	const suffix = suffixes.find((candidate) => lower.endsWith(candidate)) ?? "";
	const base = suffix ? out.slice(0, -suffix.length) : out;
	const extension = format_extension(format);
	return {
		sheet: out,
		frames: Array.from(
			{ length: Math.max(1, Math.trunc(count)) },
			(_, index) => `${base}-f${index + 1}.${extension}`,
		),
	};
}

/**
 * Parent-side deadline for the whole burst. The helper has no watchdog (the
 * parent can always kill it), so this only bounds how long the agent waits.
 */
export function burst_timeout_ms(plan: BurstPlan): number {
	const worst = plan.delayMs + plan.frames * (plan.intervalMs + FRAME_CAPTURE_BUDGET_MS) + 5_000;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, worst));
}

/**
 * The frame's index, drawn into its own tile corner. Reading a grid by position
 * alone is exactly the step a model gets wrong, so the sheet numbers itself.
 */
function tile_label(index: number, layout: SheetLayout): { input: Buffer; left: number; top: number } {
	const col = (index - 1) % layout.cols;
	const row = Math.floor((index - 1) / layout.cols);
	const size = Math.max(10, Math.min(28, Math.round(layout.cellWidth / 26)));
	const pad = Math.max(4, Math.round(size * 0.45));
	const boxWidth = Math.round(size * (index >= 10 ? 1.9 : 1.25));
	const height = Math.round(size * 1.55);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.cellWidth}" height="${layout.cellHeight}">` +
		`<rect x="${pad}" y="${pad}" width="${boxWidth}" height="${height}" rx="${Math.round(size * 0.3)}" ` +
		'fill="rgba(0,0,0,0.55)"/>' +
		`<text x="${pad + boxWidth / 2}" y="${pad + Math.round(size * 1.12)}" text-anchor="middle" ` +
		`font-family="Segoe UI, system-ui, sans-serif" font-size="${size}" fill="#ffffff">${index}</text></svg>`;
	return {
		input: Buffer.from(svg),
		left: col * layout.cellWidth,
		top: row * layout.cellHeight,
	};
}

/**
 * Tile the frames into one image, in capture order, row-major, numbered. A
 * single image is what makes a burst readable: the model sees the whole
 * sequence at once instead of paying for N full-size screenshots.
 */
export async function build_contact_sheet(options: {
	frames: readonly BurstFrame[];
	layout: SheetLayout;
	format: CaptureFormat;
	quality: number;
	out: string;
}): Promise<{ path: string; width: number; height: number }> {
	const { default: sharp } = await import("sharp");
	const tiles = await Promise.all(
		options.frames.map(async (frame, index) => {
			// Frames are captured at cell size; a resize is only needed when a
			// window changed size mid-burst and the tile no longer fits.
			const image = sharp(frame.path);
			const metadata = await image.metadata();
			const tile =
				metadata.width === options.layout.cellWidth && metadata.height === options.layout.cellHeight
					? await image.toBuffer()
					: await image
							.resize(options.layout.cellWidth, options.layout.cellHeight, {
								fit: "contain",
								background: SHEET_BACKGROUND,
							})
							.toBuffer();
			return {
				input: tile,
				left: (index % options.layout.cols) * options.layout.cellWidth,
				top: Math.floor(index / options.layout.cols) * options.layout.cellHeight,
			};
		}),
	);
	const labels = options.frames.map((_, index) => tile_label(index + 1, options.layout));
	const canvas = sharp({
		create: {
			width: options.layout.width,
			height: options.layout.height,
			channels: 4,
			background: SHEET_BACKGROUND,
		},
	});
	await encode_with(canvas.composite([...tiles, ...labels]), options.format, options.quality).toFile(
		options.out,
	);
	return { path: options.out, width: options.layout.width, height: options.layout.height };
}

/**
 * Take the burst: `frames` captures on a fixed cadence, then one contact sheet.
 * `capture` is the platform's single-window capture, so the timer adds timing and
 * tiling only — target resolution and pixels stay owned by the platform backend.
 */
export async function run_burst(options: {
	plan: BurstPlan;
	out: string;
	format: CaptureFormat;
	quality: number;
	sheetWidth: number;
	/**
	 * `maxWidth` is the sheet's cell width: capturing each frame at its final
	 * tile size is what keeps a large window inside the requested cadence.
	 */
	capture: (out: string, maxWidth: number) => Promise<CapturedFrame>;
}): Promise<BurstResult> {
	const paths = burst_paths(options.out, options.plan.frames, options.format);
	const grid = sheet_grid(options.plan.frames, options.sheetWidth);
	const started = Date.now();
	const frames: BurstFrame[] = [];
	let target: { process?: string; selection?: string } = {};

	for (let index = 0; index < options.plan.frames; index++) {
		const due = started + options.plan.delayMs + index * options.plan.intervalMs;
		const wait = due - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		const taken_at = Date.now();
		const captured = await options.capture(paths.frames[index], grid.cellWidth);
		if (index === 0) target = { process: captured.process, selection: captured.selection };
		frames.push({
			path: captured.path,
			offset_ms: taken_at - started,
			width: captured.source_width ?? captured.width,
			height: captured.source_height ?? captured.height,
			method: captured.method,
		});
	}

	const first = frames[0];
	if (!first) throw new Error("Burst produced no frames.");
	const layout = sheet_layout(frames.length, options.sheetWidth, first.width, first.height);
	const sheet = await build_contact_sheet({
		frames,
		layout,
		format: options.format,
		quality: options.quality,
		out: paths.sheet,
	});

	return {
		sheet,
		frames,
		interval_ms: options.plan.intervalMs,
		delay_ms: options.plan.delayMs,
		duration_ms: Date.now() - started,
		process: target.process,
		selection: target.selection,
	};
}
