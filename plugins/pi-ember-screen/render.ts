/**
 * Compact rendering for the Pi Ember Screen tools.
 *
 * Both tools render as a standalone, single-row, bullet-led compact row — the
 * same contract as every other tool row in the transcript: one ANSI-aware
 * truncated line, a transparent shell (no pending/success/error background),
 * and the shared status bullet as the only state indicator.
 *
 * This module owns the row text for both tools; the bullet, the truncating
 * text component, and the bullet color rule come from
 * `pi-compact-tools/renderer.ts` (SSOT) and are never reimplemented here.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { BULLET, CompactGroupText, statusBulletColor } from "../pi-compact-tools/renderer.ts";
import { DEFAULT_FORMAT } from "./encode.ts";

export interface ScreenTheme {
	fg: (key: ThemeColor, text: string) => string;
	bold: (text: string) => string;
}

/** A top-level window as reported by `capture-window.ps1 -List`. */
export interface WindowEntry {
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
	/**
	 * Window is not responding to Windows messages. Its caption is recovered
	 * from the cached cross-process caption, so the title is still usable, but
	 * the window cannot be captured until the owning app pumps messages again.
	 */
	hung?: boolean;
}

export interface ScreenRowArgs {
	filter?: string;
	include_minimized?: boolean;
	limit?: number;
	window?: string;
	handle?: number;
	pid?: number;
	max_width?: number;
	scale?: number;
	/** window_screenshot_timer only. */
	frames?: number;
	interval_ms?: number;
	delay_ms?: number;
}

export interface ScreenRowContext {
	state: Record<string, unknown>;
	args: ScreenRowArgs;
}

const MAX_ROW_MESSAGE_CHARS = 120;

function one_line(value: unknown, fallback = ""): string {
	if (typeof value !== "string" || value.length === 0) return fallback;
	return value.replace(/\s+/g, " ").trim();
}

function truncate_chars(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/** Filter/limit hints shown dim next to the verb, in a stable order. */
function list_extras(args: ScreenRowArgs): string[] {
	const extras: string[] = [];
	const filter = one_line(args.filter);
	if (filter) extras.push(`"${filter}"`);
	if (typeof args.limit === "number" && args.limit > 0) extras.push(`limit ${Math.floor(args.limit)}`);
	if (args.include_minimized) extras.push("incl. minimized");
	return extras;
}

/** Capture target description: handle, window match, or the foreground window. */
function capture_target(args: ScreenRowArgs): string {
	if (typeof args.handle === "number" && args.handle > 0) return `hwnd ${Math.trunc(args.handle)}`;
	if (typeof args.pid === "number" && args.pid > 0) return `pid ${Math.trunc(args.pid)}`;
	const match = one_line(args.window);
	if (match) return `"${match}"`;
	return "foreground";
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function seconds(ms: number): string {
	return `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)}s`;
}

/** First non-empty text part of a tool result — the failure message when a call errored. */
export function screen_error_text(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: string }).type === "text") {
			const text = (part as { text?: string }).text;
			if (typeof text === "string" && text.trim().length > 0) return text.trim();
		}
	}
	return "";
}

/**
 * `window_list` row. Running: `Listing "filter" limit N`. Completed:
 * `Listed 18 windows, 1 not responding`. Error: `List <message>`.
 */
export function format_window_list_row(
	theme: ScreenTheme,
	args: ScreenRowArgs,
	completed: boolean,
	isError: boolean,
	errorText = "",
	windowCount: number | null = null,
	hungCount = 0,
): string {
	const bullet = statusBulletColor(isError, completed, theme);
	const extras = list_extras(args).map((extra) => theme.fg("dim", ` ${extra}`));
	if (isError) {
		const reason = truncate_chars(one_line(errorText, "failed"), MAX_ROW_MESSAGE_CHARS);
		return `${bullet}${theme.fg("error", "List")}${theme.fg("dim", ` ${reason}`)}`;
	}
	if (!completed) {
		return `${bullet}${theme.fg("muted", "Listing")}${extras.join("")}`;
	}
	let summary = "windows";
	if (windowCount !== null) {
		summary = `${windowCount} window${windowCount === 1 ? "" : "s"}`;
		if (hungCount > 0) summary += `, ${hungCount} not responding`;
	}
	return `${bullet}${theme.fg("muted", "Listed")}${theme.fg("text", ` ${summary}`)}${extras.join("")}`;
}

/**
 * `window_screenshot` row. Running: `Capturing "brave"`. Completed:
 * `Captured brave 400x225`. Error: `Capture <message>`.
 */
export function format_window_screenshot_row(
	theme: ScreenTheme,
	args: ScreenRowArgs,
	completed: boolean,
	isError: boolean,
	errorText = "",
	captured: { process?: string; width?: number; height?: number; method?: string; format?: string } | null = null,
): string {
	const bullet = statusBulletColor(isError, completed, theme);
	if (isError) {
		const reason = truncate_chars(one_line(errorText, "failed"), MAX_ROW_MESSAGE_CHARS);
		return `${bullet}${theme.fg("error", "Capture")}${theme.fg("dim", ` ${reason}`)}`;
	}
	if (!completed || !captured) {
		return `${bullet}${theme.fg("muted", "Capturing")}${theme.fg("dim", ` ${capture_target(args)}`)}`;
	}
	const process = one_line(captured.process, "window");
	const size =
		typeof captured.width === "number" && typeof captured.height === "number"
			? ` ${captured.width}x${captured.height}`
			: "";
	const method = captured.method === "screen-copy" ? theme.fg("dim", " screen-copy") : "";
	// The default encoding is not worth row space; an override is.
	const format =
		captured.format && captured.format !== DEFAULT_FORMAT ? theme.fg("dim", ` ${captured.format}`) : "";
	return `${bullet}${theme.fg("muted", "Captured")}${theme.fg("text", ` ${process}${size}`)}${format}${method}`;
}

/**
 * The single shared visual for a screen tool row: a transparent shell around
 * one ANSI-aware truncating compact row. The same component instance is reused
 * across renders (and updated in place from the result slot) so a tool call
 * never grows a second row.
 */
export function render_screen_row(context: ScreenRowContext, text: string): Box {
	const existingText = context.state.callText;
	const callText = existingText instanceof CompactGroupText ? existingText : new CompactGroupText();
	callText.setText(text);
	context.state.callText = callText;

	const existingShell = context.state.callShell;
	const shell = existingShell instanceof Box ? existingShell : new Box(1, 0, undefined);
	context.state.callShell = shell;
	if (shell.children.length === 0) shell.addChild(callText);
	return shell;
}

/**
 * Result slot. The shared row already carries the outcome, so the collapsed
 * result is empty; Ctrl+O expands the detail rows underneath it.
 */
export function render_screen_details(lines: readonly string[]): Text | Box {
	if (lines.length === 0) return new Text("", 0, 0);
	const detail = new CompactGroupText();
	detail.setText(lines.join("\n"));
	const shell = new Box(1, 0, undefined);
	shell.addChild(detail);
	return shell;
}

/** Expanded `window_list` detail rows: one compact line per window. */
export function window_list_detail_lines(theme: ScreenTheme, windows: readonly WindowEntry[]): string[] {
	return windows.map((entry) => {
		const name = [one_line(entry.process, "?"), one_line(entry.title)].filter(Boolean).join(" ");
		const size = `${entry.width}x${entry.height}`;
		const hung = entry.hung ? theme.fg("error", " not responding") : "";
		return `${theme.fg("dim", `  ${name}`)} ${theme.fg("muted", size)} ${theme.fg("dim", `hwnd ${entry.handle}`)}${hung}`;
	});
}

/** Expanded `window_screenshot` detail rows. */
export function window_screenshot_detail_lines(
	theme: ScreenTheme,
	capture: {
		path?: string;
		title?: string;
		selection?: string;
		method?: string;
		source_width?: number;
		source_height?: number;
	},
): string[] {
	const lines: string[] = [];
	if (capture.path) lines.push(theme.fg("dim", `  saved ${capture.path}`));
	if (capture.title) lines.push(theme.fg("dim", `  title ${one_line(capture.title)}`));
	lines.push(
		theme.fg(
			"dim",
			`  ${capture.source_width ?? "?"}x${capture.source_height ?? "?"} captured via ${capture.method ?? "?"} (${capture.selection ?? "?"})`,
		),
	);
	return lines;
}

/**
 * `window_screenshot_timer` row. Running: `Timing pid 1234 6 frames / 250ms`.
 * Completed: `Timed 6 frames in 1.4s brave 1599x1010 sheet`.
 */
export function format_window_frames_row(
	theme: ScreenTheme,
	args: ScreenRowArgs,
	completed: boolean,
	isError: boolean,
	errorText = "",
	burst: WindowFramesSummary | null = null,
): string {
	const bullet = statusBulletColor(isError, completed, theme);
	const requested = [
		typeof args.frames === "number" && args.frames > 0 ? plural(Math.floor(args.frames), "frame") : "",
		typeof args.interval_ms === "number" && args.interval_ms > 0
			? `/${Math.floor(args.interval_ms)}ms`
			: "",
	]
		.filter(Boolean)
		.join(" ");

	if (isError) {
		const reason = truncate_chars(one_line(errorText, "failed"), MAX_ROW_MESSAGE_CHARS);
		return `${bullet}${theme.fg("error", "Timer")}${theme.fg("dim", ` ${reason}`)}`;
	}
	if (!completed || !burst) {
		return `${bullet}${theme.fg("muted", "Timing")}${theme.fg("dim", ` ${capture_target(args)} ${requested}`)}`;
	}
	const count = burst.frames ?? 0;
	const took = typeof burst.duration_ms === "number" ? ` in ${seconds(burst.duration_ms)}` : "";
	const size =
		typeof burst.width === "number" && typeof burst.height === "number"
			? ` ${burst.width}x${burst.height}`
			: "";
	return `${bullet}${theme.fg("muted", "Timed")}${theme.fg("text", ` ${plural(count, "frame")}${took}`)}${theme.fg("dim", ` ${one_line(burst.process, "window")}${size} sheet`)}`;
}

export interface WindowFramesSummary {
	frames?: number;
	duration_ms?: number;
	interval_ms?: number;
	process?: string;
	width?: number;
	height?: number;
}

/** Expanded `window_screenshot_timer` detail rows: the sheet, then each frame. */
export function window_frames_detail_lines(
	theme: ScreenTheme,
	burst: {
		sheet?: { path?: string; width?: number; height?: number };
		frames?: Array<{ path?: string; offset_ms?: number; width?: number; height?: number }>;
		selection?: string;
		interval_ms?: number;
		delay_ms?: number;
	},
): string[] {
	const lines: string[] = [];
	const sheet = burst.sheet ?? {};
	if (sheet.path) {
		const size =
			typeof sheet.width === "number" && typeof sheet.height === "number"
				? ` ${sheet.width}x${sheet.height}`
				: "";
		lines.push(theme.fg("dim", `  sheet${size} ${sheet.path}`));
	}
	if (typeof burst.interval_ms === "number") {
		const delay = burst.delay_ms ? ` after ${burst.delay_ms} ms` : "";
		lines.push(
			theme.fg(
				"dim",
				`  every ${burst.interval_ms} ms${delay}${burst.selection ? ` (${burst.selection})` : ""}`,
			),
		);
	}
	for (const frame of burst.frames ?? []) {
		const offset = typeof frame.offset_ms === "number" ? `${frame.offset_ms} ms` : "?";
		lines.push(theme.fg("dim", `  ${offset.padStart(7)}  ${frame.path ?? ""}`));
	}
	return lines;
}

/** Bullet-only row used when a screen tool is registered but cannot run here. */
export function format_unavailable_row(theme: ScreenTheme, label: string, reason: string): string {
	return `${theme.fg("muted", BULLET)}${theme.fg("muted", label)}${theme.fg("dim", ` ${reason}`)}`;
}
