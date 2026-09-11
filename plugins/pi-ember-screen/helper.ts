/**
 * Ember screen helper — the process that owns every platform-native call.
 *
 * pi runs on Node, so the plugin spawns this file with Bun (`bun helper.ts`):
 * Bun is the only runtime in the stack with a usable FFI, and running the
 * native work out of process means a wedged Win32/CoreGraphics call can be
 * killed outright instead of freezing the TUI (a blocked thread cannot be
 * killed; a blocked process can).
 *
 * Protocol: argv in, exactly one JSON object on stdout, diagnostics on stderr.
 *   { ok: true, ...payload }  and exit 0
 *   { ok: false, error }      and exit 1
 *
 * Never called by the model directly; `index.ts` owns the tool surface.
 */

import { type ScreenHelperOptions, parse_screen_args, ScreenArgsError } from "./args.ts";
import { format_extension } from "./encode.ts";
import {
	type BurstResult,
	type CapturedFrame,
	DEFAULT_SHEET_WIDTH,
	plan_burst,
	run_burst,
} from "./sequence.ts";

/** Where a burst keeps its frames when the caller did not name the sheet. */
function default_sheet_path(format: string): string {
	const dir = process.env.TEMP ?? process.env.TMP ?? ".";
	return `${dir}/pi-ember-screen-${Date.now()}-sheet.${format_extension(format as never)}`;
}

/**
 * One capture, or a timed burst of them. The timer lives inside this process
 * (see sequence.ts): the platform backend still owns target resolution and
 * pixels, so the burst only adds cadence and the contact sheet.
 */
async function capture_or_burst(
	options: ScreenHelperOptions,
	capture: (out: string | undefined, maxWidth: number) => Promise<CapturedFrame>,
): Promise<CapturedFrame | BurstResult> {
	const plan = plan_burst(options);
	if (plan.frames <= 1) return capture(options.out, options.maxWidth);
	return run_burst({
		plan,
		out: options.out ?? default_sheet_path(options.format),
		format: options.format,
		quality: options.quality,
		sheetWidth: options.maxWidth > 0 ? options.maxWidth : DEFAULT_SHEET_WIDTH,
		capture,
	});
}

async function emit(payload: unknown, code: number): Promise<never> {
	await Bun.write(Bun.stdout, JSON.stringify(payload));
	process.exit(code);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const options = parse_screen_args(argv);
	const platform = process.platform;

	if (options.diagnose) {
		const payload: Record<string, unknown> = { ok: true, platform, bun: Bun.version };
		if (platform === "darwin") {
			const darwin = await import("./platform/darwin.ts");
			payload.screen_recording = darwin.screen_recording_allowed();
		}
		if (platform === "win32") {
			const win32 = await import("./platform/win32.ts");
			win32.win32_load();
			payload.windows = win32.enumerate_windows().length;
		}
		await emit(payload, 0);
	}

	if (platform === "win32") {
		const win32 = await import("./platform/win32.ts");
		if (options.list) {
			const result = win32.list_windows({
				limit: options.limit,
				minSize: options.minSize,
				includeMinimized: options.includeMinimized,
				pid: options.pid,
			});
			win32.win32_unload();
			await emit({ ok: true, ...result }, 0);
		}
		const capture = await capture_or_burst(options, (frame_out, frame_max_width) =>
			win32.capture_window({
				handle: options.handle,
				match: options.match,
				pid: options.pid,
				out: frame_out,
				// A burst captures each frame at its final tile size: full
				// resolution only to shrink it again costs the cadence.
				scale: 1,
				maxWidth: frame_max_width,
				format: options.format,
				quality: options.quality,
			}),
		);
		win32.win32_unload();
		await emit({ ok: true, ...capture }, 0);
	}

	if (platform === "darwin") {
		const darwin = await import("./platform/darwin.ts");
		if (options.list) {
			const result = darwin.list_windows({
				limit: options.limit,
				minSize: options.minSize,
				pid: options.pid,
			});
			darwin.darwin_unload();
			await emit({ ok: true, ...result }, 0);
		}
		const capture = await capture_or_burst(options, (frame_out, frame_max_width) =>
			darwin.capture_window({
				handle: options.handle,
				match: options.match,
				pid: options.pid,
				out: frame_out,
				scale: 1,
				maxWidth: frame_max_width,
				format: options.format,
				quality: options.quality,
			}),
		);
		darwin.darwin_unload();
		await emit({ ok: true, ...capture }, 0);
	}

	await emit(
		{ ok: false, error: `Desktop capture is supported on Windows and macOS; this is ${platform}.` },
		1,
	);
}

try {
	await main();
} catch (error) {
	const message =
		error instanceof ScreenArgsError || error instanceof Error ? error.message : String(error);
	await emit({ ok: false, error: message }, 1);
}
