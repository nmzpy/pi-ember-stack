import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseStreamingJson } from "@earendil-works/pi-ai/compat";
import * as Diff from "diff";
import { patch_files_from_input, format_patch_error_row, patch_file_errors_by_path, patch_has_file_errors, type ApplyPatchDetails, type PatchFileRow } from "../pi-ember-applypatch/display.ts";
import { BULLET, CompactGroupText } from "./compact-text.ts";
import {
	MUTED_GROUP_GRADIENT_PRESET,
	requestTuiRender,
	subscribeGradientTick,
	unsubscribeGradientTick,
} from "../pi-ember-ui/index.ts";
import { get_gradient_phase, render_gradient } from "../pi-ember-ui/gradient.ts";
import { isThinkingBlocksHidden } from "../pi-ember-ui/mode-colors.ts";


/** Minimal theme shape used by compact rendering: fg(tag, text) and bold(text). */
interface ThemeLike {
	fg(tag: string, text: string): string;
	bold(text: string): string;
}

/** Loose tool-argument shape covering fields accessed by the renderer. */
interface ToolArgs {
	file_path?: string;
	path?: string;
	pattern?: string;
	command?: string;
	content?: string;
	oldText?: string;
	newText?: string;
	edits?: unknown;
	input?: string;
	offset?: number;
	limit?: number;
	[key: string]: unknown;
}

/** A single content item inside a tool result. */
interface ToolContentItem {
	type: string;
	text?: string;
}

/** Loose tool-result shape covering fields read by the renderer. */
interface ToolResult {
	content?: ToolContentItem[];
	details?: {
		diff?: string;
		totalMatched?: number;
	};
	[key: string]: unknown;
}

const DISCOVERY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const GROUPABLE_TOOLS = new Set([...DISCOVERY_TOOLS, "edit", "write", "bash", "apply_patch"]);

/** Exploring-style child tree gutter — SSOT for compact groups and subagents. */
export const TREE_BRANCH_PIPE = "  │ ";
/** Tee branch for non-terminal subagent rows (vertical continues + opens right). */
export const TREE_BRANCH_TEE = "  ├ ";
export const TREE_BRANCH_LAST = "  └ ";
/** Nested subagent tool rows — the └ sits on the agent-name column
 *  (`  ├ ` / `  └ ` place the name at column 4; tool └ goes there too). */
export const TREE_NESTED_PIPE = "  │ └";
export const TREE_NESTED_LAST = "    └";
/** Single subagent tool row — └ on the agent-name column after `• `. */
export const TREE_SINGLE_TOOL = "  └";

export { BULLET, CompactGroupText } from "./compact-text.ts";

/** SSOT fg token for compact tool call labels/details — running text, completed muted. */
export function compact_tool_fg_token(completed: boolean): "muted" | "text" {
	return completed ? "muted" : "text";
}

function paint_compact_tool(theme: ThemeLike, text: string, completed: boolean): string {
	return theme.fg(compact_tool_fg_token(completed), text);
}

function paint_compact_tool_label(theme: ThemeLike, label: string, completed: boolean): string {
	return theme.fg(compact_tool_fg_token(completed), theme.bold(label));
}

export type ToolRenderContext = {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	expanded?: boolean;
	isError?: boolean;
};

export type ToolRenderResultOptions = {
	isPartial: boolean;
	expanded?: boolean;
};

export type CompactCall = {
	id: string;
	name: string;
	args: ToolArgs;
	group?: DiscoveryGroup;
	invalidate?: () => void;
	isError: boolean;
	_completed?: boolean;
	result?: ToolResult;
	/** Standalone (non-group-owner) call row visual — repainted on theme change. */
	callText?: CompactGroupText;
	/** Last rendered terminal row count for shrink snap detection. */
	lastRenderedLineCount?: number;
	/** Set when the next invalidation should snap after line-count shrink. */
	pendingShrink?: boolean;
};

export type DiscoveryGroup = {
	records: CompactCall[];
	/** Group type and its matching present/past-tense label pair. */
	type?: "discovery" | "editing" | "writing" | "bashing" | "patching";
	/** The groupKey value that created this group. */
	key?: string;
	/**
	 * The record whose component renders the group header. Set once at
	 * group creation to the first member and never changed.
	 */
	renderOwner?: CompactCall;
	hasNonDiscovery?: boolean;
	/**
	 * Whether the agent has demonstrably moved on from this group (emitted
	 * visible user-facing text, started a non-group tool, or started a tool
	 * in a different group). New same-key calls cannot join a settled group;
	 * completed members are absorbed into the past-tense header summary,
	 * except the latest completed child which lingers until the next baby
	 * arrives or the group settles.
	 */
	settled?: boolean;
	/** Set when a hard boundary splits the group — never reopen across this row. */
	hardExited?: boolean;
	/**
	 * When hidden thinking interrupts a settled group, render the gradient
	 * Thinking label in the single child row slot (replacing any lingering
	 * Searching/Reading child) instead of a separate status row.
	 */
	thinkingChild?: boolean;
	/**
	 * Shared visual handle for the group block. The owner re-binds this
	 * to its live `Text` on every `renderCall`; members write into it
	 * directly via `setText` in `renderResultInner` so the group stays
	 * visible across Pi rebuilds (thinking-toggle, compaction, settings)
	 * without relying on owner invalidation.
	 */
	callText?: CompactGroupText;
	/** Last rendered terminal row count for shrink snap detection. */
	lastRenderedLineCount?: number;
	/** Set when the next invalidation should snap after line-count shrink. */
	pendingShrink?: boolean;
};

type LineCountTarget = {
	lastRenderedLineCount?: number;
	pendingShrink?: boolean;
};

function set_compact_call_text(target: LineCountTarget, callText: CompactGroupText, text: string): void {
	const prev = target.lastRenderedLineCount ?? 0;
	const line_count = text.length === 0 ? 0 : text.split("\n").length;
	target.lastRenderedLineCount = line_count;
	if (prev > 0 && line_count < prev) {
		target.pendingShrink = true;
	}
	callText.setText(text);
}

function textValue(value: unknown, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	return String(value).replace(/[\r\n]+/g, " ");
}

function toolPath(args: ToolArgs): string {
	return textValue(args?.file_path ?? args?.path, ".");
}

function normalizedTargetPath(args: ToolArgs): string {
	const target = toolPath(args).replace(/\\/g, "/").replace(/\/+$/, "");
	return target || ".";
}

function targetPathForRecord(record: CompactCall): string {
	if (record.name === "bash") {
		return bashGrepInfo(textValue(record.args?.command))?.path ?? normalizedTargetPath(record.args);
	}
	return normalizedTargetPath(record.args);
}

function readRangeLabel(args: ToolArgs): string {
	const parts: string[] = [];
	if (typeof args?.offset === "number") parts.push(`offset ${args.offset}`);
	if (typeof args?.limit === "number") {
		parts.push(`${args.limit} ${args.limit === 1 ? "line" : "lines"}`);
	}
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function bashCdDir(command: string): string | undefined {
	const match = /^\s*cd\s+([^\s&]+)\s*&&\s*/.exec(command);
	return match?.[1];
}

/** Bash call preview — drop grouped `cd … &&` prefixes and a redundant leading `bash `. */
export function strip_bash_command_preview(command: string, inGroup = false): string {
	let stripped = command;
	if (inGroup) {
		stripped = stripped.replace(/^\s*cd\s+[^\s&]+\s*&&\s*/, "") || stripped;
	}
	return stripped.replace(/^\s*bash\s+/, "") || stripped;
}

/**
 * Detect bash commands that are grep invocations (optionally preceded by
 * `cd <dir> &&`). Returns the extracted pattern and path so the call
 * can render as "Search" and join the discovery group.
 */
function bashGrepInfo(command: string): { pattern: string; path: string } | undefined {
	const stripped = command.replace(/^\s*cd\s+([^\s&]+)\s*&&\s*/, "");
	if (!/^\s*grep\b/.test(stripped)) return undefined;
	const cdDir = bashCdDir(command);
	const path = cdDir ?? ".";
	const afterGrep = stripped.replace(/^\s*grep\s+/, "");
	const cmdBeforePipe = afterGrep.split(/\s+[|>]/)[0];
	const parts = cmdBeforePipe.trim().split(/\s+/);
	let pattern: string | undefined;
	for (const part of parts) {
		if (!part.startsWith("-")) {
			pattern = part;
			break;
		}
	}
	if (!pattern) return undefined;
	pattern = pattern.replace(/^["']|["']$/g, "");
	return { pattern, path };
}

function groupKey(name: string, args: ToolArgs): string | undefined {
	const type = resolve_compact_group_type(name, args);
	if (!type) return undefined;
	return `__${type}__`;
}

/** Compact group bucket for a tool name + args — SSOT for compact + cursor. */
export type CompactGroupType = NonNullable<DiscoveryGroup["type"]>;

export function resolve_compact_group_type(
	name: string,
	args: ToolArgs = {},
): CompactGroupType | undefined {
	if (DISCOVERY_TOOLS.has(name)) return "discovery";
	if (name === "edit") return "editing";
	if (name === "write") return "writing";
	if (name === "bash") {
		const command = textValue(args?.command);
		if (bashGrepInfo(command)) return "discovery";
		return "bashing";
	}
	if (name === "apply_patch") return "patching";
	return undefined;
}

function patch_input(args: ToolArgs): string {
	const raw = args?.input;
	if (raw === undefined || raw === null) return "";
	return String(raw);
}

function patch_files_for_record(record: CompactCall): PatchFileRow[] {
	if (record.name !== "apply_patch") return [];
	return patch_files_from_input(patch_input(record.args));
}

function patch_files_in_group(group: DiscoveryGroup): PatchFileRow[] {
	const rows: PatchFileRow[] = [];
	for (const record of group.records) {
		rows.push(...patch_files_for_record(record));
	}
	return rows;
}

function errorText(result: ToolResult | undefined, isError: boolean): string | undefined {
	const content = result?.content?.find((item: ToolContentItem) => item.type === "text");
	if (!isError && !content?.text?.startsWith("Error")) return undefined;
	const text = typeof content?.text === "string" ? content.text : "Tool failed";
	return text.replace(/\r\n?/g, "\n").split("\n")[0] || "Tool failed";
}

function compactErrorComponent(error: string, theme: ThemeLike): Component {
	const component = new CompactGroupText();
	component.setText(theme.fg("error", error));
	return component;
}

function fullOutputText(result: ToolResult | undefined): string {
	const content = result?.content?.find((item: ToolContentItem) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return "";
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatExpandedOutput(result: ToolResult | undefined, theme: ThemeLike): string {
	const text = fullOutputText(result).trimEnd();
	if (!text) return "";
	return (
		"\n" +
		text
			.split("\n")
			.map((line) => theme.fg("text", line))
			.join("\n")
	);
}

function bashLastLine(result: ToolResult | undefined): string | undefined {
	const content = result?.content?.find((item: ToolContentItem) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return undefined;
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length > 0) return line;
	}
	return undefined;
}

function formatBashResultLine(
	result: ToolResult | undefined,
	theme: ThemeLike,
	isError = false,
): string {
	if (isError) return "";
	const lastLine = bashLastLine(result);
	if (lastLine === undefined) return "";
	return `\n${paint_compact_tool(theme, "  ", true)}${theme.fg("text", lastLine)}`;
}

function diffStats(result: ToolResult | undefined): { additions: number; removals: number } {
	const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

/**
 * Extract edits from streaming edit args. Handles both the structured
 * array form and models that stream `edits` as a JSON string (e.g.
 * Opus 4.6 / GLM-5.1). The native tool's `prepareArguments` repairs the
 * string at execution time, but the renderer needs the array during
 * streaming so live +N -N counts can update in real time.
 */
function extractStreamingEdits(
	args: ToolArgs,
): Array<{ oldText: string; newText: string }> | undefined {
	if (args == null) return undefined;
	if (Array.isArray(args.edits)) return args.edits;
	if (typeof args.edits === "string") {
		const trimmed = args.edits.trim();
		if (!trimmed) return undefined;
		// Use the partial-JSON parser so a truncated streaming `edits` string
		// (e.g. GLM / Opus 4.6 streaming edits as JSON) yields a usable array
		// instead of throwing. parseJsonWithRepair throws on unterminated
		// strings, which silently killed the live +N -N path for these
		// providers until the tool completed. parseStreamingJson returns a
		// best-effort partial array (or {}) and never throws.
		const parsed = parseStreamingJson(trimmed);
		if (Array.isArray(parsed)) return parsed;
	}
	if (typeof args.oldText === "string" || typeof args.newText === "string") {
		return [{ oldText: args.oldText ?? "", newText: args.newText ?? "" }];
	}
	return undefined;
}

/**
 * Live line-diff counts from streaming edit args (before the tool runs).
 * As the model streams oldText/newText token-by-token, renderCall fires
 * repeatedly; this computes a running +N -N so the row updates in real
 * time from 1 toward the final count. Returns undefined when there is
 * nothing to diff yet (no edits or empty strings).
 */
function streamingEditStats(args: ToolArgs): { additions: number; removals: number } | undefined {
	const edits = extractStreamingEdits(args);
	if (!edits || edits.length === 0) return undefined;
	let additions = 0;
	let removals = 0;
	let hasContent = false;
	for (const edit of edits) {
		const oldText = typeof edit?.oldText === "string" ? edit.oldText : "";
		const newText = typeof edit?.newText === "string" ? edit.newText : "";
		if (oldText.length > 0 || newText.length > 0) hasContent = true;
		const counts = lineDiffCounts(oldText, newText);
		additions += counts.additions;
		removals += counts.removals;
	}
	// Suppress +0 -0 placeholders while the model is still filling args.
	if (!hasContent) return undefined;
	return { additions, removals };
}

/** Live line count from streaming write args (before the tool runs). */
function streamingWriteStats(args: ToolArgs): { additions: number; removals: number } | undefined {
	const content = typeof args?.content === "string" ? args.content : "";
	if (content.length === 0) return undefined;
	const additions = contentLineCount(content);
	// Suppress +0 -0 placeholders while the model is still filling args.
	if (additions === 0) return undefined;
	return { additions, removals: 0 };
}

/** Count non-empty lines in a text block, normalizing trailing newlines. */
function contentLineCount(text: string): number {
	if (!text) return 0;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 1 && text.endsWith("\n")) lines.pop();
	let count = 0;
	for (const line of lines) {
		if (line.length > 0) count++;
	}
	return count;
}

/** Count added/removed lines between two text blocks via a line-level diff. */
function lineDiffCounts(oldText: string, newText: string): { additions: number; removals: number } {
	if (!oldText && !newText) return { additions: 0, removals: 0 };
	const oldLines = oldText.length ? oldText.replace(/\r\n/g, "\n").split("\n") : [];
	const newLines = newText.length ? newText.replace(/\r\n/g, "\n").split("\n") : [];
	// Drop a single trailing empty string from the final newline so a
	// trailing \n doesn't count as an extra line.
	if (oldLines.length > 1 && oldText.endsWith("\n")) oldLines.pop();
	if (newLines.length > 1 && newText.endsWith("\n")) newLines.pop();
	const parts = Diff.diffArrays(oldLines, newLines);
	let additions = 0;
	let removals = 0;
	for (const part of parts) {
		if (part.added) additions += part.value.length;
		else if (part.removed) removals += part.value.length;
	}
	return { additions, removals };
}

function matchCount(result: ToolResult | undefined): number | undefined {
	const total = result?.details?.totalMatched;
	if (typeof total === "number") return total;
	return undefined;
}

function matchLabel(result: ToolResult | undefined, theme: ThemeLike): string {
	const total = matchCount(result);
	if (total === undefined) return "";
	const label = total === 1 ? "1 match" : `${total} matches`;
	// Match counts stay muted/normal — never the live mode accent.
	return paint_compact_tool(theme, "  ", true) + theme.fg("muted", label);
}

export const PULSE_INTERVAL_MS = 600;

/**
 * Canonical status-bullet color: error→red, completed→green, else static
 * muted. Running state is shown by gradient child verbs (Searching, Reading,
 * Bashing, …) — bullets do not pulse.
 */
export function statusBulletColor(
	isError: boolean,
	isCompleted: boolean,
	theme: ThemeLike,
): string {
	if (isError) return theme.fg("error", BULLET);
	if (isCompleted) return theme.fg("success", BULLET);
	return theme.fg("muted", BULLET);
}

/**
 * Canonical group-bullet color: any error→red, all completed→green,
 * else static muted.
 */
export function groupBulletColorFromFlags(
	hasError: boolean,
	allCompleted: boolean,
	theme: ThemeLike,
): string {
	return statusBulletColor(hasError, allCompleted, theme);
}

/**
 * Shared pulse timer for renderers that need live status animation. Holds
 * a set of invalidate callbacks and fires them on one PULSE_INTERVAL_MS
 * interval, starting on first add and stopping when the last callback is
 * removed. Compact native-tool rows intentionally do not register here:
 * invalidating a tool row also requests a full TUI render.
 */
export class PulseManager {
	private readonly callbacks = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | undefined;

	add(cb: () => void): void {
		this.callbacks.add(cb);
		if (this.timer) return;
		this.timer = setInterval(() => {
			for (const cb of this.callbacks) {
				try {
					cb();
				} catch {
					/* best effort */
				}
			}
		}, PULSE_INTERVAL_MS);
	}

	remove(cb: () => void): void {
		this.callbacks.delete(cb);
		if (this.callbacks.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	clear(): void {
		this.callbacks.clear();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

function bulletColor(record: CompactCall, theme: ThemeLike): string {
	return statusBulletColor(record.isError, record._completed === true, theme);
}

function formatStandaloneCallRow(record: CompactCall, theme: ThemeLike): string {
	const { name, args, result } = record;
	const completed = record._completed === true;
	if (name === "apply_patch") {
		const details = result?.details as { parseError?: string } | undefined;
		if (details?.parseError) {
			return format_patch_error_row(
				result?.details as Parameters<typeof format_patch_error_row>[0],
				theme,
				record.isError,
			);
		}
		return format_apply_patch_block(record, theme);
	}
	const prefix = bulletColor(record, theme) + formatCallBody(name, args, theme, false, completed);
	// Live edit/write stats: while the model streams args (before the tool
	// runs), show a running +N -N count that updates on each token. Once the
	// edit completes, the authoritative diff stats take over; write has no
	// diff, so it keeps the args-based content line count as final.
	// write is a full rewrite/new file, so it only shows +N, never -N.
	if ((name === "edit" || name === "write") && !completed) {
		const live = name === "edit" ? streamingEditStats(args) : streamingWriteStats(args);
		const showRemovals = name === "edit";
		if (live) {
			return prefix + paint_compact_tool(theme, "  ", false) + formatEditStatsFromCounts(live, theme, showRemovals);
		}
		return prefix;
	}
	if (!completed || result === undefined) return prefix;
	if (name === "edit") {
		return prefix + paint_compact_tool(theme, "  ", true) + formatEditStats(result, theme);
	}
	if (name === "write") {
		const final = streamingWriteStats(args);
		if (final) return prefix + paint_compact_tool(theme, "  ", true) + formatEditStatsFromCounts(final, theme, false);
		return prefix;
	}
	if (name === "grep" || name === "find") {
		return prefix + matchLabel(result, theme);
	}
	if (name === "bash") {
		return prefix + formatBashResultLine(result, theme, record.isError);
	}
	return prefix;
}

function formatEditStats(result: ToolResult | undefined, theme: ThemeLike): string {
	const { additions, removals } = diffStats(result);
	return formatEditStatsFromCounts({ additions, removals }, theme);
}

function formatEditStatsFromCounts(
	counts: { additions: number; removals: number },
	theme: ThemeLike,
	showRemovals = true,
): string {
	// Avoid noisy +0 -0 placeholders when there is nothing to diff.
	if (counts.additions === 0 && counts.removals === 0) return "";
	const plus = theme.fg("success", `+${counts.additions}`);
	if (!showRemovals) return plus;
	return (
		plus +
		theme.fg("dim", " ") +
		theme.fg("error", `-${counts.removals}`)
	);
}

function presentTenseVerb(name: string, args: ToolArgs): string {
	switch (name) {
		case "read":
			return "Reading";
		case "grep":
			return "Searching";
		case "find":
			return "Finding";
		case "ls":
			return "Listing";
		case "bash": {
			const cmd = textValue(args?.command);
			return bashGrepInfo(cmd) ? "Searching" : "Bashing";
		}
		case "edit":
			return "Editing";
		case "write":
			return "Writing";
		case "apply_patch":
			return "Patching";
		default:
			return name;
	}
}

function renderRunningGradient(text: string): string {
	return render_gradient(text, MUTED_GROUP_GRADIENT_PRESET, get_gradient_phase());
}

/** Gradient Thinking child row under a settled group header — SSOT with the status label. */
function formatGroupThinkingChildRow(): string {
	return render_gradient("Thinking", "thinking", get_gradient_phase());
}

/** Present-tense child verb for absorb+linger rows (SSOT for compact + cursor). */
export function groupChildPresentVerb(name: string, args: ToolArgs = {}): string {
	return presentTenseVerb(name, args);
}

/** Gradient present-tense verb used under Exploring-style group headers. */
export function formatGroupChildGradientVerb(name: string, args: ToolArgs = {}): string {
	return renderRunningGradient(presentTenseVerb(name, args));
}

function pastTenseNoun(type: NonNullable<DiscoveryGroup["type"]>): { label: string; noun: string } {
	switch (type) {
		case "editing":
			return { label: "Edited", noun: "file" };
		case "writing":
			return { label: "Written", noun: "file" };
		case "bashing":
			return { label: "Ran", noun: "command" };
		case "patching":
			return { label: "Patched", noun: "file" };
		default:
			return { label: "Explored", noun: "file" };
	}
}

/** Past-tense group header base (`Explored N files`) — SSOT for compact + cursor. */
export function formatPastTenseGroupHeader(
	theme: ThemeLike,
	type: NonNullable<DiscoveryGroup["type"]>,
	count: number,
): string {
	const { label, noun } = pastTenseNoun(type);
	const base = `${label} ${count} ${count === 1 ? noun : `${noun}s`}`;
	return theme.fg("muted", theme.bold(base));
}

function formatCallBodyDetails(
	name: string,
	args: ToolArgs,
	theme: ThemeLike,
	inGroup = false,
	completed = true,
): string {
	const pathName = toolPath(args);
	switch (name) {
		case "read":
			return paint_compact_tool(theme, ` ${pathName}${readRangeLabel(args)}`, completed);
		case "grep":
			return (
				paint_compact_tool(theme, ` ${textValue(args?.pattern)}`, completed) +
				paint_compact_tool(theme, ` in ${pathName}`, completed)
			);
		case "find":
			return (
				paint_compact_tool(theme, ` ${textValue(args?.pattern)}`, completed) +
				paint_compact_tool(theme, ` in ${pathName}`, completed)
			);
		case "ls":
			return paint_compact_tool(theme, ` ${pathName}`, completed);
		case "bash": {
			const cmd = textValue(args?.command);
			const grepInfo = bashGrepInfo(cmd);
			if (grepInfo) {
				return (
					paint_compact_tool(theme, ` ${grepInfo.pattern}`, completed) +
					paint_compact_tool(theme, ` in ${grepInfo.path}`, completed)
				);
			}
			const stripped = strip_bash_command_preview(cmd, inGroup);
			return paint_compact_tool(theme, ` $ ${stripped}`, completed);
		}
		case "edit":
			return paint_compact_tool(theme, ` ${pathName}`, completed);
		case "write":
			return paint_compact_tool(theme, ` ${pathName}`, completed);
		default:
			return "";
	}
}

/** Exported for cursor absorb+linger child rows (same details as compact groups). */
export function formatGroupedCallDetails(
	name: string,
	args: ToolArgs,
	theme: ThemeLike,
	completed = true,
): string {
	return formatCallBodyDetails(name, args, theme, true, completed);
}

export function formatCallBody(
	name: string,
	args: ToolArgs,
	theme: ThemeLike,
	inGroup = false,
	completed = true,
): string {
	return (
		formatCallBodyVerb(name, args, theme, inGroup, completed) +
		formatCallBodyDetails(name, args, theme, inGroup, completed)
	);
}

function formatCallBodyVerb(
	name: string,
	args: ToolArgs,
	theme: ThemeLike,
	inGroup = false,
	completed = true,
): string {
	if (inGroup && (name === "edit" || name === "write")) return "";
	if (inGroup && name === "bash") {
		const cmd = textValue(args?.command);
		if (!bashGrepInfo(cmd)) return "";
	}
	switch (name) {
		case "read":
			return paint_compact_tool_label(theme, "Read", completed);
		case "grep":
			return paint_compact_tool_label(theme, "Search", completed);
		case "find":
			return paint_compact_tool_label(theme, "Find", completed);
		case "ls":
			return paint_compact_tool_label(theme, "List", completed);
		case "bash":
			return paint_compact_tool_label(theme, "Bash", completed);
		case "edit":
			return paint_compact_tool_label(theme, "Edit", completed);
		case "write":
			return paint_compact_tool_label(theme, "Write", completed);
		default:
			return paint_compact_tool_label(theme, name, completed);
	}
}

function groupBulletColor(group: DiscoveryGroup, theme: ThemeLike): string {
	const hasError = group.records.some((r) => r.isError);
	const allCompleted = group.records.every((r) => r._completed);
	return groupBulletColorFromFlags(hasError, allCompleted, theme);
}

function completedRecords(group: DiscoveryGroup): CompactCall[] {
	return group.records.filter((r) => r._completed);
}

function groupHeaderLabel(group: DiscoveryGroup, theme: ThemeLike): string {
	const completed = completedRecords(group);
	const count =
		group.type === "patching"
			? patch_files_in_group(group).length
			: group.type === "bashing"
				? completed.length
				: new Set(completed.map(targetPathForRecord)).size;
	const base = formatPastTenseGroupHeader(theme, group.type ?? "discovery", count);
	const suffixes: string[] = [];
	if (group.type === "editing") {
		let additions = 0;
		let removals = 0;
		for (const r of completed) {
			const stats = diffStats(r.result);
			additions += stats.additions;
			removals += stats.removals;
		}
		const stats = formatEditStatsFromCounts({ additions, removals }, theme);
		if (stats) suffixes.push(stats);
	}
	if (group.type === "writing") {
		let additions = 0;
		for (const r of completed) {
			const stats = streamingWriteStats(r.args);
			additions += stats?.additions ?? 0;
		}
		const stats = formatEditStatsFromCounts({ additions, removals: 0 }, theme, false);
		if (stats) suffixes.push(stats);
	}
	if (group.type === "discovery") {
		const totalMatches = completed.reduce((sum, r) => sum + (matchCount(r.result) ?? 0), 0);
		if (totalMatches > 0) {
			suffixes.push(theme.fg("muted", `${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`));
		}
	}
	if (group.type === "patching") {
		let additions = 0;
		let removals = 0;
		for (const r of completed) {
			for (const file of patch_files_for_record(r)) {
				additions += file.additions;
				removals += file.removals;
			}
		}
		const stats = formatEditStatsFromCounts({ additions, removals }, theme);
		if (stats) suffixes.push(stats);
	}
	if (suffixes.length === 0) return base;
	return base + " " + suffixes.join(" ");
}

function apply_patch_header_verb(record: CompactCall, group?: DiscoveryGroup): string {
	const running = group
		? group.records.some((r) => !r._completed)
		: !record._completed;
	return running ? "Patching" : "Patched";
}

function apply_patch_record_has_errors(record: CompactCall): boolean {
	if (record.isError) return true;
	return patch_has_file_errors(record.result?.details as ApplyPatchDetails | undefined);
}

function patch_errors_for_group(group: DiscoveryGroup): Map<string, string> {
	const map = new Map<string, string>();
	for (const record of group.records) {
		for (const [path, error] of patch_file_errors_by_path(
			record.result?.details as ApplyPatchDetails | undefined,
		)) {
			map.set(path, error);
		}
	}
	return map;
}

function apply_patch_bullet(record: CompactCall, group: DiscoveryGroup | undefined, theme: ThemeLike): string {
	if (apply_patch_record_has_errors(record)) return theme.fg("error", BULLET);
	if (group) return groupBulletColor(group, theme);
	return bulletColor(record, theme);
}

function format_apply_patch_file_row(
	file: PatchFileRow,
	theme: ThemeLike,
	file_error?: string,
	completed = true,
): string {
	const verb = completed
		? paint_compact_tool_label(theme, "Patched", true)
		: renderRunningGradient("Patching");
	let row = verb + paint_compact_tool(theme, ` ${file.path}`, completed);
	if (!file_error) {
		const stats = formatEditStatsFromCounts(file, theme, file.removals > 0);
		if (stats) row += paint_compact_tool(theme, "  ", completed) + stats;
	} else {
		row += paint_compact_tool(theme, "  ", completed) + theme.fg("error", file_error);
	}
	return row;
}

function normalize_patch_display_path(file_path: string): string {
	return file_path.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
}

function format_apply_patch_block(record: CompactCall, theme: ThemeLike): string {
	const files = patch_files_for_record(record);
	const group = record.group;
	const n = files.length;
	const bullet = apply_patch_bullet(record, group, theme);
	const file_errors = patch_file_errors_by_path(record.result?.details as ApplyPatchDetails | undefined);
	const headerVerb = apply_patch_header_verb(record, group);
	const header =
		n > 0
			? `${headerVerb} ${n} file${n === 1 ? "" : "s"}`
			: headerVerb;
	const lines = [`${bullet}${theme.fg("muted", theme.bold(header))}`];
	const children = files.length > 0 ? files : [{ path: ".", additions: 0, removals: 0 }];
	for (const [index, file] of children.entries()) {
		const prefix = index === children.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_TEE;
		const file_error = file_errors.get(normalize_patch_display_path(file.path));
		lines.push(
			theme.fg("dim", prefix) +
				format_apply_patch_file_row(file, theme, file_error, record._completed === true),
		);
	}
	return lines.join("\n");
}

function format_patch_group(group: DiscoveryGroup, theme: ThemeLike): string {
	const files = patch_files_in_group(group);
	const n = files.length;
	const any_running = group.records.some((r) => !r._completed);
	const headerVerb = any_running ? "Patching" : "Patched";
	const header =
		n > 0
			? `${headerVerb} ${n} file${n === 1 ? "" : "s"}`
			: headerVerb;
	const has_errors = patch_errors_for_group(group).size > 0;
	const bullet = has_errors
		? theme.fg("error", BULLET)
		: groupBulletColor(group, theme);
	const lines = [`${bullet}${theme.fg("muted", theme.bold(header))}`];
	if (group.settled) return lines.join("\n");
	const file_errors = patch_errors_for_group(group);
	const children = files.length > 0 ? files : [{ path: ".", additions: 0, removals: 0 }];
	for (const [index, file] of children.entries()) {
		const prefix = index === children.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_TEE;
		const file_error = file_errors.get(normalize_patch_display_path(file.path));
		lines.push(
			theme.fg("dim", prefix) +
				format_apply_patch_file_row(file, theme, file_error, !any_running),
		);
	}
	return lines.join("\n");
}

/** Child rows shown under a group header: all runners, or the latest
 *  completed member while the group is unsettled (linger). Settled groups
 *  are header-only — thinking streams and visible text collapse here. */
export function selectGroupVisibleChildren<T>(
	items: readonly T[],
	settled: boolean,
	is_completed: (item: T) => boolean,
): T[] {
	if (settled) return [];
	const running = items.filter((item) => !is_completed(item));
	if (running.length > 0) return running;
	if (items.length > 0) {
		return [items[items.length - 1] as T];
	}
	return [];
}

function groupVisibleChildren(group: DiscoveryGroup): CompactCall[] {
	if (group.thinkingChild) return [];
	return selectGroupVisibleChildren(
		group.records,
		group.settled === true,
		(record) => record._completed === true,
	);
}

function formatGroup(group: DiscoveryGroup, theme: ThemeLike): string {
	if (group.type === "patching" && group.records.length > 1) {
		return format_patch_group(group, theme);
	}
	const headerText = groupHeaderLabel(group, theme);
	const lines = [groupBulletColor(group, theme) + headerText];
	if (group.thinkingChild) {
		lines.push(theme.fg("dim", TREE_BRANCH_LAST) + formatGroupThinkingChildRow());
		return lines.join("\n");
	}
	const children = groupVisibleChildren(group);
	for (const [index, record] of children.entries()) {
		const prefix = index === children.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_TEE;
		lines.push(theme.fg("dim", prefix) + formatGroupChildRow(record, theme));
	}
	return lines.join("\n");
}

/** Edit/write +N -N suffix for grouped child rows — SSOT for compact + cursor. */
export function formatGroupChildEditWriteStats(
	name: string,
	args: ToolArgs,
	completed: boolean,
	result: ToolResult | undefined,
	theme: ThemeLike,
): string {
	if (name !== "edit" && name !== "write") return "";
	let stats = "";
	if (completed) {
		if (name === "edit") {
			const from_diff = diffStats(result);
			const counts =
				from_diff.additions > 0 || from_diff.removals > 0 ? from_diff : streamingEditStats(args);
			if (counts) stats = formatEditStatsFromCounts(counts, theme);
		} else {
			stats = formatEditStatsFromCounts(
				streamingWriteStats(args) ?? { additions: 0, removals: 0 },
				theme,
				false,
			);
		}
	} else {
		const live = name === "edit" ? streamingEditStats(args) : streamingWriteStats(args);
		const show_removals = name === "edit";
		if (live) stats = formatEditStatsFromCounts(live, theme, show_removals);
	}
	return stats ? paint_compact_tool(theme, "  ", completed) + stats : "";
}

function formatGroupChildRow(record: CompactCall, theme: ThemeLike): string {
	const completed = record._completed === true;
	const verb = completed
		? formatCallBodyVerb(record.name, record.args, theme, true, true)
		: formatGroupChildGradientVerb(record.name, record.args);
	const details = formatCallBodyDetails(record.name, record.args, theme, true, completed);
	return (
		verb +
		details +
		formatGroupChildEditWriteStats(
			record.name,
			record.args,
			record._completed === true,
			record.result,
			theme,
		)
	);
}

export class CompactRenderer {
	private readonly calls = new Map<string, CompactCall>();
	/** The single live group. Soft settles (thinking-hidden / agent_end) keep
	 *  this pointer so a later same-key call can reopen via appendToGroup.
	 *  Hard settles (visible text, visible thinking, user message) clear it
	 *  so the next group starts at its own transcript position. */
	private currentGroup: DiscoveryGroup | undefined;
	private readonly pendingGroupInvalidations = new Set<DiscoveryGroup>();

	/** Stable tick callback — updates component state before Pi's native render. */
	private groupTickCb: (() => void) | undefined;
	private groupTickGroup: DiscoveryGroup | undefined;
	private lastTheme: ThemeLike | undefined;
	/** Last same-key group type kept for reopen after soft settle. */
	private reopenGroupKey: string | undefined;

	beginTurn(): void {
		// Intentionally no-op: discovery/action groups persist across turns so
		// consecutive read/grep/find/ls/edit/write/bash calls fold into one
		// block until the agent writes visible text or the user speaks.
	}

	endTurn(_thinkingHidden?: boolean, _message?: unknown): void {
		// Intentionally no-op: settling on turn_end would break cross-turn
		// grouping. Groups settle on visible text, user messages, non-groupable
		// tools, different group keys, or agent end.
	}

	/**
	 * Compact group lifecycle (thinking blocks hidden):
	 *
	 * - Tool lane: running/lingering children (Searching, Reading, …).
	 * - Thinking lane: one gradient Thinking row replaces the linger child.
	 *
	 * Enter thinking lane: thinking stream → `noteThinking()` (real reasoning only).
	 * Leave thinking lane:
	 *   - same-key `tool_call` → `appendToGroup` (reopen tool lane);
	 *   - visible assistant text, user message, different group key, or
	 *     non-groupable tool → `hardExitGroup()` (header-only, drop reopen);
	 *   - `agent_settled` → `clearGroupThinkingChild()` (header-only, keep
	 *     `currentGroup` so a later same-key batch can still reopen).
	 */

	/** Collapse a group to its past-tense header row only. */
	private freezeGroup(group: DiscoveryGroup | undefined): void {
		if (!group || group.records.length === 0) return;
		group.thinkingChild = false;
		if (!group.settled) group.settled = true;
		this.refreshGroupVisual(group);
		this.scheduleGroupInvalidation(group);
	}

	/** Hard boundary — freeze the live group and stop reopening it. */
	private hardExitGroup(): void {
		const group = this.currentGroup;
		if (group) group.hardExited = true;
		this.freezeGroup(group);
		this.unsubscribeGroupTick();
		this.reopenGroupKey = undefined;
		this.resetGroupingState();
	}

	/** Resolve the live group pointer — only the chronologically latest group. */
	private resolveLiveGroup(): DiscoveryGroup | undefined {
		if (this.currentGroup && !this.currentGroup.hardExited) return this.currentGroup;
		return undefined;
	}

	/** Soft settle for hidden thinking: flip the header to past tense and
	 *  paint Thinking in the single child row slot (replacing any lingering
	 *  Searching/Reading child). Keep currentGroup so the next same-key
	 *  discovery/action call reopens the same header instead of spawning
	 *  another Explored/Edited/… row. */
	noteThinking(): void {
		let group = this.resolveLiveGroup();
		this.settleGroups();
		if (!group || group.records.length < 2) return;
		this.currentGroup = group;
		group.thinkingChild = true;
		this.reopenGroupKey = group.key;
		this.refreshGroupVisual(group);
		this.scheduleGroupInvalidation(group);
		this.syncGroupTick(group);
	}

	/** Hard boundary: visible assistant text (or visible thinking). Freeze
	 *  to header-only and clear so a later same-type call starts fresh below
	 *  the intervening transcript block. */
	noteVisibleText(): void {
		this.hardExitGroup();
	}

	noteUserMessage(): void {
		this.hardExitGroup();
	}

	/** Leave the thinking lane when the agent fully settles — header-only,
	 *  keep currentGroup for a later same-key reopen. */
	clearGroupThinkingChild(): void {
		const group = this.currentGroup;
		if (!group?.thinkingChild) return;
		this.freezeGroup(group);
		this.syncGroupTick(group);
	}

	/** Soft settle at agent end. Does not clear
	 *  currentGroup — Pi fires agent_end between low-level runs (tool batch →
	 *  think → tool batch), and same-key calls must reopen rather than spawn
	 *  another Explored/Edited/… header. */
	settleAllGroups(): void {
		this.settleGroups();
	}

	/** Clear all accumulated call state. Called on session replacement
	 *  (/resume, /new, /fork) so stale rows from the previous session do
	 *  not leak into the new one. */
	resetForSession(): void {
		this.unsubscribeGroupTick();
		this.calls.clear();
		this.currentGroup = undefined;
		this.reopenGroupKey = undefined;
		this.pendingGroupInvalidations.clear();
		this.lastTheme = undefined;
	}

	/** Re-paint compact rows after a live accent/theme rebuild. */
	refreshThemeColors(theme: unknown): void {
		const t = theme as ThemeLike;
		const groups_refreshed = new Set<DiscoveryGroup>();
		for (const record of this.calls.values()) {
			const group = record.group;
			if (group?.callText && group.records.length > 1 && !groups_refreshed.has(group)) {
				groups_refreshed.add(group);
				group.callText.setText(formatGroup(group, t));
				continue;
			}
			if (record.callText) {
				record.callText.setText(formatStandaloneCallRow(record, t));
			}
		}
	}

	/** Whether any compact tool group currently has at
	 *  least one running member. Read by pi-compact-tools lifecycle handlers
	 *  to drive the shared `isToolGroupActive` flag in
	 *  pi-ember-ui/mode-colors.ts for group state and live gradient rendering. */
	hasActiveGroups(): boolean {
		const group = this.currentGroup;
		if (!group || group.records.length === 0) return false;
		if (group.thinkingChild) return true;
		if (group.records.some((r) => !r._completed)) return true;
		// Standalone single-member rows do not keep the group-active flag after completion.
		if (group.records.length <= 1) return false;
		return group.records.every((r) => r._completed) && !group.settled;
	}

	/** Whether the live group can host in-group Thinking (settled / thinking lane). */
	hasReopenableGroup(): boolean {
		const group = this.resolveLiveGroup();
		if (!group || group.hardExited || group.records.length < 2) return false;
		return group.thinkingChild === true || group.settled === true;
	}

	/** Whether the live group is painting an in-group Thinking child row. */
	hasGroupThinkingChild(): boolean {
		return this.currentGroup?.thinkingChild === true;
	}

	/** Re-paint the group's shared callText when group state changes without a
	 *  fresh tool renderCall (e.g. noteThinking on agent_end). */
	private refreshGroupVisual(group: DiscoveryGroup | undefined): void {
		if (!group || !this.lastTheme) return;
		const callText = group.callText ?? group.renderOwner?.callText;
		if (!callText) return;
		group.callText = callText;
		set_compact_call_text(group, callText, formatGroup(group, this.lastTheme));
		requestTuiRender();
	}

	/** Settle a single group so its label flips to past tense. No-op if
	 *  the group is missing, empty, or already settled. */
	private settleGroup(group: DiscoveryGroup | undefined): void {
		if (!group || group.records.length === 0 || group.settled) return;
		group.settled = true;
		if (group.key) this.reopenGroupKey = group.key;
		this.refreshGroupVisual(group);
		this.syncGroupTick(group);
		this.scheduleGroupInvalidation(group);
	}

	/** Settle the live group so its label flips to past tense. Called when the
	 *  agent demonstrably moves on:
	 *  visible user-facing text, a non-group tool, or a different
	 *  groupable tool. Idempotent per group via scheduleGroupInvalidation. */
	private settleGroups(): void {
		this.settleGroup(this.currentGroup);
		this.unsubscribeGroupTick();
	}

	/** Subscribe the group tick so Pi re-renders the live child verb normally. */
	private subscribeGroupTick(group: DiscoveryGroup): void {
		this.groupTickGroup = group;
		if (this.groupTickCb) return;
		this.groupTickCb = (): void => {
			this.refreshActiveGroupText();
		};
		subscribeGradientTick(this.groupTickCb);
	}

	private refreshActiveGroupText(): void {
		const group = this.groupTickGroup;
		const theme = this.lastTheme;
		if (!group?.callText || !theme) return;
		set_compact_call_text(group, group.callText, formatGroup(group, theme));
	}

	/** Keep the gradient tick subscribed while visible child rows render
	 *  (runners and lingering completed children). Settled groups are
	 *  header-only and static. */
	private syncGroupTick(group: DiscoveryGroup): void {
		const has_patch_children =
			group.type === "patching" && !group.settled && patch_files_in_group(group).length > 0;
		const visible_children = groupVisibleChildren(group);
		if (
			visible_children.length > 0 ||
			group.thinkingChild === true ||
			has_patch_children
		) {
			this.subscribeGroupTick(group);
			return;
		}
		this.unsubscribeGroupTick();
	}

	/** Unsubscribe the group tick callback if one is active. */
	private unsubscribeGroupTick(): void {
		if (!this.groupTickCb) return;
		unsubscribeGradientTick(this.groupTickCb);
		this.groupTickCb = undefined;
		this.groupTickGroup = undefined;
	}

	private resetGroupingState(): void {
		this.currentGroup = undefined;
	}

	private scheduleGroupInvalidation(group: DiscoveryGroup): void {
		if (this.pendingGroupInvalidations.has(group)) return;
		this.pendingGroupInvalidations.add(group);
		queueMicrotask(() => {
			if (!this.pendingGroupInvalidations.delete(group)) return;
			group.renderOwner?.invalidate?.();
			if (group.pendingShrink) group.pendingShrink = false;
			requestTuiRender();
		});
	}

	private scheduleRecordShrinkSnap(record: CompactCall): void {
		if (!record.pendingShrink) return;
		record.pendingShrink = false;
		queueMicrotask(() => requestTuiRender());
	}

	private appendToGroup(group: DiscoveryGroup, record: CompactCall): void {
		for (const member of group.records) member.group = group;
		group.thinkingChild = false;
		group.settled = false;
		group.records.push(record);
		record.group = group;
		this.currentGroup = group;
		if (group.key) this.reopenGroupKey = group.key;
		this.scheduleGroupInvalidation(group);
	}

	private startGroup(key: string, record: CompactCall): DiscoveryGroup {
		const type =
			key === "__editing__"
				? "editing"
				: key === "__writing__"
					? "writing"
					: key === "__bashing__"
						? "bashing"
						: key === "__patching__"
							? "patching"
							: "discovery";
		const group: DiscoveryGroup = {
			records: [record],
			renderOwner: record,
			type,
			key,
		};
		this.currentGroup = group;
		if (group.key) this.reopenGroupKey = group.key;
		return group;
	}

	registerCall(name: string, id: string, args: unknown, invalidate?: () => void): CompactCall {
		const typed_args = args as ToolArgs;
		const existing = this.calls.get(id);
		if (existing) {
			const incoming = args as ToolArgs;
			const existing_input = existing.args?.input;
			const preserve_apply_patch_args =
				name === "apply_patch" &&
				typeof incoming?.input === "string" &&
				incoming.input.length === 0 &&
				typeof existing_input === "string" &&
				existing_input.length > 0;
			if (!preserve_apply_patch_args) {
				existing.args = typed_args;
			}
			if (invalidate) {
				existing.invalidate = invalidate;
			}
			return existing;
		}

		const record: CompactCall = { id, name, args: typed_args, isError: false };
		this.calls.set(id, record);
		const key = groupKey(name, typed_args);

		if (key === undefined) {
			this.hardExitGroup();
		} else if (this.currentGroup?.key === key && !this.currentGroup.hardExited) {
			this.appendToGroup(this.currentGroup, record);
		} else {
			if (this.currentGroup && !this.currentGroup.hardExited) {
				this.currentGroup.hardExited = true;
			}
			this.freezeGroup(this.currentGroup);
			this.unsubscribeGroupTick();
			this.startGroup(key, record);
		}
		record.invalidate = invalidate;
		return record;
	}

	setResult(record: CompactCall, result: ToolResult, isError: boolean): void {
		if (record._completed && record.result === result && record.isError === isError) return;
		record.isError = isError;
		record._completed = true;
		record.result = result;
		if (record.name === "apply_patch") {
			this.unsubscribeGroupTick();
		}
		// Do NOT invalidate the owner here. The group visual is updated
		// directly via group.callText.setText() in renderResultInner so the
		// owner's next render picks up the change. Invalidating the owner
		// synchronously triggers updateDisplay -> renderResult -> setResult,
		// which races during Pi rebuilds (thinking-toggle, compaction) when
		// the owner component has been destroyed and recreated.
	}

	renderCall(name: string, args: unknown, theme: ThemeLike, context: ToolRenderContext): Component {
		try {
			return this.renderCallInner(name, args, theme, context);
		} catch {
			// Never throw: Pi's fallback would dump raw content. Return a
			// compact call row instead. Use CompactGroupText (truncating) so
			// even the fallback never wraps to multiple rows.
			const fallback = new CompactGroupText();
			fallback.setText(theme.fg("muted", BULLET) + formatCallBody(name, args as ToolArgs, theme, false, true));
			return fallback;
		}
	}

	private renderCallInner(
		name: string,
		args: unknown,
		theme: ThemeLike,
		context: ToolRenderContext,
	): Component {
		this.lastTheme = theme;
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		if (record.group && record.group.records.length > 1) {
			if (record.group.renderOwner !== record) return new Text("", 0, 0);
			const callText =
				context.state.callText instanceof CompactGroupText
					? context.state.callText
					: new CompactGroupText();
			context.state.callText = callText;
			// Re-bind the group's shared visual handle to the owner's live
			// component on every render. On Pi rebuilds (thinking-toggle,
			// compaction, settings) context.state is fresh, so a new component is
			// created and the group handle is repointed to the live owner.
			record.group.callText = callText;
			set_compact_call_text(record.group, callText, formatGroup(record.group, theme));
			if (record.group.pendingShrink) this.scheduleGroupInvalidation(record.group);
			this.syncGroupTick(record.group);
			return callText;
		}
		const callText =
			context.state.callText instanceof CompactGroupText
				? context.state.callText
				: new CompactGroupText();
		context.state.callText = callText;
		record.callText = callText;
		set_compact_call_text(record, callText, formatStandaloneCallRow(record, theme));
		if (name === "apply_patch") {
			this.syncApplyPatchTick(record);
			this.scheduleRecordShrinkSnap(record);
		}
		return callText;
	}

	private syncApplyPatchTick(record: CompactCall): void {
		if (record._completed) {
			this.unsubscribeGroupTick();
			return;
		}
		const group = record.group;
		const files = patch_files_for_record(record);
		if (files.length === 0) return;
		const show_children = !group?.settled;
		if (show_children) {
			const group = record.group ?? this.currentGroup;
			if (group) this.subscribeGroupTick(group);
			return;
		}
		if (!group || group.records.length <= 1) {
			this.unsubscribeGroupTick();
		}
	}

	renderResult(
		name: string,
		args: unknown,
		result: ToolResult,
		options: ToolRenderResultOptions,
		theme: ThemeLike,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		try {
			return this.renderResultInner(name, args, result, options, theme, context);
		} catch {
			// Never throw: Pi's fallback would dump the full tool output
			// (e.g. entire file contents for read). Return an empty result
			// row — the call row already shows the compact summary.
			return new Text("", 0, 0);
		}
	}

	private renderResultInner(
		name: string,
		args: unknown,
		result: ToolResult,
		options: ToolRenderResultOptions,
		theme: ThemeLike,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		this.lastTheme = theme;
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		this.setResult(record, result, context.isError);
		const expanded = options.expanded === true;

		if (record.group && record.group.records.length > 1) {
			// Update the shared group visual directly so the owner's row
			// reflects this member's completion (bullet color, match count,
			// final label) without invalidating the owner. Pi's next requestRender
			// renders the owner's selfRenderContainer with the updated component.
			const group_text = formatGroup(record.group, theme);
			if (record.group.callText) {
				set_compact_call_text(record.group, record.group.callText, group_text);
				if (record.group.pendingShrink) this.scheduleGroupInvalidation(record.group);
			}
			this.syncGroupTick(record.group);
			if (record.group.renderOwner !== record) return new Text("", 0, 0);
			// When the group is collapsed (settled + thinking hidden), hide the
			// per-member error row too — the header bullet already turns red to
			// signal the failure. Reuses the same collapse gate as formatGroup.
			const group_collapsed =
				record.group.settled === true &&
				record.group.records.length > 0 &&
				record.group.records.every((r) => r._completed) &&
				isThinkingBlocksHidden();
			const error = errorText(result, context.isError);
			if (error && name !== "apply_patch" && !group_collapsed) return compactErrorComponent(error, theme);
			if (expanded && !options.isPartial && !group_collapsed) {
				const output = formatExpandedOutput(result, theme);
				if (output) return new Text(output, 0, 0);
			}
			return new Text("", 0, 0);
		}
		if (options.isPartial) return new Text("", 0, 0);

		const error = errorText(result, context.isError);
		const callText = context.state.callText;
		if (callText && typeof (callText as { setText?: unknown }).setText === "function") {
			record.callText = callText as CompactGroupText;
			set_compact_call_text(record, callText as CompactGroupText, formatStandaloneCallRow(record, theme));
		}
		if (name === "apply_patch") {
			this.syncApplyPatchTick(record);
			this.scheduleRecordShrinkSnap(record);
		}
		if (error && name !== "apply_patch") return compactErrorComponent(error, theme);
		if (expanded) {
			const output = formatExpandedOutput(result, theme);
			if (output) return new Text(output, 0, 0);
		}
		return new Text("", 0, 0);
	}
}

/** Classify assistant stream events that affect compact group boundaries. */
export function resolve_assistant_group_boundary_event(ev: {
	type: string;
	delta?: unknown;
}): "visible_text" | "thinking" | null {
	if (ev.type === "text_delta") {
		const delta = ev.delta;
		return typeof delta === "string" && delta.trim().length > 0 ? "visible_text" : null;
	}
	if (ev.type === "thinking_start" || ev.type === "thinking_delta") return "thinking";
	return null;
}

export { DISCOVERY_TOOLS, GROUPABLE_TOOLS, bashGrepInfo };
export const __test_only = { set_compact_call_text };
