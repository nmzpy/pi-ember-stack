/**
 * Windows backend for the Ember screen helper.
 *
 * Runs inside the Bun helper process (never in pi's Node process), so blocking
 * Win32 calls cannot freeze the TUI: the parent kills this process if it
 * exceeds its deadline.
 *
 * Everything here is a direct FFI call to user32/gdi32/kernel32. There is no
 * PowerShell, no compiler, no child process of its own.
 *
 * Two Win32 hazards are handled explicitly, because both used to hang the
 * PowerShell helper:
 *   - window titles are read with SendMessageTimeoutW + SMTO_ABORTIFHUNG, so a
 *     window whose owner is not pumping messages can never block the read
 *     (the cached cross-process caption is the fallback);
 *   - IsHungAppWindow is checked before PrintWindow, which has no timeout
 *     variant and would otherwise block forever on a wedged window.
 */

import { basename } from "node:path";
import { type CaptureFormat, encode_with, format_extension } from "../encode.ts";
import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer } from "bun:ffi";

const PW_RENDERFULLCONTENT = 2;
const WM_GETTEXT = 0x000d;
const SMTO_BLOCK = 0x0001;
const SMTO_ABORTIFHUNG = 0x0002;
const TITLE_TIMEOUT_MS = 150;
const TITLE_BUFFER_CHARS = 512;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SRCCOPY = 0x00cc0020;
/** Include layered windows in a screen copy (required for composited content). */
const CAPTUREBLT = 0x40000000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const BITMAPINFOHEADER_SIZE = 40;
/** Minimum sampled pixels that must differ before a capture counts as real. */
const BLANK_SAMPLE_STEP = 8;

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
	method: "printwindow" | "screen-copy";
	format: CaptureFormat;
	source_width: number;
	source_height: number;
	width: number;
	height: number;
	rect: { left: number; top: number; width: number; height: number };
}

export class Win32Error extends Error {}

let bindings: ReturnType<typeof bindings_open> | null = null;

function bindings_open() {
	const user32 = dlopen("user32.dll", {
		EnumWindows: { args: [FFIType.function, FFIType.ptr], returns: FFIType.bool },
		IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
		IsIconic: { args: [FFIType.ptr], returns: FFIType.bool },
		IsHungAppWindow: { args: [FFIType.ptr], returns: FFIType.bool },
		GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
		GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		SendMessageTimeoutW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		PrintWindow: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
		GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
		ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetForegroundWindow: { args: [], returns: FFIType.ptr },
		GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
		WindowFromPoint: { args: [FFIType.ptr], returns: FFIType.ptr },
		GetAncestor: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
		SetProcessDPIAware: { args: [], returns: FFIType.bool },
	});
	const gdi32 = dlopen("gdi32.dll", {
		CreateCompatibleDC: { args: [FFIType.ptr], returns: FFIType.ptr },
		CreateDIBSection: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32],
			returns: FFIType.ptr,
		},
		SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		BitBlt: {
			args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.u32],
			returns: FFIType.bool,
		},
		DeleteObject: { args: [FFIType.ptr], returns: FFIType.bool },
		DeleteDC: { args: [FFIType.ptr], returns: FFIType.bool },
	});
	const shell32 = dlopen("shell32.dll", {
		SHQueryUserNotificationState: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const kernel32 = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
		QueryFullProcessImageNameW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.bool,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
	});
	return {
		u: user32.symbols,
		g: gdi32.symbols,
		k: kernel32.symbols,
		sh: shell32.symbols,
		close: () => {
			user32.close();
			gdi32.close();
			kernel32.close();
			shell32.close();
		},
	};
}

export function win32_load(): void {
	if (!bindings) {
		bindings = bindings_open();
		try {
			bindings.u.SetProcessDPIAware();
		} catch {
			// Non-fatal: captures are then reported in scaled pixels.
		}
	}
}

export function win32_unload(): void {
	bindings?.close();
	bindings = null;
}

function lib() {
	if (!bindings) throw new Win32Error("win32 bindings are not loaded");
	return bindings;
}

/**
 * Bun's FFI accepts a raw address as a plain number at runtime, while its
 * published types only allow bigint/Pointer/TypedArray. Every numeric handle
 * (HWND, HDC, HBITMAP) goes through this one conversion.
 */
/**
 * Normalize a pointer returned by FFI into an exact JS number. Bun hands back a
 * bigint, and Windows sign-extends 32-bit handles into it, so take the signed
 * 64-bit value first: every real address and handle then round-trips exactly
 * (narrowing a 0xFFFFFFFFF...-style value directly would lose precision and
 * silently corrupt the handle).
 */
function address(value: bigint | number | null): number {
	if (value === null) return 0;
	return typeof value === "bigint" ? Number(BigInt.asIntN(64, value)) : value;
}

function as_ptr(value: number): bigint {
	return value as unknown as bigint;
}

function utf16_read(buffer: Uint16Array): string {
	return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
		.toString("utf16le")
		.replace(/\u0000[\s\S]*$/, "");
}

function title_read(handle: number): string {
	const { u } = lib();
	const titleBuffer = new Uint16Array(TITLE_BUFFER_CHARS);
	const resultBuffer = new Uint8Array(8);
	const viaMessage = u.SendMessageTimeoutW(
		as_ptr(handle),
		WM_GETTEXT,
		0n,
		ptr(titleBuffer),
		SMTO_BLOCK | SMTO_ABORTIFHUNG,
		TITLE_TIMEOUT_MS,
		ptr(resultBuffer),
	);
	if (viaMessage) {
		const title = utf16_read(titleBuffer);
		if (title) return title;
	}
	// A window that is not pumping cannot answer WM_GETTEXT. Windows still
	// hands back the cached cross-process caption without sending a message.
	titleBuffer.fill(0);
	if (u.GetWindowTextW(as_ptr(handle), ptr(titleBuffer), TITLE_BUFFER_CHARS) > 0) {
		return utf16_read(titleBuffer);
	}
	return "";
}

const process_names = new Map<number, string>();

function process_name(pid: number): string {
	const cached = process_names.get(pid);
	if (cached !== undefined) return cached;

	const { k } = lib();
	let name = "";
	const handle = address(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as bigint | null);
	if (handle) {
		try {
			const buffer = new Uint16Array(1024);
			const sizeBuffer = new Uint8Array(4);
			new DataView(sizeBuffer.buffer).setUint32(0, buffer.length, true);
			if (k.QueryFullProcessImageNameW(as_ptr(handle), 0, ptr(buffer), ptr(sizeBuffer))) {
				const path = utf16_read(buffer);
				if (path) name = basename(path).replace(/\.exe$/i, "");
			}
		} finally {
			k.CloseHandle(as_ptr(handle));
		}
	}
	process_names.set(pid, name);
	return name;
}

export interface EnumeratedWindow extends WindowInfo {
	area: number;
}

export function enumerate_windows(): EnumeratedWindow[] {
	win32_load();
	const { u } = lib();
	const found: EnumeratedWindow[] = [];
	const rectBuffer = new Int32Array(4);
	const pidBuffer = new Int32Array(1);

	const callback = new JSCallback(
		(handle: bigint) => {
			const hwnd = Number(handle);
			if (!u.GetWindowRect(as_ptr(hwnd), ptr(rectBuffer))) return true;
			const width = rectBuffer[2] - rectBuffer[0];
			const height = rectBuffer[3] - rectBuffer[1];
			if (width <= 0 || height <= 0) return true;

			u.GetWindowThreadProcessId(as_ptr(hwnd), ptr(pidBuffer));
			found.push({
				handle: hwnd,
				pid: pidBuffer[0],
				process: "",
				title: "",
				left: rectBuffer[0],
				top: rectBuffer[1],
				width,
				height,
				area: width * height,
				visible: u.IsWindowVisible(as_ptr(hwnd)),
				minimized: u.IsIconic(as_ptr(hwnd)),
				hung: u.IsHungAppWindow(as_ptr(hwnd)),
			});
			return true;
		},
		{ args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
	);

	try {
		u.EnumWindows(callback.ptr, 0n);
	} finally {
		callback.close();
	}
	return found;
}

/** Windows that are actually usable as a capture target. */
export function listable_windows(minSize: number, includeMinimized = false): EnumeratedWindow[] {
	return enumerate_windows().filter(
		(entry) =>
			entry.visible &&
			(includeMinimized || !entry.minimized) &&
			entry.width >= minSize &&
			entry.height >= minSize,
	);
}

function describe(entry: EnumeratedWindow, withTitle: boolean): WindowInfo {
	if (!entry.process) entry.process = process_name(entry.pid);
	if (withTitle && !entry.title) entry.title = title_read(entry.handle);
	return {
		handle: entry.handle,
		pid: entry.pid,
		process: entry.process,
		title: entry.title,
		left: entry.left,
		top: entry.top,
		width: entry.width,
		height: entry.height,
		visible: entry.visible,
		minimized: entry.minimized,
		hung: entry.hung,
	};
}

export function list_windows(options: { limit: number; minSize: number; includeMinimized?: boolean }): {
	count: number;
	hung_count: number;
	windows: WindowInfo[];
} {
	const candidates = listable_windows(options.minSize, options.includeMinimized ?? false).sort(
		(a, b) => b.area - a.area,
	);
	const shown = candidates.slice(0, Math.max(1, options.limit));
	return {
		count: candidates.length,
		hung_count: shown.filter((entry) => entry.hung).length,
		windows: shown.map((entry) => describe(entry, true)),
	};
}

function resolve_target(options: { handle?: number; match?: string }): {
	entry: EnumeratedWindow;
	selection: string;
} {
	const all = enumerate_windows();
	for (const entry of all) {
		if (!entry.visible) continue;
		entry.process = process_name(entry.pid);
		entry.title = title_read(entry.handle);
	}

	if (options.handle && options.handle > 0) {
		const entry = all.find((candidate) => candidate.handle === options.handle);
		if (!entry) throw new Win32Error(`No top-level window with handle ${options.handle}.`);
		return { entry, selection: `handle=${options.handle}` };
	}

	if (options.match) {
		const needle = options.match.toLowerCase();
		const matches = all
			.filter(
				(entry) =>
					entry.visible &&
					(entry.process.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle)),
			)
			.sort((a, b) => b.area - a.area);
		const entry = matches[0];
		if (!entry) throw new Win32Error(`No window matched '${options.match}'. Call window_list to see available windows.`);
		return { entry, selection: `match=${options.match}` };
	}

	const foreground = address(lib().u.GetForegroundWindow() as bigint | null);
	const entry = all.find((candidate) => candidate.handle === foreground);
	if (!entry) throw new Win32Error("No foreground window found.");
	return { entry, selection: "foreground" };
}

/** True when every sampled pixel is identical — PrintWindow produced nothing. */
function looks_blank(pixels: Buffer, width: number, height: number): boolean {
	const view = new Uint32Array(pixels.buffer, pixels.byteOffset, Math.floor(pixels.byteLength / 4));
	if (view.length === 0) return true;
	const stepX = Math.max(1, Math.floor(width / BLANK_SAMPLE_STEP));
	const stepY = Math.max(1, Math.floor(height / BLANK_SAMPLE_STEP));
	const first = view[0];
	for (let y = 0; y < height; y += stepY) {
		for (let x = 0; x < width; x += stepX) {
			if (view[y * width + x] !== first) return false;
		}
	}
	return true;
}

/**
 * GDI hands back BGRA with an unset alpha channel; encoders expect RGBA, and an
 * alpha of 0 makes a resampling pass premultiply the colours to black. Swap B/R
 * in place and force the capture opaque.
 */
function bgra_to_rgba(pixels: Buffer): void {
	const view = new Uint32Array(pixels.buffer, pixels.byteOffset, Math.floor(pixels.byteLength / 4));
	for (let i = 0; i < view.length; i++) {
		const value = view[i] as number;
		const swapped = ((value & 0xff00ff00) | ((value & 0x000000ff) << 16) | ((value >>> 16) & 0x000000ff)) >>> 0;
		view[i] = (swapped | 0xff000000) >>> 0;
	}
}

/**
 * Copy the DIB pixels into memory this process owns. Buffer.from(ArrayBuffer)
 * shares the DIB section, so the bytes must be copied before the bitmap is
 * deleted — reading a freed surface segfaults the runtime.
 */
function dib_pixels(bits: number, byteLength: number): Buffer {
	const shared = Buffer.from(toArrayBuffer(bits, 0, byteLength));
	const owned = Buffer.allocUnsafe(byteLength);
	shared.copy(owned);
	return owned;
}

/**
 * Intersect a window rect with the virtual screen. A screen copy can only read
 * pixels that are actually on a monitor, so the copy is limited to that
 * intersection and placed at the matching offset inside the window-sized
 * capture surface.
 */
function clamp_to_screen(
	left: number,
	top: number,
	width: number,
	height: number,
): { destX: number; destY: number; left: number; top: number; width: number; height: number } {
	const { u } = lib();
	const screenLeft = u.GetSystemMetrics(SM_XVIRTUALSCREEN);
	const screenTop = u.GetSystemMetrics(SM_YVIRTUALSCREEN);
	const screenWidth = u.GetSystemMetrics(SM_CXVIRTUALSCREEN);
	const screenHeight = u.GetSystemMetrics(SM_CYVIRTUALSCREEN);
	const sourceLeft = Math.max(left, screenLeft);
	const sourceTop = Math.max(top, screenTop);
	const sourceRight = Math.min(left + width, screenLeft + screenWidth);
	const sourceBottom = Math.min(top + height, screenTop + screenHeight);
	const visibleWidth = Math.max(0, sourceRight - sourceLeft);
	const visibleHeight = Math.max(0, sourceBottom - sourceTop);
	if (visibleWidth <= 0 || visibleHeight <= 0) {
		throw new Win32Error("Window is entirely off-screen, so nothing can be copied from the screen.");
	}
	return {
		destX: sourceLeft - left,
		destY: sourceTop - top,
		left: sourceLeft,
		top: sourceTop,
		width: visibleWidth,
		height: visibleHeight,
	};
}

/**
 * True when this window is the one actually drawn at its own centre point, i.e.
 * nothing is covering it there. A screen-region copy is only trustworthy under
 * that condition, so it decides whether the fallback may run.
 */
function visible_at_center(entry: { handle: number; left: number; top: number; width: number; height: number }): boolean {
	const { u } = lib();
	const point = new Int32Array(2);
	point[0] = entry.left + Math.floor(entry.width / 2);
	point[1] = entry.top + Math.floor(entry.height / 2);
	const atPoint = address(u.WindowFromPoint(ptr(point)) as bigint | null);
	if (!atPoint) return false;
	// GA_ROOT: compare against the top-level window, not a child control.
	const root = address(u.GetAncestor(as_ptr(atPoint), 2) as bigint | null);
	return root === entry.handle || atPoint === entry.handle;
}

/**
 * Name of the fullscreen application that currently owns the display, or "".
 *
 * Windows stops rendering covered windows while a fullscreen app is up, which
 * is why PrintWindow returns an empty surface for every background window in
 * that state. SHQueryUserNotificationState is the documented signal
 * (QUNS_BUSY / QUNS_RUNNING_D3D_FULL_SCREEN); naming the culprit turns an
 * opaque failure into something the operator can act on.
 */
function fullscreen_owner(): string {
	try {
		const state = new Int32Array(1);
		if (lib().sh.SHQueryUserNotificationState(ptr(state)) !== 0) return "";
		if (state[0] !== 2 && state[0] !== 3) return "";
		const foreground = address(lib().u.GetForegroundWindow() as bigint | null);
		if (!foreground) return "";
		const owner = new Int32Array(1);
		lib().u.GetWindowThreadProcessId(as_ptr(foreground), ptr(owner));
		return process_name(owner[0]) || "another application";
	} catch {
		return "";
	}
}

/**
 * Explain why a background window produced no pixels, naming the actual cause:
 * a fullscreen application is up (Windows stops rendering covered windows and
 * no user-space API can read them back), the window is minimized, or another
 * window is simply on top of it.
 */
export function blocker_message(target: {
	process: string;
	handle: number;
	minimized: boolean;
	/** Name of the fullscreen app owning the display, or "". */
	fullscreen: string;
}): string {
	if (target.fullscreen) {
		return `Windows returned no pixels for '${target.process}' (handle ${target.handle}): the fullscreen window '${target.fullscreen}' owns the display, and Windows does not render covered windows in that state. No user-space API can read them back — capture the fullscreen window itself, close it, or switch it to windowed/borderless mode.`;
	}
	if (target.minimized) {
		return `Window '${target.process}' (handle ${target.handle}) is minimized and Windows returned no pixels for it. Restore it and retry.`;
	}
	return `Windows returned no pixels for '${target.process}' (handle ${target.handle}) and another window is covering it, so nothing can be copied from the screen. Bring it to the front and retry.`;
}

function background_capture_blocker(entry: { process: string; handle: number; minimized: boolean }): string {
	return blocker_message({
		process: entry.process,
		handle: entry.handle,
		minimized: entry.minimized,
		fullscreen: fullscreen_owner(),
	});
}

function dib_create(width: number, height: number): {
	dc: number;
	bitmap: number;
	previous: number;
	bits: number;
} {
	const { g } = lib();
	const info = Buffer.alloc(BITMAPINFOHEADER_SIZE);
	info.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
	info.writeInt32LE(width, 4);
	info.writeInt32LE(-height, 8); // negative height: top-down rows
	info.writeUInt16LE(1, 12);
	info.writeUInt16LE(32, 14);
	info.writeUInt32LE(BI_RGB, 16);

	const bitsOut = new Uint8Array(8);
	const dc = address(g.CreateCompatibleDC(0n) as bigint | null);
	const bitmap = address(g.CreateDIBSection(as_ptr(dc), ptr(info), DIB_RGB_COLORS, ptr(bitsOut), 0n, 0) as bigint | null);
	const previous = address(g.SelectObject(as_ptr(dc), as_ptr(bitmap)) as bigint | null);
	// toArrayBuffer wants a number, and a DIB section address is always a real
	// user-space pointer, so narrowing it here is exact.
	const bits = address(new DataView(bitsOut.buffer).getBigUint64(0, true));
	if (!dc || !bitmap || !bits) {
		dib_dispose({ dc, bitmap, previous });
		throw new Win32Error("Could not allocate a capture surface for this window.");
	}
	return { dc, bitmap, previous, bits };
}

function dib_dispose(dib: { dc: number; bitmap: number; previous: number }): void {
	const { g } = lib();
	if (dib.previous) g.SelectObject(as_ptr(dib.dc), as_ptr(dib.previous));
	if (dib.bitmap) g.DeleteObject(as_ptr(dib.bitmap));
	if (dib.dc) g.DeleteDC(as_ptr(dib.dc));
}

export async function capture_window(options: {
	handle?: number;
	match?: string;
	out?: string;
	scale: number;
	maxWidth: number;
	format: CaptureFormat;
	quality: number;
}): Promise<CaptureInfo> {
	win32_load();
	const { entry, selection } = resolve_target(options);

	// A minimized window is attempted rather than refused: PrintWindow asks the
	// owning app to paint, which usually still works, and a blank result is
	// reported with a minimized-specific message below.
	if (entry.hung) {
		throw new Win32Error(
			`Window '${entry.process}' (handle ${entry.handle}) is not responding to Windows messages, so it cannot be captured. Wait for the application to recover, then retry.`,
		);
	}
	if (entry.width <= 0 || entry.height <= 0) {
		throw new Win32Error(`Window '${entry.process}' has an empty area (${entry.width} x ${entry.height}).`);
	}

	const width = entry.width;
	const height = entry.height;
	const dib = dib_create(width, height);
	let raw: Buffer;
	let method: CaptureInfo["method"] = "printwindow";
	try {
		const captured = lib().u.PrintWindow(as_ptr(entry.handle), as_ptr(dib.dc), PW_RENDERFULLCONTENT);
		raw = dib_pixels(dib.bits, width * height * 4);
		if (!captured || looks_blank(raw, width, height)) {
			// PrintWindow is refused for some composited surfaces (DWM, exclusive
			// DirectX). A screen-region copy only returns the right pixels while the
			// window is the foreground one — otherwise it would silently return
			// whatever is drawn on top of it, so refuse instead of lying.
			const is_foreground = address(lib().u.GetForegroundWindow() as bigint | null) === entry.handle;
			if (!is_foreground && !visible_at_center(entry)) {
				throw new Win32Error(background_capture_blocker(entry));
			}
			method = "screen-copy";
			// The screen device context can be momentarily unavailable while the
			// display switches modes (a game going exclusive fullscreen, for
			// example), so one immediate retry covers the transient case.
			let copied = false;
			for (let attempt = 0; attempt < 2 && !copied; attempt++) {
				const screenDc = address(lib().u.GetDC(0n) as bigint | null);
				if (!screenDc) continue;
				try {
					const source = clamp_to_screen(entry.left, entry.top, width, height);
					copied = lib().g.BitBlt(
						as_ptr(dib.dc),
						source.destX,
						source.destY,
						source.width,
						source.height,
						as_ptr(screenDc),
						source.left,
						source.top,
						SRCCOPY | CAPTUREBLT,
					);
				} finally {
					lib().u.ReleaseDC(0n, as_ptr(screenDc));
				}
			}
			if (!copied) {
				throw new Win32Error(
					"Screen copy failed for this window. The desktop may be switching display modes; retry once it settles.",
				);
			}
			raw = dib_pixels(dib.bits, width * height * 4);
		}
	} finally {
		dib_dispose(dib);
	}

	bgra_to_rgba(raw);

	const outPath =
		options.out && options.out.length > 0
			? options.out
			: `${process.env.TEMP ?? process.env.TMP ?? "."}\\pi-ember-screen-${entry.process}-${stamp()}.${format_extension(options.format)}`;

	const { default: sharp } = await import("sharp");
	let pipeline = sharp(raw, { raw: { width, height, channels: 4 } });
	let finalWidth = width;
	let finalHeight = height;
	const scale = options.scale > 0 ? options.scale : 1;
	const targetWidth = options.maxWidth > 0 && width * scale > options.maxWidth ? options.maxWidth : Math.round(width * scale);
	if (scale < 1 || (options.maxWidth > 0 && width * scale > options.maxWidth)) {
		if (targetWidth !== width) {
			finalWidth = Math.max(1, targetWidth);
			finalHeight = Math.max(1, Math.round((height * finalWidth) / width));
			pipeline = sharp(raw, { raw: { width, height, channels: 4 } }).resize(finalWidth, finalHeight, {
				kernel: "cubic",
			});
		}
	}
	await encode_with(pipeline, options.format, options.quality).toFile(outPath);

	return {
		path: outPath,
		handle: entry.handle,
		pid: entry.pid,
		process: entry.process,
		title: entry.title,
		selection,
		method,
		format: options.format,
		source_width: width,
		source_height: height,
		width: finalWidth,
		height: finalHeight,
		rect: { left: entry.left, top: entry.top, width, height },
	};
}

function stamp(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
