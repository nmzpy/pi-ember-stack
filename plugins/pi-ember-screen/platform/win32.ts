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

import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer } from "bun:ffi";
import { basename } from "node:path";
import { type CaptureFormat, encode_with, format_extension } from "../encode.ts";
import { pack_int32_pair, wgc_capture_window, wgc_unload } from "./win32-wgc.ts";

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
	/**
	 * Which rung of the capture ladder produced the pixels: the owning app
	 * painted them (printwindow), the compositor handed over the window's own
	 * composition surface (wgc — works while covered, GPU-composited, or wedged),
	 * or they were read off the screen (screen-copy — only truthful while the
	 * window is the one on top).
	 */
	method: "printwindow" | "wgc" | "screen-copy";
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
			args: [
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.ptr,
			],
			returns: FFIType.ptr,
		},
		PrintWindow: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
		GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
		ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		GetForegroundWindow: { args: [], returns: FFIType.ptr },
		GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
		WindowFromPoint: { args: [FFIType.i64], returns: FFIType.ptr },
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
			args: [
				FFIType.ptr,
				FFIType.i32,
				FFIType.i32,
				FFIType.i32,
				FFIType.i32,
				FFIType.ptr,
				FFIType.i32,
				FFIType.i32,
				FFIType.u32,
			],
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
	wgc_unload();
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
	const handle = address(
		k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as bigint | null,
	);
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

/**
 * Largest first: an app's real window beats the helper popups and tool windows
 * it also owns, so both substring and pid targeting land on the visible one.
 */
function largest_first(windows: EnumeratedWindow[]): EnumeratedWindow[] {
	return windows.filter((entry) => entry.visible).sort((a, b) => b.area - a.area);
}

export function list_windows(options: {
	limit: number;
	minSize: number;
	includeMinimized?: boolean;
	pid?: number;
}): {
	count: number;
	hung_count: number;
	windows: WindowInfo[];
} {
	const candidates = listable_windows(options.minSize, options.includeMinimized ?? false)
		.filter((entry) => options.pid === undefined || entry.pid === options.pid)
		.sort((a, b) => b.area - a.area);
	const shown = candidates.slice(0, Math.max(1, options.limit));
	return {
		count: candidates.length,
		hung_count: shown.filter((entry) => entry.hung).length,
		windows: shown.map((entry) => describe(entry, true)),
	};
}

function resolve_target(options: { handle?: number; match?: string; pid?: number }): {
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

	// A pid names the process the caller just started, so the window is found
	// without listing anything first. Console-only apps have no window of their
	// own: the terminal hosting them does.
	if (options.pid && options.pid > 0) {
		const entry = largest_first(all.filter((candidate) => candidate.pid === options.pid))[0];
		if (!entry) {
			const name = process_name(options.pid);
			const target = name ? `'${name}' (pid ${options.pid})` : `pid ${options.pid}`;
			throw new Win32Error(
				`${target} has no visible top-level window — the process may have exited, its window may belong to a child process it started, or it may be console-only (a console app's window belongs to the terminal hosting it). Call window_list to see what is on screen.`,
			);
		}
		return { entry, selection: `pid=${options.pid}` };
	}

	if (options.match) {
		const needle = options.match.toLowerCase();
		const matches = largest_first(
			all.filter(
				(entry) =>
					entry.process.toLowerCase().includes(needle) ||
					entry.title.toLowerCase().includes(needle),
			),
		);
		const entry = matches[0];
		if (!entry)
			throw new Win32Error(
				`No window matched '${options.match}'. Call window_list to see available windows.`,
			);
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
		const swapped =
			((value & 0xff00ff00) | ((value & 0x000000ff) << 16) | ((value >>> 16) & 0x000000ff)) >>> 0;
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
		throw new Win32Error(
			"Window is entirely off-screen, so nothing can be copied from the screen.",
		);
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
function visible_at_center(entry: {
	handle: number;
	left: number;
	top: number;
	width: number;
	height: number;
}): boolean {
	const { u } = lib();
	// A POINT travels by value: packing it into the pointer argument asks about a
	// nonsense coordinate (the address itself) and always finds nothing.
	const point = pack_int32_pair(
		entry.left + Math.floor(entry.width / 2),
		entry.top + Math.floor(entry.height / 2),
	);
	const atPoint = address(u.WindowFromPoint(point as unknown as bigint) as bigint | null);
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
 * Explain why a window produced no pixels, naming the actual cause: a
 * fullscreen application is up (Windows stops compositing every other window in
 * that state), the window is minimized, the app is not answering, or the
 * compositor had no frame and another window is on top.
 *
 * `compositor_reason` carries whatever Windows.Graphics.Capture reported, so a
 * failure that is not about z-order or a fullscreen owner is never mislabeled.
 */
export function blocker_message(target: {
	process: string;
	handle: number;
	minimized: boolean;
	hung: boolean;
	/** Name of the fullscreen app owning the display, or "". */
	fullscreen: string;
	/** Why the compositor handed over no frame, or "". */
	compositor_reason: string;
}): string {
	const compositor = target.compositor_reason
		? ` Compositor capture failed too: ${target.compositor_reason}`
		: "";
	if (target.fullscreen) {
		return `Windows returned no pixels for '${target.process}' (handle ${target.handle}): the fullscreen window '${target.fullscreen}' owns the display, and Windows stops compositing every other window in that state.${compositor} Capture the fullscreen window itself, close it, or switch it to windowed/borderless mode.`;
	}
	if (target.minimized) {
		return `Window '${target.process}' (handle ${target.handle}) is minimized, so neither the app nor the compositor has a current surface for it.${compositor} Restore it and retry.`;
	}
	if (target.hung) {
		return `Window '${target.process}' (handle ${target.handle}) is not responding to Windows messages and the compositor has no frame for it.${compositor} Wait for the application to recover, then retry.`;
	}
	return `Windows returned no pixels for '${target.process}' (handle ${target.handle}) and another window is covering it, so a screen copy would return the wrong pixels.${compositor} Bring it to the front and retry.`;
}

function background_capture_blocker(
	entry: { process: string; handle: number; minimized: boolean; hung: boolean },
	compositor_reason: string,
): string {
	return blocker_message({
		process: entry.process,
		handle: entry.handle,
		minimized: entry.minimized,
		hung: entry.hung,
		fullscreen: fullscreen_owner(),
		compositor_reason,
	});
}

function dib_create(
	width: number,
	height: number,
): {
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
	const bitmap = address(
		g.CreateDIBSection(as_ptr(dc), ptr(info), DIB_RGB_COLORS, ptr(bitsOut), 0n, 0) as bigint | null,
	);
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

/** One window's pixels plus the rung of the ladder that produced them. */
interface CapturedSurface {
	/** BGRA with the GDI DIB layout for every method, so the caller's single
	 * BGRA→RGBA pass applies to all of them. */
	pixels: Buffer;
	width: number;
	height: number;
	method: CaptureInfo["method"];
}

/**
 * Screen-region copy of the window rect. The screen device context can be
 * momentarily unavailable while the display switches modes (a game going
 * exclusive fullscreen, for example), so one immediate retry covers the
 * transient case.
 */
function dib_screen_copy(dib: { dc: number; bits: number }, entry: EnumeratedWindow): boolean {
	let copied = false;
	for (let attempt = 0; attempt < 2 && !copied; attempt++) {
		const screenDc = address(lib().u.GetDC(0n) as bigint | null);
		if (!screenDc) continue;
		try {
			const source = clamp_to_screen(entry.left, entry.top, entry.width, entry.height);
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
	return copied;
}

/**
 * The Windows capture ladder, cheapest rung first:
 *   1. PrintWindow — the owning app paints itself. Fast and exact, but blank
 *      for a GPU-composited surface, and it has no timeout variant, so a window
 *      the shell already reports as hung skips it: that window would never
 *      answer and the call would block forever.
 *   2. Windows.Graphics.Capture — DWM hands over the window's own composition
 *      surface (`win32-wgc.ts`). This is the rung that keeps working while the
 *      window is covered by another window or its app stopped pumping messages.
 *   3. Screen-region copy — only truthful while the window is the one drawn at
 *      its own centre; otherwise it would return whatever is on top of it, so it
 *      refuses instead of lying.
 * A minimized window stops at PrintWindow: the compositor has no current surface
 * for it, and its last composed frame would be a stale picture presented as the
 * live UI.
 */
function capture_surface(entry: EnumeratedWindow): CapturedSurface {
	const dib = dib_create(entry.width, entry.height);
	let compositor_reason = "";
	try {
		if (!entry.hung) {
			const painted = lib().u.PrintWindow(
				as_ptr(entry.handle),
				as_ptr(dib.dc),
				PW_RENDERFULLCONTENT,
			);
			const pixels = dib_pixels(dib.bits, entry.width * entry.height * 4);
			if (painted && !looks_blank(pixels, entry.width, entry.height)) {
				return { pixels, width: entry.width, height: entry.height, method: "printwindow" };
			}
		}
		if (!entry.minimized) {
			try {
				const frame = wgc_capture_window(entry.handle);
				return { pixels: frame.pixels, width: frame.width, height: frame.height, method: "wgc" };
			} catch (error) {
				compositor_reason = error instanceof Error ? error.message : String(error);
			}
		}
		const is_foreground = address(lib().u.GetForegroundWindow() as bigint | null) === entry.handle;
		if (!is_foreground && !visible_at_center(entry)) {
			throw new Win32Error(background_capture_blocker(entry, compositor_reason));
		}
		if (!dib_screen_copy(dib, entry)) {
			throw new Win32Error(
				"Screen copy failed for this window. The desktop may be switching display modes; retry once it settles.",
			);
		}
		return {
			pixels: dib_pixels(dib.bits, entry.width * entry.height * 4),
			width: entry.width,
			height: entry.height,
			method: "screen-copy",
		};
	} finally {
		dib_dispose(dib);
	}
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
	win32_load();
	const { entry, selection } = resolve_target(options);

	if (entry.width <= 0 || entry.height <= 0) {
		throw new Win32Error(
			`Window '${entry.process}' has an empty area (${entry.width} x ${entry.height}).`,
		);
	}
	const surface = capture_surface(entry);
	bgra_to_rgba(surface.pixels);

	const width = surface.width;
	const height = surface.height;
	const method = surface.method;

	const outPath =
		options.out && options.out.length > 0
			? options.out
			: `${process.env.TEMP ?? process.env.TMP ?? "."}\\pi-ember-screen-${entry.process}-${stamp()}.${format_extension(options.format)}`;

	const { default: sharp } = await import("sharp");
	let pipeline = sharp(surface.pixels, { raw: { width, height, channels: 4 } });
	let finalWidth = width;
	let finalHeight = height;
	const scale = options.scale > 0 ? options.scale : 1;
	const targetWidth =
		options.maxWidth > 0 && width * scale > options.maxWidth
			? options.maxWidth
			: Math.round(width * scale);
	if (scale < 1 || (options.maxWidth > 0 && width * scale > options.maxWidth)) {
		if (targetWidth !== width) {
			finalWidth = Math.max(1, targetWidth);
			finalHeight = Math.max(1, Math.round((height * finalWidth) / width));
			pipeline = sharp(surface.pixels, { raw: { width, height, channels: 4 } }).resize(
				finalWidth,
				finalHeight,
				{
					kernel: "cubic",
				},
			);
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
