/**
 * Pi Ember Screen.
 *
 * Owns two Windows desktop tools for visual verification from inside pi:
 * `window_list` enumerates top-level windows, `window_screenshot` captures one
 * to a PNG and returns it as image content so the model can look at a real
 * running UI instead of inferring it from source.
 *
 * Scope is deliberately narrow: window discovery and pixel capture only. This
 * plugin does not click, type, or drive the desktop, and it owns no harness.
 * Argument shaping and module resolution live here; Win32 work lives in
 * `capture-window.ps1`, which is the only platform-specific piece.
 *
 * Windows-only: the tools are registered only on `win32`, so other platforms
 * never see tools they cannot fulfil.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "capture-window.ps1");
const POWERSHELL = process.env.PI_EMBER_SCREEN_POWERSHELL ?? "powershell.exe";
const CAPTURE_TIMEOUT_MS = 60_000;

interface WindowEntry {
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
}

interface CaptureResult {
	ok: boolean;
	error?: string;
	path: string;
	handle: number;
	pid: number;
	process: string;
	title: string;
	selection: string;
	method: string;
	source_width: number;
	source_height: number;
	width: number;
	height: number;
}

export default function piEmberScreenPlugin(pi: ExtensionAPI): void {
	if (process.platform !== "win32") return;

	async function runCaptureScript(args: string[], signal?: AbortSignal): Promise<unknown> {
		const result = await pi.exec(
			POWERSHELL,
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, ...args],
			{ signal, timeout: CAPTURE_TIMEOUT_MS },
		);

		const stdout = result.stdout.trim();
		const stderr = result.stderr.trim();

		if (!stdout) {
			const detail = stderr ? `: ${stderr}` : "";
			throw new Error(`window capture helper produced no output (exit code ${result.code})${detail}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(`window capture helper returned unparsable output: ${stdout.slice(0, 400)}`);
		}

		if (typeof parsed === "object" && parsed !== null && (parsed as { ok?: boolean }).ok === false) {
			throw new Error((parsed as { error?: string }).error ?? "window capture helper failed");
		}

		return parsed;
	}

	pi.registerTool({
		name: "window_list",
		label: "List Windows",
		description:
			"List visible top-level Windows desktop windows with process name, title, size, pid, and handle. " +
			"Use it to find the window to inspect with window_screenshot.",
		promptSnippet: "List visible desktop windows (process, title, size, handle) on Windows",
		promptGuidelines: [
			"Use window_list before window_screenshot when you do not already know the exact process name or window handle.",
		],
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({
					description: "Optional case-insensitive substring matched against process name or window title.",
				}),
			),
			include_minimized: Type.Optional(
				Type.Boolean({ description: "Include minimized windows in the listing. Defaults to false." }),
			),
			limit: Type.Optional(Type.Number({ description: "Maximum number of windows to return. Defaults to 40." })),
		}),
		async execute(_toolCallId, params, signal) {
			const parsed = (await runCaptureScript(["-List"], signal)) as { windows?: WindowEntry[] };

			let windows = parsed.windows ?? [];
			if (!params.include_minimized) {
				windows = windows.filter((entry) => !entry.minimized);
			}
			if (params.filter) {
				const needle = params.filter.toLowerCase();
				windows = windows.filter(
					(entry) => entry.process.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle),
				);
			}

			const limit = params.limit && params.limit > 0 ? Math.floor(params.limit) : 40;
			const shown = windows.slice(0, limit);

			const lines = shown.map(
				(entry) =>
					`${entry.process} | "${entry.title}" | ${entry.width}x${entry.height} | pid ${entry.pid} | hwnd ${entry.handle}`,
			);

			const text =
				lines.length > 0
					? [
							`${windows.length} window(s)${
								windows.length > shown.length ? ` (showing ${shown.length})` : ""
							}:`,
							...lines,
						].join("\n")
					: "No visible windows matched.";

			return { content: [{ type: "text", text }], details: { windows: shown } };
		},
	});

	pi.registerTool({
		name: "window_screenshot",
		label: "Window Screenshot",
		description:
			"Capture a Windows desktop window (Qt/PySide app, browser, video editor, terminal, dialog) to a PNG and " +
			"return the image so the result can be inspected visually. Target it by process name or window title " +
			"substring, by window handle, or omit both to capture the foreground window.",
		promptSnippet: "Screenshot a Windows desktop window by process name, title, or handle and view the image",
		promptGuidelines: [
			"Use window_screenshot to look at a real running desktop UI instead of guessing what it looks like from source.",
			"Use window_screenshot with a process name such as 'python' to inspect a running local UI harness window.",
			"Do not claim a desktop UI change works until you have inspected a window_screenshot of the running window.",
		],
		parameters: Type.Object({
			window: Type.Optional(
				Type.String({
					description: "Case-insensitive substring matched against the process name or the window title.",
				}),
			),
			handle: Type.Optional(Type.Number({ description: "Exact window handle (hwnd) from window_list." })),
			path: Type.Optional(
				Type.String({
					description: "Output PNG path. Defaults to a timestamped file in the system temp directory.",
				}),
			),
			max_width: Type.Optional(
				Type.Number({
					description: "Downscale so the captured image is at most this many pixels wide. 0 disables. Defaults to 0.",
				}),
			),
			scale: Type.Optional(Type.Number({ description: "Scale factor applied before saving, e.g. 0.5. Defaults to 1." })),
		}),
		async execute(_toolCallId, params, signal) {
			const args: string[] = [];

			if (typeof params.handle === "number" && params.handle > 0) {
				args.push("-Hwnd", String(Math.trunc(params.handle)));
			} else if (params.window) {
				args.push("-Match", params.window);
			}
			if (params.path) {
				args.push("-Out", params.path);
			}
			if (typeof params.scale === "number" && params.scale > 0) {
				args.push("-Scale", String(params.scale));
			}
			if (typeof params.max_width === "number" && params.max_width >= 0) {
				args.push("-MaxWidth", String(Math.trunc(params.max_width)));
			}

			const capture = (await runCaptureScript(args, signal)) as CaptureResult;
			const bytes = await readFile(capture.path);
			const data = bytes.toString("base64");

			const text =
				`${capture.process} | "${capture.title}" | ${capture.width}x${capture.height} ` +
				`(source ${capture.source_width}x${capture.source_height}, ${capture.method}, ${capture.selection})\n` +
				`Saved to ${capture.path}`;

			return {
				content: [
					{ type: "text", text },
					{ type: "image", data, mimeType: "image/png" },
				],
				details: capture,
			};
		},
	});
}
