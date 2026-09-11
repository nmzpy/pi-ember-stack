/**
 * Argument contract for the screen helper process.
 *
 * Pure and platform-free so it can be unit tested and shared between the
 * plugin (which builds the argv) and the helper (which parses it).
 */

import {
	type CaptureFormat,
	DEFAULT_FORMAT,
	match_quality,
	parse_format,
	QUALITY_UNSET,
} from "./encode.ts";
import {
	DEFAULT_INTERVAL_MS,
	MAX_DELAY_MS,
	MAX_FRAMES,
	MAX_INTERVAL_MS,
	MIN_INTERVAL_MS,
} from "./sequence.ts";

export interface ScreenHelperOptions {
	list: boolean;
	diagnose: boolean;
	includeMinimized: boolean;
	match?: string;
	handle?: number;
	/** Process id whose window to capture or filter the listing by. */
	pid?: number;
	/** Frames to take, on a timer. 1 (the default) is a single capture. */
	frames: number;
	intervalMs: number;
	delayMs: number;
	out?: string;
	scale: number;
	maxWidth: number;
	limit: number;
	minSize: number;
	format: CaptureFormat;
	quality: number;
}

export const DEFAULT_LIMIT = 300;
export const DEFAULT_MIN_SIZE = 32;

export class ScreenArgsError extends Error {}

function number_value(flag: string, raw: string | undefined): number {
	if (raw === undefined) throw new ScreenArgsError(`${flag} requires a value`);
	const value = Number(raw);
	if (!Number.isFinite(value))
		throw new ScreenArgsError(`${flag} requires a numeric value, got '${raw}'`);
	return value;
}

/** A bounded integer flag: out-of-range is an error, never a silent clamp. */
function bounded_int(flag: string, raw: string | undefined, min: number, max: number): number {
	const value = Math.trunc(number_value(flag, raw));
	if (value < min || value > max) {
		throw new ScreenArgsError(`${flag} must be between ${min} and ${max}, got '${raw}'`);
	}
	return value;
}

export function parse_screen_args(argv: readonly string[]): ScreenHelperOptions {
	const options: ScreenHelperOptions = {
		list: false,
		diagnose: false,
		includeMinimized: false,
		frames: 1,
		intervalMs: DEFAULT_INTERVAL_MS,
		delayMs: 0,
		scale: 1,
		maxWidth: 0,
		limit: DEFAULT_LIMIT,
		minSize: DEFAULT_MIN_SIZE,
		format: DEFAULT_FORMAT,
		quality: QUALITY_UNSET,
	};

	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		switch (flag) {
			case "--list":
				options.list = true;
				break;
			case "--diagnose":
				options.diagnose = true;
				break;
			case "--include-minimized":
				options.includeMinimized = true;
				break;
			case "--match":
				options.match = argv[++index];
				if (!options.match) throw new ScreenArgsError("--match requires a value");
				break;
			case "--handle":
				options.handle = Math.trunc(number_value("--handle", argv[++index]));
				break;
			case "--pid": {
				const pid = Math.trunc(number_value("--pid", argv[++index]));
				if (pid <= 0)
					throw new ScreenArgsError(`--pid requires a positive process id, got '${pid}'`);
				options.pid = pid;
				break;
			}
			case "--frames":
				options.frames = bounded_int("--frames", argv[++index], 1, MAX_FRAMES);
				break;
			case "--interval-ms":
				options.intervalMs = bounded_int("--interval-ms", argv[++index], MIN_INTERVAL_MS, MAX_INTERVAL_MS);
				break;
			case "--delay-ms":
				options.delayMs = bounded_int("--delay-ms", argv[++index], 0, MAX_DELAY_MS);
				break;
			case "--out":
				options.out = argv[++index];
				if (!options.out) throw new ScreenArgsError("--out requires a value");
				break;
			case "--scale":
				options.scale = number_value("--scale", argv[++index]);
				break;
			case "--max-width":
				options.maxWidth = Math.trunc(number_value("--max-width", argv[++index]));
				break;
			case "--limit":
				options.limit = Math.trunc(number_value("--limit", argv[++index]));
				break;
			case "--format":
				options.format = parse_format(argv[++index]);
				break;
			case "--quality":
				options.quality = match_quality(argv[++index]);
				break;
			case "--min-size":
				options.minSize = Math.trunc(number_value("--min-size", argv[++index]));
				break;
			default:
				throw new ScreenArgsError(`unknown argument '${flag}'`);
		}
	}

	if (options.limit <= 0) options.limit = DEFAULT_LIMIT;
	if (options.minSize < 0) options.minSize = DEFAULT_MIN_SIZE;
	if (options.scale <= 0) options.scale = 1;

	return options;
}
