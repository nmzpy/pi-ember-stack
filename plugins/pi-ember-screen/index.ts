/**
 * Pi Ember Screen.
 *
 * Owns three desktop tools for visual verification from inside pi: `window_list`
 * enumerates top-level windows, `window_screenshot` captures one to a PNG and
 * returns it as image content so the model can look at a real running UI
 * instead of inferring it from source, and `window_screenshot_timer` captures
 * that window on a millisecond timer and returns the frames as one contact
 * sheet so motion can be seen while the agent drives the app.
 *
 * Scope is deliberately narrow: window discovery and pixel capture only. The
 * plugin does not click, type, or drive the desktop, and it owns no harness.
 *
 * Windows and macOS. All native work lives in `helper.ts`, which runs under
 * Bun in its own process: pi itself runs on Node, and a blocking
 * PrintWindow/CoreGraphics call must be killable rather than able to freeze the
 * TUI. This process only shapes arguments, enforces the deadline, and renders
 * the compact row.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type CaptureFormat, DEFAULT_FORMAT, format_extension, format_mime_type, parse_format } from "./encode.ts";
import {
	format_window_frames_row,
	format_window_list_row,
	format_window_screenshot_row,
	render_screen_details,
	render_screen_row,
	type ScreenTheme,
	screen_error_text,
	type WindowEntry,
	window_frames_detail_lines,
	window_list_detail_lines,
	window_screenshot_detail_lines,
} from "./render.ts";
import {
	DEFAULT_FRAMES,
	DEFAULT_INTERVAL_MS,
	DEFAULT_SHEET_WIDTH,
	MAX_DELAY_MS,
	MAX_FRAMES,
	MAX_INTERVAL_MS,
	MAX_SHEET_WIDTH,
	MIN_INTERVAL_MS,
	burst_timeout_ms,
	plan_burst,
} from "./sequence.ts";

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "helper.ts");

/**
 * Hard deadlines. The helper owns no watchdog of its own because the parent
 * can always kill the process; these only bound how long the agent waits.
 */
const LIST_TIMEOUT_MS = 20_000;
const CAPTURE_TIMEOUT_MS = 45_000;
const BUN_PROBE_TIMEOUT_MS = 5_000;

const BUN_MISSING_HINT =
	"Bun is required for the desktop window tools and was not found. Install it from https://bun.sh, " +
	"or point PI_EMBER_SCREEN_BUN at the binary.";

interface ListPayload {
	ok?: boolean;
	error?: string;
	count?: number;
	hung_count?: number;
	windows?: WindowEntry[];
}

interface CaptureResult {
	ok?: boolean;
	error?: string;
	path: string;
	handle: number;
	pid: number;
	process: string;
	title: string;
	selection: string;
	method: string;
	format?: string;
	source_width: number;
	source_height: number;
	width: number;
	height: number;
}

/** One frame of a timed burst, as the helper reports it. */
interface BurstFramePayload {
	path: string;
	offset_ms: number;
	width: number;
	height: number;
	method?: string;
}

interface BurstPayload {
	ok?: boolean;
	error?: string;
	sheet: { path: string; width: number; height: number };
	frames: BurstFramePayload[];
	interval_ms: number;
	delay_ms: number;
	duration_ms: number;
	process?: string;
	selection?: string;
}

/**
 * Default output path for a timed burst's contact sheet. The plugin names it
 * rather than the helper because the frames are written beside it with a
 * predictable name (`<sheet base>-f1.webp`, `-f2`, ...).
 */
function default_sheet_path(format: CaptureFormat): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return join(tmpdir(), `pi-ember-screen-${stamp}-sheet.${format_extension(format)}`);
}

function resolve_bun(): string {
	const override = process.env.PI_EMBER_SCREEN_BUN ?? process.env.BUN_BIN;
	if (override) return override;
	if (process.platform === "win32") {
		// A bare `bun` resolves through PATH, which on Windows can hit a shim.
		const home = process.env.USERPROFILE;
		if (home) {
			const bundled = join(home, ".bun", "bin", "bun.exe");
			if (existsSync(bundled)) return bundled;
		}
	}
	return "bun";
}

export default function piEmberScreenPlugin(pi: ExtensionAPI): void {
	const supported_platform = process.platform === "win32" || process.platform === "darwin";
	if (!supported_platform) return;

	const bun = resolve_bun();
	let bun_probe: Promise<void> | null = null;

	/** Fail fast with an install hint when Bun is missing. Re-probes after a failure. */
	function ensure_bun(): Promise<void> {
		if (!bun_probe) {
			bun_probe = pi
				.exec(bun, ["--version"], { timeout: BUN_PROBE_TIMEOUT_MS })
				.then((result) => {
					if (!result.stdout.trim()) throw new Error(BUN_MISSING_HINT);
				})
				.catch(() => {
					// Clear the cache so installing Bun mid-session recovers.
					bun_probe = null;
					throw new Error(BUN_MISSING_HINT);
				});
		}
		return bun_probe;
	}

	pi.on("session_shutdown", () => {
		bun_probe = null;
	});

	async function run_helper(
		args: string[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		await ensure_bun();

		const result = await pi.exec(bun, [HELPER_PATH, ...args], { signal, timeout: timeoutMs });
		const stdout = result.stdout.trim();
		const stderr = result.stderr.trim();

		if (!stdout) {
			const detail = stderr ? `: ${stderr}` : "";
			const reason = result.killed
				? `screen helper did not finish within ${Math.round(timeoutMs / 1000)}s`
				: `screen helper produced no output (exit code ${result.code})`;
			throw new Error(`${reason}${detail}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(`screen helper returned unparsable output: ${stdout.slice(0, 400)}`);
		}

		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("screen helper returned an unexpected payload");
		}

		const payload = parsed as Record<string, unknown>;
		if (payload.ok === false) {
			throw new Error(typeof payload.error === "string" ? payload.error : "screen helper failed");
		}

		return payload;
	}

	pi.registerTool({
		name: "window_list",
		label: "List Windows",
		description:
			"List visible top-level desktop windows with process name, title, size, pid, and handle (Windows and macOS). " +
			"Windows smaller than 32px on either edge are omitted. Use it to find the window to inspect with " +
			"window_screenshot. Windows marked 'not responding' can still be captured: the compositor keeps their last composed frame. " +
			"Pass a pid to list only one process's windows instead of the whole desktop.",
		promptSnippet: "List visible desktop windows (process, title, size, handle, pid)",
		promptGuidelines: [
			"Use window_list before window_screenshot when you do not already know the exact process name or window handle.",
			"To inspect a process you started, pass its pid (window_list {pid}) or go straight to window_screenshot {pid} — no listing needed.",
		],
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({
					description:
						"Optional case-insensitive substring matched against process name or window title.",
				}),
			),
			pid: Type.Optional(
				Type.Number({
					description:
						"List only this process's windows, e.g. the pid of a process you started (`cmd & echo $!`).",
				}),
			),
			include_minimized: Type.Optional(
				Type.Boolean({
					description: "Include minimized windows in the listing. Defaults to false.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of windows to return. Defaults to 40." }),
			),
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return render_screen_row(context, format_window_list_row(theme, args, false, false));
		},

		renderResult(result, options, theme, context) {
			const screenTheme: ScreenTheme = theme;
			const details = (result.details ?? {}) as ListPayload;
			render_screen_row(
				context,
				format_window_list_row(
					screenTheme,
					context.args,
					!options.isPartial,
					context.isError,
					screen_error_text(result.content),
					typeof details.count === "number" ? details.count : null,
					typeof details.hung_count === "number" ? details.hung_count : 0,
				),
			);
			if (!options.expanded) return new Text("", 0, 0);
			return render_screen_details(window_list_detail_lines(screenTheme, details.windows ?? []));
		},

		async execute(_toolCallId, params, signal) {
			const args = params.include_minimized ? ["--list", "--include-minimized"] : ["--list"];
			if (typeof params.pid === "number" && params.pid > 0) {
				args.push("--pid", String(Math.trunc(params.pid)));
			}
			const parsed = (await run_helper(args, LIST_TIMEOUT_MS, signal)) as ListPayload;

			let windows = parsed.windows ?? [];
			if (!params.include_minimized) {
				windows = windows.filter((entry) => !entry.minimized);
			}
			if (params.filter) {
				const needle = params.filter.toLowerCase();
				windows = windows.filter(
					(entry) =>
						entry.process.toLowerCase().includes(needle) ||
						entry.title.toLowerCase().includes(needle),
				);
			}

			const limit = params.limit && params.limit > 0 ? Math.floor(params.limit) : 40;
			const shown = windows.slice(0, limit);
			const hung = shown.filter((entry) => entry.hung).length;

			const lines = shown.map((entry) => {
				const state = entry.hung ? " | NOT RESPONDING" : "";
				return `${entry.process} | "${entry.title}" | ${entry.width}x${entry.height} | pid ${entry.pid} | hwnd ${entry.handle}${state}`;
			});

			const text =
				lines.length > 0
					? [
							`${windows.length} window(s)${
								windows.length > shown.length ? ` (showing ${shown.length})` : ""
							}${hung > 0 ? `, ${hung} not responding` : ""}:`,
							...lines,
						].join("\n")
					: "No visible windows matched.";

			return {
				content: [{ type: "text", text }],
				details: { windows: shown, count: windows.length, hung_count: hung },
			};
		},
	});

	pi.registerTool({
		name: "window_screenshot",
		label: "Window Screenshot",
		description:
			"Capture a desktop window (Qt/PySide app, browser, video editor, terminal, dialog) to a PNG and return the " +
			"image so the result can be inspected visually (Windows and macOS). Target it by process name or window " +
			"title substring, by process id, by window handle, or omit them to capture the foreground window. On Windows the capture " +
			"reads the window's own compositor surface, so a covered window or an app that stopped responding still " +
			"returns its real pixels; only a minimized window, or one hidden while an exclusive-fullscreen game owns " +
			"the display, has nothing to read. On macOS the terminal needs Screen Recording permission. If several " +
			"targets are given, the window handle wins over the pid, and the pid over the name match.",
		promptSnippet:
			"Screenshot a desktop window by process name, title, pid, or handle and view the image",
		promptGuidelines: [
			"Use window_screenshot to look at a real running desktop UI instead of guessing what it looks like from source.",
			"Use window_screenshot with a process name such as 'python' to inspect a running local UI harness window.",
			"Target the window by pid when you started the process yourself (`myapp & echo $!`): window_screenshot {pid} finds it without listing windows. A pid only matches for as long as that process owns a visible window.",
			"Do not claim a desktop UI change works until you have inspected a window_screenshot of the running window.",
		],
		parameters: Type.Object({
			window: Type.Optional(
				Type.String({
					description:
						"Case-insensitive substring matched against the process name or the window title.",
				}),
			),
			handle: Type.Optional(Type.Number({ description: "Exact window handle from window_list." })),
			pid: Type.Optional(
				Type.Number({
					description:
						"Process id whose window to capture — the pid of a process you started (`myapp & echo $!`). Exact, so it needs no listing and no name matching.",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Output PNG path. Defaults to a timestamped file in the system temp directory.",
				}),
			),
			max_width: Type.Optional(
				Type.Number({
					description:
						"Downscale so the captured image is at most this many pixels wide. 0 disables. Defaults to 0.",
				}),
			),
			scale: Type.Optional(
				Type.Number({
					description: "Scale factor applied before saving, e.g. 0.5. Defaults to 1.",
				}),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("png"), Type.Literal("webp"), Type.Literal("jpeg")], {
					description:
						"Image format. Defaults to webp (lossless, about a quarter of the PNG bytes at identical pixels — measured on a real window capture). Use png when a terminal or tool needs the PNG container. jpeg only pays off for photographic content and smears UI text.",
				}),
			),
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return render_screen_row(context, format_window_screenshot_row(theme, args, false, false));
		},

		renderResult(result, options, theme, context) {
			const screenTheme: ScreenTheme = theme;
			const details = (result.details ?? {}) as Partial<CaptureResult>;
			render_screen_row(
				context,
				format_window_screenshot_row(
					screenTheme,
					context.args,
					!options.isPartial,
					context.isError,
					screen_error_text(result.content),
					typeof details.width === "number"
						? {
								process: details.process,
								width: details.width,
								height: details.height,
								method: details.method,
								format: details.format,
							}
						: null,
				),
			);
			if (!options.expanded) return new Text("", 0, 0);
			return render_screen_details(window_screenshot_detail_lines(screenTheme, details));
		},

		async execute(_toolCallId, params, signal) {
			const args: string[] = [];

			if (typeof params.handle === "number" && params.handle > 0) {
				args.push("--handle", String(Math.trunc(params.handle)));
			}
			if (typeof params.pid === "number" && params.pid > 0) {
				args.push("--pid", String(Math.trunc(params.pid)));
			}
			if (params.window) {
				args.push("--match", params.window);
			}
			if (params.path) {
				args.push("--out", params.path);
			}
			if (typeof params.scale === "number" && params.scale > 0) {
				args.push("--scale", String(params.scale));
			}
			if (typeof params.max_width === "number" && params.max_width >= 0) {
				args.push("--max-width", String(Math.trunc(params.max_width)));
			}
			const format = parse_format(params.format ?? DEFAULT_FORMAT);
			args.push("--format", format);

			const capture = (await run_helper(
				args,
				CAPTURE_TIMEOUT_MS,
				signal,
			)) as unknown as CaptureResult;
			const bytes = await readFile(capture.path);
			const data = bytes.toString("base64");

			const text =
				`${capture.process} | "${capture.title}" | ${capture.width}x${capture.height} ` +
				`(source ${capture.source_width}x${capture.source_height}, ${capture.method}, ${capture.selection})\n` +
				`Saved to ${capture.path}`;

			return {
				content: [
					{ type: "text", text },
					{ type: "image", data, mimeType: format_mime_type(format) },
				],
				details: capture,
			};
		},
	});

	/**
	 * The screenshot timer. "Does it look right" is `window_screenshot`; "what is
	 * it doing" needs several frames, and the interesting ones are usually taken
	 * while the agent is busy driving the app — hence `executionMode: parallel`,
	 * so a burst and the interaction that exercises the UI run in one batch.
	 */
	pi.registerTool({
		name: "window_screenshot_timer",
		label: "Window Screenshot Timer",
		description:
			"Capture one desktop window repeatedly on a millisecond timer and return every frame as a single contact sheet, " +
			"so motion, animation, a reflow, or a flash of state between two stills can be seen (Windows and macOS). " +
			"Targeting works exactly like window_screenshot (process name or title substring, pid, handle, else the " +
			"foreground window). Runs in parallel with other tool calls, so the burst and whatever drives the app can go in " +
			"the same batch; the frames share one cadence and arrive as one image.",
		promptSnippet: "Timed burst of window captures, returned as one contact sheet",
		promptGuidelines: [
			"Use window_screenshot_timer to see motion in a running UI: start the burst and drive the app in the same parallel tool batch, then read the sheet — one image, so a sequence costs about as much as a single screenshot.",
			"Set interval_ms to how fast the thing moves (50-10000) and frames to how much of it you need (1-24); a single frame is just a screenshot.",
			"Use delay_ms to start the burst just before the interaction that runs alongside it.",
			"Frames are captured at contact-sheet tile size so the requested cadence holds on a large window; use window_screenshot for one moment at full resolution.",
		],
		parameters: Type.Object({
			window: Type.Optional(
				Type.String({
					description:
						"Case-insensitive substring matched against the process name or the window title.",
				}),
			),
			handle: Type.Optional(Type.Number({ description: "Exact window handle from window_list." })),
			pid: Type.Optional(
				Type.Number({
					description:
						"Process id whose window to capture — the pid of a process you started (`myapp & echo $!`).",
				}),
			),
			interval_ms: Type.Optional(
				Type.Integer({
					minimum: MIN_INTERVAL_MS,
					maximum: MAX_INTERVAL_MS,
					description: `Milliseconds between frames. Defaults to ${DEFAULT_INTERVAL_MS}.`,
				}),
			),
			frames: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_FRAMES,
					description: `Number of frames. Defaults to ${DEFAULT_FRAMES}.`,
				}),
			),
			delay_ms: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: MAX_DELAY_MS,
					description:
						"Wait this long before the first frame. Defaults to 0 — start capturing immediately.",
				}),
			),
			max_width: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: MAX_SHEET_WIDTH,
					description: `Width cap for the contact sheet. Defaults to ${DEFAULT_SHEET_WIDTH}.`,
				}),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("png"), Type.Literal("webp"), Type.Literal("jpeg")], {
					description: "Image format for the sheet and its frames. Defaults to webp (lossless).",
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						"Output path for the contact sheet. Defaults to a timestamped file in the system temp directory; the frames are written beside it.",
				}),
			),
		}),
		executionMode: "parallel",
		renderShell: "self",

		renderCall(args, theme, context) {
			return render_screen_row(context, format_window_frames_row(theme, args, false, false));
		},

		renderResult(result, options, theme, context) {
			const screenTheme: ScreenTheme = theme;
			const details = (result.details ?? {}) as Partial<BurstPayload>;
			render_screen_row(
				context,
				format_window_frames_row(
					screenTheme,
					context.args,
					!options.isPartial,
					context.isError,
					screen_error_text(result.content),
					{
						frames: details.frames?.length,
						duration_ms: details.duration_ms,
						process: details.process,
						width: details.sheet?.width,
						height: details.sheet?.height,
					},
				),
			);
			if (!options.expanded) return new Text("", 0, 0);
			return render_screen_details(window_frames_detail_lines(screenTheme, details));
		},

		async execute(_toolCallId, params, signal) {
			const plan = plan_burst({
				frames: params.frames,
				intervalMs: params.interval_ms,
				delayMs: params.delay_ms,
			});
			const format = parse_format(params.format ?? DEFAULT_FORMAT);
			const args: string[] = [];

			if (typeof params.handle === "number" && params.handle > 0) {
				args.push("--handle", String(Math.trunc(params.handle)));
			}
			if (typeof params.pid === "number" && params.pid > 0) {
				args.push("--pid", String(Math.trunc(params.pid)));
			}
			if (params.window) {
				args.push("--match", params.window);
			}
			args.push("--frames", String(plan.frames));
			args.push("--interval-ms", String(plan.intervalMs));
			if (plan.delayMs > 0) args.push("--delay-ms", String(plan.delayMs));
			args.push(
				"--max-width",
				String(
					typeof params.max_width === "number" && params.max_width > 0
						? Math.trunc(params.max_width)
						: DEFAULT_SHEET_WIDTH,
				),
			);
			args.push("--format", format);
			args.push("--out", params.path ?? default_sheet_path(format));

			const burst = (await run_helper(
				args,
				burst_timeout_ms(plan),
				signal,
			)) as unknown as BurstPayload;
			const bytes = await readFile(burst.sheet.path);
			const data = bytes.toString("base64");

			const target = burst.process
				? `${burst.process}${burst.selection ? ` (${burst.selection})` : ""}`
				: "window";
			const delay = burst.delay_ms > 0 ? `, ${burst.delay_ms} ms delay` : "";
			const text = [
				`${burst.frames.length} frame${burst.frames.length === 1 ? "" : "s"} every ${burst.interval_ms} ms ` +
					`(${burst.duration_ms} ms total${delay}) from ${target}` +
					`\ncontact sheet ${burst.sheet.width}x${burst.sheet.height}: ${burst.sheet.path}` +
					"\nframes (sheet-sized tiles; window_screenshot gives one moment full size):" +
					burst.frames.map((frame) => `\n  ${frame.offset_ms} ms  ${frame.path}`).join(""),
			].join("");

			return {
				content: [
					{ type: "text", text },
					{ type: "image", data, mimeType: format_mime_type(format) },
				],
				details: burst,
			};
		},
	});
}
