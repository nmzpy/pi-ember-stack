/**
 * macOS backend for the Ember screen helper.
 *
 * Window discovery binds CoreGraphics directly through FFI: CGWindowList
 * returns the window id, owner, pid, title, and bounds. Pixels come from
 * Apple's own `screencapture -l <windowid>`, which handles the Screen
 * Recording permission prompt and stays correct on macOS 14+, where
 * CGWindowListCreateImage is deprecated and unreliable.
 *
 * Screen Recording permission is required for window titles AND for pixels.
 * Without it macOS returns windows with no kCGWindowName and `screencapture`
 * writes a black image or fails, so both paths report the permission state
 * instead of silently returning empty results.
 *
 * Runs inside the Bun helper process; the parent kills this process if it
 * exceeds its deadline, so nothing here can wedge the TUI.
 */

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { type CaptureFormat, encode_with, format_extension } from "../encode.ts";

const CORE_GRAPHICS = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
const K_CF_NUMBER_SINT64 = 4;
const K_CF_NUMBER_DOUBLE = 6;
/** CoreFoundation references come back as a Pointer or a bigint depending on the call. */
type CfRef = bigint | Pointer;

/** kCGWindowListOptionOnScreenOnly | kCGWindowListOptionExcludeDesktopElements */
const WINDOW_LIST_OPTIONS = 0x1 | 0x10;
const STRING_BUFFER_BYTES = 1024;
const TITLE_TIMEOUT_NOTE = "grant Screen Recording permission to your terminal";

export interface WindowInfo {
	handle: number;
	pid: number;
	process: string;
	title: string;
	left: number;
	top: number;
	width: number;
	height: number;
	visible: boolean;
	minimized: boolean;
	hung: boolean;
}

export interface CaptureInfo {
	path: string;
	handle: number;
	pid: number;
	process: string;
	title: string;
	selection: string;
	method: "screencapture";
	format: CaptureFormat;
	source_width: number;
	source_height: number;
	width: number;
	height: number;
	rect: { left: number; top: number; width: number; height: number };
}

export class DarwinError extends Error {}

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

let bindings: ReturnType<typeof bindings_open> | null = null;

function bindings_open() {
	const cg = dlopen(CORE_GRAPHICS, {
		CGWindowListCopyWindowInfo: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
		CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
		CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
	});
	const cf = dlopen(CORE_FOUNDATION, {
		CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
		CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
		CFDictionaryGetValue: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		CFNumberGetValue: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.bool },
		CFStringGetCString: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
			returns: FFIType.bool,
		},
		CFStringCreateWithCString: {
			args: [FFIType.ptr, FFIType.cstring, FFIType.u32],
			returns: FFIType.ptr,
		},
		CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
	});
	return {
		g: cg.symbols,
		c: cf.symbols,
		close: () => {
			cg.close();
			cf.close();
		},
	};
}

export function darwin_load(): void {
	if (!bindings) bindings = bindings_open();
}

export function darwin_unload(): void {
	bindings?.close();
	bindings = null;
}

function lib() {
	if (!bindings) throw new DarwinError("darwin bindings are not loaded");
	return bindings;
}

function cf_string(value: string): CfRef {
	const handle = lib().c.CFStringCreateWithCString(null, value, K_CF_STRING_ENCODING_UTF8);
	if (!handle) throw new DarwinError(`Could not create the CoreFoundation key '${value}'.`);
	return handle;
}

function dict_string(dict: CfRef, key: CfRef): string {
	const value = lib().c.CFDictionaryGetValue(dict, key);
	if (!value) return "";
	const buffer = new Uint8Array(STRING_BUFFER_BYTES);
	if (
		!lib().c.CFStringGetCString(value, ptr(buffer), STRING_BUFFER_BYTES, K_CF_STRING_ENCODING_UTF8)
	)
		return "";
	const end = buffer.indexOf(0);
	return Buffer.from(buffer.subarray(0, end < 0 ? buffer.length : end)).toString("utf8");
}

function dict_number(dict: CfRef, key: CfRef, type: number): number | null {
	const value = lib().c.CFDictionaryGetValue(dict, key);
	if (!value) return null;
	const out = new Uint8Array(8);
	if (!lib().c.CFNumberGetValue(value, type, ptr(out))) return null;
	const view = new DataView(out.buffer, out.byteOffset, 8);
	return type === K_CF_NUMBER_SINT64 ? Number(view.getBigInt64(0, true)) : view.getFloat64(0, true);
}

function dict_bounds(dict: CfRef): Bounds | null {
	const value = lib().c.CFDictionaryGetValue(dict, cf_string("kCGWindowBounds"));
	if (!value) return null;
	const xKey = cf_string("X");
	const yKey = cf_string("Y");
	const widthKey = cf_string("Width");
	const heightKey = cf_string("Height");
	const x = dict_number(value, xKey, K_CF_NUMBER_DOUBLE);
	const y = dict_number(value, yKey, K_CF_NUMBER_DOUBLE);
	const width = dict_number(value, widthKey, K_CF_NUMBER_DOUBLE);
	const height = dict_number(value, heightKey, K_CF_NUMBER_DOUBLE);
	if (x === null || y === null || width === null || height === null) return null;
	return { x, y, width, height };
}

export function screen_recording_allowed(): boolean {
	darwin_load();
	try {
		return lib().g.CGPreflightScreenCaptureAccess();
	} catch {
		return true;
	}
}

/** Triggers the macOS permission prompt for the host app on first capture. */
export function request_screen_recording(): void {
	darwin_load();
	try {
		lib().g.CGRequestScreenCaptureAccess();
	} catch {
		// Best effort: the caller still reports the permission state.
	}
}

export function enumerate_windows(): WindowInfo[] {
	darwin_load();
	const { g } = lib();
	const list = g.CGWindowListCopyWindowInfo(WINDOW_LIST_OPTIONS, 0);
	if (!list) return [];

	const keys = {
		number: cf_string("kCGWindowNumber"),
		owner: cf_string("kCGWindowOwnerName"),
		name: cf_string("kCGWindowName"),
		pid: cf_string("kCGWindowOwnerPID"),
		layer: cf_string("kCGWindowLayer"),
		bounds: cf_string("kCGWindowBounds"),
	};

	const found: WindowInfo[] = [];
	try {
		const count = Number(lib().c.CFArrayGetCount(list));
		for (let index = 0; index < count; index++) {
			const entry = lib().c.CFArrayGetValueAtIndex(list, index);
			if (!entry) continue;
			const layer = dict_number(entry, keys.layer, K_CF_NUMBER_SINT64);
			if (layer !== null && layer !== 0) continue; // app windows only

			const bounds = dict_bounds(entry);
			if (!bounds) continue;
			const width = Math.round(bounds.width);
			const height = Math.round(bounds.height);
			if (width <= 0 || height <= 0) continue;

			const handle = dict_number(entry, keys.number, K_CF_NUMBER_SINT64);
			if (handle === null) continue;
			const pid = dict_number(entry, keys.pid, K_CF_NUMBER_SINT64);
			found.push({
				handle,
				pid: pid ?? 0,
				process: dict_string(entry, keys.owner),
				title: dict_string(entry, keys.name),
				left: Math.round(bounds.x),
				top: Math.round(bounds.y),
				width,
				height,
				visible: true,
				minimized: false,
				hung: false,
			});
		}
	} finally {
		lib().c.CFRelease(list);
	}
	return found;
}

export function list_windows(options: { limit: number; minSize: number; pid?: number }): {
	count: number;
	hung_count: number;
	windows: WindowInfo[];
} {
	const candidates = enumerate_windows()
		.filter((entry) => entry.width >= options.minSize && entry.height >= options.minSize)
		.filter((entry) => options.pid === undefined || entry.pid === options.pid)
		.sort((a, b) => b.width * b.height - a.width * a.height);
	const shown = candidates.slice(0, Math.max(1, options.limit));
	if (!screen_recording_allowed() && candidates.some((entry) => !entry.title)) {
		shown.forEach((entry) => {
			if (!entry.title) entry.title = `(title hidden — ${TITLE_TIMEOUT_NOTE})`;
		});
	}
	return { count: candidates.length, hung_count: 0, windows: shown };
}

function resolve_target(options: { handle?: number; match?: string; pid?: number }): {
	entry: WindowInfo;
	selection: string;
} {
	const all = enumerate_windows();
	if (options.handle && options.handle > 0) {
		const entry = all.find((candidate) => candidate.handle === options.handle);
		if (!entry) throw new DarwinError(`No top-level window with handle ${options.handle}.`);
		return { entry, selection: `handle=${options.handle}` };
	}
	// A pid names the process the caller just started, so no listing is needed.
	if (options.pid && options.pid > 0) {
		const entry = [...all]
			.filter((candidate) => candidate.pid === options.pid)
			.sort((a, b) => b.width * b.height - a.width * a.height)[0];
		if (!entry) {
			throw new DarwinError(
				`pid ${options.pid} has no window — the process may have exited, its window may belong to a child process it started, or it may be console-only (a console app's window belongs to the terminal hosting it). Call window_list to see what is on screen.`,
			);
		}
		return { entry, selection: `pid=${options.pid}` };
	}

	if (options.match) {
		const needle = options.match.toLowerCase();
		const entry = all.find(
			(candidate) =>
				candidate.process.toLowerCase().includes(needle) ||
				candidate.title.toLowerCase().includes(needle),
		);
		if (!entry)
			throw new DarwinError(
				`No window matched '${options.match}'. Call window_list to see available windows.`,
			);
		return { entry, selection: `match=${options.match}` };
	}
	const entry = [...all].sort((a, b) => b.width * b.height - a.width * a.height)[0];
	if (!entry) throw new DarwinError("No window found to capture.");
	return { entry, selection: "frontmost" };
}

export async function capture_window(options: {
	handle?: number;
	match?: string;
	pid?: number;
	out?: string;
	scale: number;
	maxWidth: number;
	format: CaptureFormat;
	quality: number;
}): Promise<CaptureInfo> {
	darwin_load();
	const { entry, selection } = resolve_target(options);

	if (!screen_recording_allowed()) {
		request_screen_recording();
		throw new DarwinError(
			`macOS Screen Recording permission is not granted, so window contents cannot be captured. Grant it to your terminal application in System Settings > Privacy & Security > Screen Recording, then retry.`,
		);
	}

	const outPath =
		options.out && options.out.length > 0
			? options.out
			: `${process.env.TMPDIR ?? "/tmp"}/pi-ember-screen-${entry.process || "window"}-${stamp()}.${format_extension(options.format)}`;

	// `screencapture` always writes PNG, so a non-PNG request is re-encoded
	// below; capture into a scratch file rather than the caller's path.
	const scratch = `${outPath}.capture-${stamp()}.png`;
	const captureArgs = ["-x", "-o", "-l", String(entry.handle)];
	const capture = Bun.spawnSync(
		[
			"screencapture",
			...captureArgs,
			options.format === "png" && !options.maxWidth && options.scale >= 1 ? outPath : scratch,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (capture.exitCode !== 0) {
		const detail = capture.stderr.toString().trim();
		throw new DarwinError(
			`screencapture failed for window ${entry.handle}${detail ? `: ${detail}` : ""}. If this persists, check Screen Recording permission for your terminal.`,
		);
	}

	const captured = Bun.file(
		options.format === "png" && !options.maxWidth && options.scale >= 1 ? outPath : scratch,
	);
	if (!(await captured.exists()) || captured.size === 0) {
		throw new DarwinError(
			`screencapture produced no image for window ${entry.handle}. Check Screen Recording permission for your terminal.`,
		);
	}

	let width = entry.width;
	let height = entry.height;
	const reencode = captured.name !== outPath || options.maxWidth > 0 || options.scale < 1;
	if (reencode) {
		const { default: sharp } = await import("sharp");
		const source = await captured.arrayBuffer();
		const metadata = await sharp(source).metadata();
		const sourceWidth = metadata.width ?? entry.width;
		const sourceHeight = metadata.height ?? entry.height;
		const maxWidth = options.maxWidth > 0 && sourceWidth > options.maxWidth;
		const scaled = Math.round(sourceWidth * (options.scale > 0 ? options.scale : 1));
		const targetWidth = maxWidth ? Math.min(options.maxWidth, scaled) : scaled;
		const finalWidth = Math.max(1, targetWidth === sourceWidth ? sourceWidth : targetWidth);
		const finalHeight =
			finalWidth === sourceWidth
				? sourceHeight
				: Math.max(1, Math.round((sourceHeight * finalWidth) / sourceWidth));
		let pipeline = sharp(source);
		if (finalWidth !== sourceWidth) {
			pipeline = pipeline.resize(finalWidth, finalHeight, { kernel: "cubic" });
		}
		await encode_with(pipeline, options.format, options.quality).toFile(outPath);
		width = finalWidth;
		height = finalHeight;
	}

	return {
		path: outPath,
		handle: entry.handle,
		pid: entry.pid,
		process: entry.process,
		title: entry.title,
		selection,
		method: "screencapture",
		format: options.format,
		source_width: entry.width,
		source_height: entry.height,
		width,
		height,
		rect: { left: entry.left, top: entry.top, width: entry.width, height: entry.height },
	};
}

function stamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
