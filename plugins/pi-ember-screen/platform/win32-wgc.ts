/**
 * Windows.Graphics.Capture (WGC) — the compositor's own pixels for one window.
 *
 * The classic Windows capture APIs cannot read a window that is not the one you
 * can see:
 *   - PrintWindow asks the owning app to paint, so a GPU-composited window
 *     (DirectComposition, flip-model swap chains, WinUI, Chromium) hands back an
 *     empty surface, and a window that stopped pumping messages never answers;
 *   - a screen-region copy reads whatever is *on top* of the window, so it can
 *     only run while that window is the foreground one.
 * WGC does not ask the app at all: DWM keeps a composition surface per top-level
 * window, and `IGraphicsCaptureItemInterop::CreateForWindow` + a free-threaded
 * frame pool hands over exactly the pixels the compositor has for it. That makes
 * occlusion irrelevant and keeps working for a wedged app (its last composed
 * frame is still the truth on screen).
 *
 * Everything here is a direct FFI call: flat exports via bun:ffi plus COM/WinRT
 * vtable calls through `CFunction`. There is no subprocess, no compiler, no
 * PowerShell. The helper process itself is the isolation boundary — pi kills it
 * on deadline, so a wedged capture can never freeze the TUI.
 *
 * IIDs come from the Windows Runtime IDL (wine-mirror/wine
 * `include/windows.graphics.capture.idl` and `windows.graphics.directx.direct3d11.idl`
 * mirror the SDK) and the Win32 interop headers; vtable slots come from the
 * Windows SDK headers. Both are ABI constants of the operating system: they are
 * pinned here once and never re-derived.
 */

import { CFunction, dlopen, FFIType, ptr, read, toArrayBuffer } from "bun:ffi";

/** How long to wait for the pool's first composited frame. */
const FRAME_TIMEOUT_MS = 1500;
/** Poll interval while the pool is still empty. */
const FRAME_POLL_MS = 10;
/** The pool's documented minimum; one capture only needs a single frame. */
const FRAME_POOL_BUFFERS = 2;
/** DXGI_FORMAT_B8G8R8A8_UNORM — the format GDI and the encoders already consume. */
const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const D3D11_SDK_VERSION = 7;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
const D3D_DRIVER_TYPE_HARDWARE = 1;
const D3D11_USAGE_STAGING = 3;
const D3D11_CPU_ACCESS_READ = 0x20000;
const D3D11_MAP_READ = 1;
const RO_INIT_MULTITHREADED = 1;
const REGDB_E_CLASSNOTREG = 0x80040154;
/** D3D11_TEXTURE2D_DESC: 5 UINT32, DXGI_SAMPLE_DESC (2 UINT32), 4 UINT32. */
const TEXTURE2D_DESC_SIZE = 44;
/** D3D11_MAPPED_SUBRESOURCE: void *pData, UINT RowPitch, UINT DepthPitch. */
const MAPPED_SUBRESOURCE_SIZE = 16;
/** ID3D11Texture2D::GetDesc field offsets inside D3D11_TEXTURE2D_DESC. */
const DESC_WIDTH = 0;
const DESC_HEIGHT = 4;
const DESC_FORMAT = 16;

const WGC_CLASS = "Windows.Graphics.Capture.GraphicsCaptureItem";
const POOL_CLASS = "Windows.Graphics.Capture.Direct3D11CaptureFramePool";

/**
 * ABI vtable slots, after the 6 inherited IInspectable methods (0-5 QueryInterface,
 * AddRef, Release, GetIids, GetRuntimeClassName, GetTrustLevel).
 */
const WINRT_SLOT = {
	release: 2,
	/** IGraphicsCaptureItemInterop: IUnknown-derived Win32 interop interface. */
	interop_create_for_window: 3,
	/** IGraphicsCaptureItem: DisplayName, Size, add_Closed, remove_Closed. */
	item_size: 7,
	/** IDirect3D11CaptureFramePool: Recreate, TryGetNextFrame, ±FrameArrived, CreateCaptureSession, DispatcherQueue. */
	pool_try_get_next_frame: 7,
	pool_create_capture_session: 10,
	/** IDirect3D11CaptureFramePoolStatics2: CreateFreeThreaded. */
	pool_create_free_threaded: 6,
	/** IDirect3D11CaptureFrame: Surface, SystemRelativeTime, ContentSize. */
	frame_surface: 6,
	frame_content_size: 8,
	/** IGraphicsCaptureSession: StartCapture. */
	session_start_capture: 6,
	/** IGraphicsCaptureSession2/3: get_/put_IsCursorCaptureEnabled, get_/put_IsBorderRequired. */
	session_put_flag: 7,
	/** IDirect3DDxgiInterfaceAccess: IUnknown-derived, GetInterface. */
	surface_get_interface: 3,
	/** ID3D11Device (IUnknown base): CreateTexture2D. */
	device_create_texture2d: 5,
	/** ID3D11Device (IUnknown base): GetImmediateContext. */
	device_get_immediate_context: 40,
	/** ID3D11DeviceContext (ID3D11DeviceChild adds slots 3-6): Map, Unmap, CopyResource. */
	context_map: 14,
	context_unmap: 15,
	context_copy_resource: 47,
	/** ID3D11Texture2D (IUnknown + DeviceChild + Resource): GetDesc. */
	texture_get_desc: 10,
} as const;

export class WgcError extends Error {}

export interface WgcFrame {
	/** Cropped, top-down BGRA with the same layout as a GDI DIB, so the caller's
	 * single BGRA→RGBA pass applies to every capture method. */
	pixels: Buffer;
	width: number;
	height: number;
}

/**
 * GUID text → the 16 bytes a REFIID points at (Data1/2/3 little-endian, the
 * remaining 8 bytes verbatim). Pure, so the layout is pinned by a test.
 */
export function winrt_guid(text: string): Buffer {
	const parts = text.split("-");
	if (parts.length !== 5) throw new WgcError(`Malformed GUID '${text}'.`);
	const [data1, data2, data3, data4, data5] = parts as [string, string, string, string, string];
	const bytes = Buffer.alloc(16);
	bytes.writeUInt32LE(Number.parseInt(data1, 16), 0);
	bytes.writeUInt16LE(Number.parseInt(data2, 16), 4);
	bytes.writeUInt16LE(Number.parseInt(data3, 16), 6);
	Buffer.from(`${data4}${data5}`, "hex").copy(bytes, 8);
	return bytes;
}

/**
 * Two INT32 passed by value as one 8-byte aggregate: Windows.Graphics.SizeInt32
 * is { Width, Height } and a Win32 POINT is { x, y }. On the Win64 ABI an 8-byte
 * struct travels in a single integer register with the first member in the low
 * half, so an i64 argument carries exactly what the by-value struct would.
 * Pure, so the packing is pinned by a test.
 */
export function pack_int32_pair(first: number, second: number): bigint {
	return BigInt.asUintN(32, BigInt(first)) | (BigInt.asUintN(32, BigInt(second)) << 32n);
}

/** Interface identifiers, as a REFIID points at them (see the IDL note above). */
const IID = {
	graphics_capture_item_interop: winrt_guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),
	graphics_capture_item: winrt_guid("79c3f95b-31f7-4ec2-a464-632ef5d30760"),
	frame_pool_statics2: winrt_guid("589b103f-6bbc-5df5-a991-02e28b3b66d5"),
	session2: winrt_guid("2c39ae40-7d2e-5044-804e-8b6799d4cf9e"),
	session3: winrt_guid("f2cdd966-22ae-5ea1-9596-3a289344c3be"),
	surface_access: winrt_guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1"),
	dxgi_device: winrt_guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c"),
	d3d11_texture2d: winrt_guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"),
} as const;

/**
 * Bun's FFI accepts a raw address as a plain number at runtime, while its
 * published types only allow bigint/Pointer/TypedArray. Every numeric pointer
 * handed to a flat export goes through this one conversion — the same boundary
 * idiom `win32.ts` uses.
 */
function as_ptr(value: number): bigint {
	return value as unknown as bigint;
}

/** 8-byte slot for a pointer-sized out parameter. */
function pointer_slot(): Uint8Array {
	return new Uint8Array(8);
}

function slot_value(slot: Uint8Array): number {
	return read.ptr(ptr(slot), 0);
}

function hresult_text(hr: number): string {
	return `0x${(hr >>> 0).toString(16).padStart(8, "0")}`;
}

function failed(hr: number): boolean {
	return hr < 0;
}

function describe(stage: string, hr: number): string {
	if (hr >>> 0 === REGDB_E_CLASSNOTREG) {
		return "Windows.Graphics.Capture is not available on this version of Windows (it needs Windows 10 1803 or newer)";
	}
	return `${stage} failed (${hresult_text(hr)})`;
}

function bindings_open() {
	const combase = dlopen("combase.dll", {
		RoInitialize: { args: [FFIType.i32], returns: FFIType.i32 },
		RoGetActivationFactory: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		WindowsCreateString: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		WindowsDeleteString: { args: [FFIType.ptr], returns: FFIType.i32 },
	});
	const d3d11 = dlopen("d3d11.dll", {
		D3D11CreateDevice: {
			args: [
				FFIType.ptr,
				FFIType.i32,
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
		CreateDirect3D11DeviceFromDXGIDevice: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
	});
	return {
		c: combase.symbols,
		d: d3d11.symbols,
		close: () => {
			combase.close();
			d3d11.close();
		},
	};
}

let bindings: ReturnType<typeof bindings_open> | null = null;

function lib() {
	if (!bindings) throw new WgcError("Windows.Graphics.Capture bindings are not loaded.");
	return bindings;
}

type NativeMethod = (self: number, ...rest: (number | bigint)[]) => number;

/**
 * bun-types declares CFunction as a callable factory; at runtime it is the
 * constructor that wraps a raw code address into a callable.
 */
const native_method = CFunction as unknown as new (declaration: {
	ptr: bigint;
	args: FFIType[];
	returns: FFIType;
}) => NativeMethod;

/** CFunction wrappers, keyed by the method's code address (one per vtable slot). */
const wrappers = new Map<number, NativeMethod>();

function vtable_call(
	object: number,
	slot: number,
	args: readonly FFIType[],
	returns: FFIType,
	argv: readonly (number | bigint)[],
): number {
	const vtable = read.ptr(object, 0);
	const address = read.ptr(vtable, slot * 8);
	let fn = wrappers.get(address);
	if (!fn) {
		fn = new native_method({ ptr: as_ptr(address), args: [FFIType.ptr, ...args], returns });
		wrappers.set(address, fn);
	}
	return fn(object, ...argv);
}

function release(object: number): void {
	if (!object) return;
	vtable_call(object, WINRT_SLOT.release, [], FFIType.i32, []);
}

function query_interface(object: number, iid: Buffer): number {
	const out = pointer_slot();
	const hr = vtable_call(object, 0, [FFIType.ptr, FFIType.ptr], FFIType.i32, [ptr(iid), ptr(out)]);
	if (failed(hr)) return 0;
	return slot_value(out);
}

function activation_factory(runtime_class: string, iid: Buffer): number {
	const name = Buffer.from(runtime_class, "utf16le");
	const nameOut = pointer_slot();
	const hString = lib().c.WindowsCreateString(ptr(name), runtime_class.length, ptr(nameOut));
	if (failed(hString)) {
		throw new WgcError(describe(`Activating ${runtime_class}`, hString));
	}
	const handle = slot_value(nameOut);
	const out = pointer_slot();
	const hr = lib().c.RoGetActivationFactory(as_ptr(handle), ptr(iid), ptr(out));
	lib().c.WindowsDeleteString(as_ptr(handle));
	if (failed(hr)) throw new WgcError(describe(`Activating ${runtime_class}`, hr));
	return slot_value(out);
}

/** The D3D11 device, its immediate context and the WinRT projection of it. */
interface WgcDevice {
	device: number;
	context: number;
	rt_device: number;
}

function create_device(): WgcDevice {
	const deviceOut = pointer_slot();
	const contextOut = pointer_slot();
	// 11_1, 11_0, 10_1, 10_0 so the device exists on every Windows 10 build.
	const levels = new Uint32Array([0xb000, 0xa100, 0xa000, 0x9300]);
	const hr = lib().d.D3D11CreateDevice(
		null as unknown as bigint,
		D3D_DRIVER_TYPE_HARDWARE,
		null as unknown as bigint,
		D3D11_CREATE_DEVICE_BGRA_SUPPORT,
		ptr(levels),
		levels.length,
		D3D11_SDK_VERSION,
		ptr(deviceOut),
		null as unknown as bigint,
		ptr(contextOut),
	);
	if (failed(hr)) {
		throw new WgcError(
			`No D3D11 device is available for compositor capture (${hresult_text(hr)}). A remote or headless session without a WDDM driver cannot use Windows.Graphics.Capture.`,
		);
	}
	const device = slot_value(deviceOut);
	const context = slot_value(contextOut);
	const dxgiDevice = query_interface(device, IID.dxgi_device);
	if (!dxgiDevice) {
		release(context);
		release(device);
		throw new WgcError("The D3D11 device did not expose IDXGIDevice.");
	}
	const rtDeviceOut = pointer_slot();
	const rtHr = lib().d.CreateDirect3D11DeviceFromDXGIDevice(as_ptr(dxgiDevice), ptr(rtDeviceOut));
	release(dxgiDevice);
	if (failed(rtHr)) {
		release(context);
		release(device);
		throw new WgcError(describe("CreateDirect3D11DeviceFromDXGIDevice", rtHr));
	}
	return { device, context, rt_device: slot_value(rtDeviceOut) };
}

/** A composited window, held only for the duration of one capture. */
interface WgcTarget {
	item: number;
	pool: number;
	session: number;
	width: number;
	height: number;
}

function open_target(handle: number, device: WgcDevice): WgcTarget {
	const interop = activation_factory(WGC_CLASS, IID.graphics_capture_item_interop);
	const itemOut = pointer_slot();
	const itemHr = vtable_call(
		interop,
		WINRT_SLOT.interop_create_for_window,
		[FFIType.ptr, FFIType.ptr, FFIType.ptr],
		FFIType.i32,
		[handle, ptr(IID.graphics_capture_item), ptr(itemOut)],
	);
	release(interop);
	if (failed(itemHr)) {
		throw new WgcError(
			`The compositor cannot capture window ${handle} (${hresult_text(itemHr)}): it is not a top-level window.`,
		);
	}
	const item = slot_value(itemOut);

	const sizeOut = pointer_slot();
	const sizeHr = vtable_call(item, WINRT_SLOT.item_size, [FFIType.ptr], FFIType.i32, [
		ptr(sizeOut),
	]);
	const size = new DataView(sizeOut.buffer);
	if (failed(sizeHr) || size.getInt32(0, true) <= 0 || size.getInt32(4, true) <= 0) {
		release(item);
		throw new WgcError(`The compositor reported no area for window ${handle}.`);
	}
	const width = size.getInt32(0, true);
	const height = size.getInt32(4, true);

	const statics = activation_factory(POOL_CLASS, IID.frame_pool_statics2);
	const poolOut = pointer_slot();
	const poolHr = vtable_call(
		statics,
		WINRT_SLOT.pool_create_free_threaded,
		[FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i64, FFIType.ptr],
		FFIType.i32,
		[
			device.rt_device,
			DXGI_FORMAT_B8G8R8A8_UNORM,
			FRAME_POOL_BUFFERS,
			pack_int32_pair(width, height),
			ptr(poolOut),
		],
	);
	release(statics);
	if (failed(poolHr)) {
		release(item);
		throw new WgcError(describe("Creating the capture frame pool", poolHr));
	}
	const pool = slot_value(poolOut);

	const sessionOut = pointer_slot();
	const sessionHr = vtable_call(
		pool,
		WINRT_SLOT.pool_create_capture_session,
		[FFIType.ptr, FFIType.ptr],
		FFIType.i32,
		[item, ptr(sessionOut)],
	);
	if (failed(sessionHr)) {
		release(pool);
		release(item);
		throw new WgcError(describe("Creating the capture session", sessionHr));
	}
	const session = slot_value(sessionOut);

	// Both are best effort: older builds have neither, and a yellow capture
	// border / drawn cursor only affects presentation, never the pixels we read.
	const cursorFlag = query_interface(session, IID.session2);
	if (cursorFlag) {
		vtable_call(cursorFlag, WINRT_SLOT.session_put_flag, [FFIType.u32], FFIType.i32, [0]);
		release(cursorFlag);
	}
	const borderFlag = query_interface(session, IID.session3);
	if (borderFlag) {
		vtable_call(borderFlag, WINRT_SLOT.session_put_flag, [FFIType.u32], FFIType.i32, [0]);
		release(borderFlag);
	}
	return { item, pool, session, width, height };
}

function close_target(target: WgcTarget): void {
	release(target.session);
	release(target.pool);
	release(target.item);
}

/**
 * The freshest composited frame, or 0 when the pool stayed empty.
 *
 * TryGetNextFrame reports an empty pool as either a null out pointer or a failed
 * HRESULT depending on the build, so both count as "not yet".
 */
function wait_for_frame(pool: number): number {
	const deadline = Date.now() + FRAME_TIMEOUT_MS;
	let newest = 0;
	while (Date.now() < deadline) {
		for (;;) {
			const frameOut = pointer_slot();
			const hr = vtable_call(pool, WINRT_SLOT.pool_try_get_next_frame, [FFIType.ptr], FFIType.i32, [
				ptr(frameOut),
			]);
			const frame = failed(hr) ? 0 : slot_value(frameOut);
			if (!frame) break;
			// A newer buffered frame supersedes the one just handed to us.
			if (newest) release(newest);
			newest = frame;
		}
		if (newest) return newest;
		Bun.sleepSync(FRAME_POLL_MS);
	}
	return newest;
}

/** Copy the frame's pixels out of the GPU into a CPU buffer, cropped to the content area. */
function read_frame_pixels(
	device: WgcDevice,
	texture: number,
	contentWidth: number,
	contentHeight: number,
): { pixels: Buffer; width: number; height: number } | null {
	const desc = Buffer.alloc(TEXTURE2D_DESC_SIZE);
	vtable_call(texture, WINRT_SLOT.texture_get_desc, [FFIType.ptr], FFIType.i32, [ptr(desc)]);
	const surfaceWidth = desc.readUInt32LE(DESC_WIDTH);
	const surfaceHeight = desc.readUInt32LE(DESC_HEIGHT);
	const format = desc.readUInt32LE(DESC_FORMAT);
	const width = Math.min(contentWidth, surfaceWidth);
	const height = Math.min(contentHeight, surfaceHeight);
	if (width <= 0 || height <= 0 || format !== DXGI_FORMAT_B8G8R8A8_UNORM) return null;

	desc.writeUInt32LE(D3D11_USAGE_STAGING, 28);
	desc.writeUInt32LE(0, 32); // BindFlags
	desc.writeUInt32LE(D3D11_CPU_ACCESS_READ, 36);
	desc.writeUInt32LE(0, 40); // MiscFlags
	const stagingOut = pointer_slot();
	const createHr = vtable_call(
		device.device,
		WINRT_SLOT.device_create_texture2d,
		[FFIType.ptr, FFIType.ptr, FFIType.ptr],
		FFIType.i32,
		[ptr(desc), null as unknown as bigint, ptr(stagingOut)],
	);
	if (failed(createHr)) return null;
	const staging = slot_value(stagingOut);
	try {
		vtable_call(
			device.context,
			WINRT_SLOT.context_copy_resource,
			[FFIType.ptr, FFIType.ptr],
			FFIType.void,
			[staging, texture],
		);
		const mapped = Buffer.alloc(MAPPED_SUBRESOURCE_SIZE);
		const mapHr = vtable_call(
			device.context,
			WINRT_SLOT.context_map,
			[FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32, FFIType.ptr],
			FFIType.i32,
			[staging, 0, D3D11_MAP_READ, 0, ptr(mapped)],
		);
		if (failed(mapHr)) return null;
		try {
			const data = slot_value(mapped);
			const rowPitch = mapped.readUInt32LE(8);
			if (!data || rowPitch === 0) return null;
			const pixels = Buffer.allocUnsafe(width * height * 4);
			const source = Buffer.from(toArrayBuffer(data, 0, rowPitch * height));
			for (let row = 0; row < height; row++) {
				source.copy(pixels, row * width * 4, row * rowPitch, row * rowPitch + width * 4);
			}
			return { pixels, width, height };
		} finally {
			vtable_call(
				device.context,
				WINRT_SLOT.context_unmap,
				[FFIType.ptr, FFIType.u32],
				FFIType.void,
				[staging, 0],
			);
		}
	} finally {
		release(staging);
	}
}

/**
 * Capture one top-level window from the DWM composition surface. Returns BGRA
 * pixels (GDI DIB order) sized to the window's content area, or throws WgcError
 * with the reason the compositor could not produce a frame.
 */
export function wgc_capture_window(handle: number): WgcFrame {
	if (process.platform !== "win32") throw new WgcError("Windows.Graphics.Capture is Windows-only.");
	if (!bindings) {
		bindings = bindings_open();
		// S_FALSE / RPC_E_CHANGED_MODE both mean COM is usable already; the calls
		// below report the real failure precisely enough.
		bindings.c.RoInitialize(RO_INIT_MULTITHREADED);
	}
	const device = create_device();
	let target: WgcTarget | null = null;
	let frame = 0;
	try {
		target = open_target(handle, device);
		const startHr = vtable_call(
			target.session,
			WINRT_SLOT.session_start_capture,
			[],
			FFIType.i32,
			[],
		);
		if (failed(startHr)) throw new WgcError(describe("StartCapture", startHr));

		frame = wait_for_frame(target.pool);
		if (!frame) {
			throw new WgcError(
				`The compositor produced no frame for window ${handle} within ${FRAME_TIMEOUT_MS} ms. A minimized window has no current surface; an exclusive-fullscreen game stops Windows from composing every other window.`,
			);
		}

		const contentOut = pointer_slot();
		const contentHr = vtable_call(
			frame,
			WINRT_SLOT.frame_content_size,
			[FFIType.ptr],
			FFIType.i32,
			[ptr(contentOut)],
		);
		const content = new DataView(contentOut.buffer);
		const contentWidth = failed(contentHr) ? target.width : content.getInt32(0, true);
		const contentHeight = failed(contentHr) ? target.height : content.getInt32(4, true);

		const surfaceOut = pointer_slot();
		const surfaceHr = vtable_call(frame, WINRT_SLOT.frame_surface, [FFIType.ptr], FFIType.i32, [
			ptr(surfaceOut),
		]);
		if (failed(surfaceHr))
			throw new WgcError(describe("Reading the captured frame surface", surfaceHr));
		const surface = slot_value(surfaceOut);
		try {
			const access = query_interface(surface, IID.surface_access);
			if (!access)
				throw new WgcError("The captured surface did not expose IDirect3DDxgiInterfaceAccess.");
			try {
				const textureOut = pointer_slot();
				const textureHr = vtable_call(
					access,
					WINRT_SLOT.surface_get_interface,
					[FFIType.ptr, FFIType.ptr],
					FFIType.i32,
					[ptr(IID.d3d11_texture2d), ptr(textureOut)],
				);
				if (failed(textureHr)) {
					throw new WgcError(describe("Opening the captured D3D11 texture", textureHr));
				}
				const texture = slot_value(textureOut);
				try {
					const captured = read_frame_pixels(device, texture, contentWidth, contentHeight);
					if (!captured) {
						throw new WgcError("The captured frame could not be copied to a readable surface.");
					}
					return captured;
				} finally {
					release(texture);
				}
			} finally {
				release(access);
			}
		} finally {
			release(surface);
		}
	} finally {
		if (frame) release(frame);
		if (target) close_target(target);
		release(device.rt_device);
		release(device.context);
		release(device.device);
	}
}

export function wgc_unload(): void {
	for (const wrapper of wrappers.values()) {
		try {
			(wrapper as unknown as { close?: () => void }).close?.();
		} catch {
			// The library handle below closes the code pages anyway.
		}
	}
	wrappers.clear();
	bindings?.close();
	bindings = null;
}
