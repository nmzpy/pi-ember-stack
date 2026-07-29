import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseStreamingJson } from "@earendil-works/pi-ai/compat";
import * as Diff from "diff";
import { patch_files_from_input, format_patch_error_row, patch_file_errors_by_path, patch_has_file_errors, compact_patch_failure_reason, type ApplyPatchDetails, type PatchFileRow } from "../pi-ember-applypatch/display.ts";
import { BULLET, CompactGroupText } from "./compact-text.ts";
import {
	MUTED_GROUP_GRADIENT_PRESET,
	requestTuiRender,
	format_thinking_pass_elapsed_suffix,
	reset_thinking_pass_timer,
	subscribeGradientTick,
	unsubscribeGradientTick,
} from "../pi-ember-ui/index.ts";
import { get_gradient_phase, render_gradient } from "../pi-ember-ui/gradient.ts";
import { isThinkingBlocksHidden } from "../pi-ember-ui/mode-colors.ts";
import { format_in_group_thinking_row } from "../pi-ember-ui/thinking-status-render.ts";
import { bashGrepInfo } from "./bash-grep.ts";
/** Delay folding prior tool-wave children during rapid parallel/sequential tool bursts. */
export const GROUP_CHILD_FOLD_DEBOUNCE_MS = 500;

function stable_serialize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable_serialize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stable_serialize(entry)}`).join(",")}}`;
}

/** Stable tool name + args key for duplicate-call detection within a group wave. */
function compact_call_signature(name: string, args: ToolArgs): string {
	return `${name}:${stable_serialize(args)}`;
}

function is_repeat_visible_group_call(group: DiscoveryGroup, name: string, args: ToolArgs): boolean {
	const signature = compact_call_signature(name, args);
	return groupVisibleChildren(group).some(
		(member) => compact_call_signature(member.name, member.args) === signature,
	);
}

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
/** Single group key for all groupable tools in one work burst — SSOT. */
export const WORK_GROUP_KEY = "__work__";
/** Non-groupable tools that render in the transcript but must not hard-split
 *  the unified work bundle (e.g. `todo` — see pi-ember-todo). */
export const WORK_GROUP_SOFT_BOUNDARY_TOOLS = new Set(["todo"]);

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
	type?: "discovery" | "editing" | "writing" | "bashing" | "patching" | "work";
	/** The groupKey value that created this group. */
	key?: string;
	/**
	 * The record whose component renders the group header. Set once at
	 * group creation to the first member and never changed — the transcript
	 * anchor must not migrate to later tool-call slots (contrast pi-ember-todo).
	 */
	renderOwner?: CompactCall;
	/** Same as renderOwner — explicit SSOT for transcript vertical anchor. */
	anchorOwner?: CompactCall;
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
	/** After a soft transcript boundary (e.g. `todo`), migrate the visual anchor
	 *  to the next tool wave so the block renders below the intervening row. */
	migrateAnchorOnNextWave?: boolean;
	/**
	 * Index into `records` before which completed members are folded into the
	 * header summary. Child rows only show `records.slice(childAbsorbBefore)`.
	 * Advanced by {@link CompactRenderer.appendToGroup} on a genuinely new tool
	 * wave only (not thinking, todo soft boundaries, or repeated same-signature calls).
	 */
	childAbsorbBefore?: number;
	/**
	 * When hidden thinking interrupts a settled group, render the gradient
	 * Thinking label in the single child row slot (replacing tool rows).
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

/** Bash call preview — drop grouped `cd … &&` prefixes and a redundant leading `bash `. */
export function strip_bash_command_preview(command: string, inGroup = false): string {
	let stripped = command;
	if (inGroup) {
		stripped = stripped.replace(/^\s*cd\s+[^\s&]+\s*&&\s*/, "") || stripped;
	}
	return stripped.replace(/^\s*bash\s+/, "") || stripped;
}

function groupKey(name: string, args: ToolArgs): string | undefined {
	if (!resolve_compact_group_type(name, args)) return undefined;
	return WORK_GROUP_KEY;
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

function patch_files_in_records(records: readonly CompactCall[]): PatchFileRow[] {
	const rows: PatchFileRow[] = [];
	for (const record of records) {
		rows.push(...patch_files_for_record(record));
	}
	return rows;
}

function patch_files_in_group(group: DiscoveryGroup): PatchFileRow[] {
	return patch_files_in_records(group.records);
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

/** Edit +N -N counts — SSOT for header aggregate, child rows, and standalone rows. */
function edit_diff_counts(
	args: ToolArgs,
	result: ToolResult | undefined,
	completed: boolean,
): { additions: number; removals: number } | undefined {
	if (!completed) return streamingEditStats(args);
	const from_diff = diffStats(result);
	if (from_diff.additions > 0 || from_diff.removals > 0) return from_diff;
	return streamingEditStats(args);
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
 * Running, …) — bullets do not pulse.
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
		const details = result?.details as ApplyPatchDetails | undefined;
		if (details?.parseError) {
			return format_patch_error_row(details, theme, record.isError);
		}
		if (details && !details.ok && details.results.some((r) => r.status === "error")) {
			const files = patch_files_for_record(record);
			const header = apply_patch_header_text(record, files, true);
			const stats = formatEditStatsFromCounts(apply_patch_total_stats(files), theme, true, false);
			const failure_reason = compact_patch_failure_reason(details);
			let row = `${theme.fg("error", BULLET)}${theme.fg("muted", theme.bold(header))}`;
			if (stats) row += paint_compact_tool(theme, "  ", true) + stats;
			if (failure_reason) {
				row += paint_compact_tool(theme, "  ", true) + theme.fg("error", failure_reason);
			}
			return row;
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
		const counts = edit_diff_counts(args, result, true);
		if (!counts) return prefix;
		return (
			prefix + paint_compact_tool(theme, "  ", true) + formatEditStatsFromCounts(counts, theme)
		);
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

function formatEditStatsFromCounts(
	counts: { additions: number; removals: number },
	theme: ThemeLike,
	showRemovals = true,
	muted = false,
): string {
	// Avoid noisy +0 -0 placeholders when there is nothing to diff.
	if (counts.additions === 0 && counts.removals === 0) return "";
	const plus_token = muted ? "muted" : "success";
	const minus_token = muted ? "muted" : "error";
	const parts: string[] = [];
	if (counts.additions > 0) {
		parts.push(theme.fg(plus_token, `+${counts.additions}`));
	}
	if (showRemovals && counts.removals > 0) {
		if (parts.length > 0) parts.push(theme.fg("dim", " "));
		parts.push(theme.fg(minus_token, `-${counts.removals}`));
	}
	return parts.join("");
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
			return "Running";
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
function formatGroupThinkingChildRow(theme: ThemeLike): string {
	return format_in_group_thinking_row(format_thinking_pass_elapsed_suffix(theme));
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
			return { label: "Wrote", noun: "file" };
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

function work_plural(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

/** Aggregate edit/write/patch diff totals for the unified work header. */
function is_diff_record(record: CompactCall): boolean {
	return record.name === "edit" || record.name === "write" || record.name === "apply_patch";
}

/** Aggregate edit/write/patch diff totals for the unified work header.
 *  Only counts records that are not the single visible lingering diff tool,
 *  because its child row already displays +N -N inline. Once a new tool wave
 *  folds it or another tool joins, include it in the header total. */
function work_header_diff_stats(group: DiscoveryGroup): { additions: number; removals: number } {
	const completed = completedRecords(group);
	const visible = groupVisibleChildren(group);
	// Suppress the last visible child's diff stats from the header only when
	// it is the single visible lingering diff tool — its child row already
	// displays +N -N inline, so the header would duplicate it. Once another
	// tool joins (multiple visible children), include every completed diff in
	// the header total.
	const last_visible = visible[visible.length - 1];
	const single_visible_diff =
		visible.length === 1 &&
		last_visible &&
		is_diff_record(last_visible) &&
		last_visible._completed
			? last_visible
			: undefined;
	let additions = 0;
	let removals = 0;
	for (const record of completed) {
		if (single_visible_diff && record.id === single_visible_diff.id) continue;
		if (record.name === "edit") {
			const counts = edit_diff_counts(record.args, record.result, true);
			if (counts) {
				additions += counts.additions;
				removals += counts.removals;
			}
		} else if (record.name === "write") {
			const stats = streamingWriteStats(record.args);
			additions += stats?.additions ?? 0;
		} else if (record.name === "apply_patch") {
			for (const file of patch_files_for_record(record)) {
				additions += file.additions;
				removals += file.removals;
			}
		}
	}
	return { additions, removals };
}

/** Comma-separated work-bundle header segments — SSOT for unified groups. */
export function format_unified_work_segments(group: DiscoveryGroup): string[] {
	const explored = new Set<string>();
	let searches = 0;
	const edited = new Set<string>();
	const written = new Set<string>();
	let commands = 0;

	for (const record of completedRecords(group)) {
		if (record.name === "read" || record.name === "ls") {
			explored.add(targetPathForRecord(record));
		} else if (record.name === "grep" || record.name === "find") {
			searches++;
		} else if (record.name === "bash") {
			if (bashGrepInfo(textValue(record.args?.command))) searches++;
			else commands++;
		} else if (record.name === "edit") {
			edited.add(targetPathForRecord(record));
		} else if (record.name === "write") {
			written.add(targetPathForRecord(record));
		} else if (record.name === "apply_patch") {
			// In the unified work bundle, apply_patch contributes to Edited.
			// The dedicated "Patched" label only appears in a pure multi-patch
			// group (format_patch_group), not in the mixed work header.
			for (const file of patch_files_for_record(record)) {
				edited.add(file.path);
			}
		}
	}

	const segments: string[] = [];
	if (edited.size > 0) {
		segments.push(`Edited ${edited.size} ${work_plural(edited.size, "file")}`);
	}
	if (written.size > 0) {
		segments.push(`Wrote ${written.size} ${work_plural(written.size, "file")}`);
	}
	if (explored.size > 0) {
		segments.push(`Explored ${explored.size} ${work_plural(explored.size, "file")}`);
	}
	if (searches > 0) {
		segments.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
	}
	if (commands > 0) {
		segments.push(`Ran ${commands} ${work_plural(commands, "command")}`);
	}
	return segments;
}

/** Unified work-bundle header (`Edited N files, explored M files, … +N -N`). */
export function formatUnifiedWorkHeader(group: DiscoveryGroup, theme: ThemeLike): string {
	const segments = format_unified_work_segments(group);
	const label = segments.length > 0 ? segments.join(", ") : "Working";
	const base = theme.fg("muted", theme.bold(label));
	const stats = formatEditStatsFromCounts(work_header_diff_stats(group), theme);
	if (!stats) return base;
	return `${base} ${stats}`;
}

function is_work_group(group: DiscoveryGroup): boolean {
	return group.key === WORK_GROUP_KEY || group.type === "work";
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
		case "apply_patch": {
			const files = patch_files_from_input(patch_input(args));
			const path = files[0]?.path ?? ".";
			return paint_compact_tool(theme, ` ${path}`, completed);
		}
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
		case "apply_patch":
			return paint_compact_tool_label(theme, completed ? "Patched" : "Patch", completed);
		default:
			return paint_compact_tool_label(theme, name, completed);
	}
}

function groupBulletColor(group: DiscoveryGroup, theme: ThemeLike): string {
	const status_records = group_status_records(group);
	const hasError = group_has_active_error(group);
	const allCompleted = status_records.length > 0 && status_records.every((r) => r._completed);
	return groupBulletColorFromFlags(hasError, allCompleted, theme);
}

function completedRecords(group: DiscoveryGroup): CompactCall[] {
	return group.records.filter((r) => r._completed);
}

function groupHeaderLabel(group: DiscoveryGroup, theme: ThemeLike): string {
	if (is_work_group(group)) {
		return formatUnifiedWorkHeader(group, theme);
	}
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
			const counts = edit_diff_counts(r.args, r.result, true);
			if (counts) {
				additions += counts.additions;
				removals += counts.removals;
			}
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

function patch_errors_for_records(records: readonly CompactCall[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const record of records) {
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
		const stats = formatEditStatsFromCounts(file, theme, file.removals > 0, true);
		if (stats) row += paint_compact_tool(theme, "  ", completed) + stats;
	} else {
		row += paint_compact_tool(theme, "  ", completed) + theme.fg("error", file_error);
	}
	return row;
}

function normalize_patch_display_path(file_path: string): string {
	return file_path.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
}

function apply_patch_total_stats(files: PatchFileRow[]): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const file of files) {
		additions += file.additions;
		removals += file.removals;
	}
	return { additions, removals };
}

function apply_patch_header_text(
	record: CompactCall,
	files: PatchFileRow[],
	completed: boolean,
): string {
	const n = files.length;
	const verb = completed ? "Patched" : "Patching";
	const header = n > 1 ? `${verb} ${n} files` : n === 1 ? `${verb} 1 file` : verb;
	return header;
}

/** Standalone apply_patch row — mirrors edit/write: one row with +N -N, no child tree. */
function format_apply_patch_block(record: CompactCall, theme: ThemeLike): string {
	const files = patch_files_for_record(record);
	const completed = record._completed === true;
	const bullet = apply_patch_bullet(record, undefined, theme);
	const header = apply_patch_header_text(record, files, completed);
	let row = `${bullet}${theme.fg("muted", theme.bold(header))}`;
	const stats = formatEditStatsFromCounts(apply_patch_total_stats(files), theme, true, false);
	if (stats) row += paint_compact_tool(theme, "  ", completed) + stats;
	return row;
}

function format_patch_group(group: DiscoveryGroup, theme: ThemeLike): string {
	const files = patch_files_in_group(group);
	const any_running = group.records.some((r) => !r._completed);
	const headerVerb = any_running ? "Patching" : "Patched";
	const header =
		files.length > 0
			? `${headerVerb} ${files.length} file${files.length === 1 ? "" : "s"}`
			: headerVerb;
	const visible_records = groupVisibleChildren(group);
	const visible_file_rows: Array<{ file: PatchFileRow; completed: boolean }> = [];
	for (const record of visible_records) {
		for (const file of patch_files_for_record(record)) {
			visible_file_rows.push({ file, completed: record._completed === true });
		}
	}
	const has_errors = patch_errors_for_records(visible_records).size > 0;
	const bullet = has_errors
		? theme.fg("error", BULLET)
		: groupBulletColor(group, theme);
	const header_stats = formatEditStatsFromCounts(apply_patch_total_stats(files), theme);
	const lines = [
		`${bullet}${theme.fg("muted", theme.bold(header))}${
			header_stats ? paint_compact_tool(theme, "  ", true) + header_stats : ""
		}`,
	];
	if (group.settled) return lines.join("\n");
	const file_errors = patch_errors_for_records(visible_records);
	const children =
		visible_file_rows.length > 0
			? visible_file_rows
			: [{ file: { path: ".", additions: 0, removals: 0 }, completed: !any_running }];
	for (const [index, child] of children.entries()) {
		const prefix = index === children.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_TEE;
		const file_error = file_errors.get(normalize_patch_display_path(child.file.path));
		lines.push(
			theme.fg("dim", prefix) +
				format_apply_patch_file_row(child.file, theme, file_error, child.completed),
		);
	}
	return lines.join("\n");
}

/**
 * A pure run of two or more apply_patch calls gets the dedicated Patching
 * header and per-file children. A mixed run stays in the public unified work
 * bundle so patches contribute to Edited/Explored/Search summaries.
 */
function is_multi_patch_group(group: DiscoveryGroup): boolean {
	return (
		group.records.length >= 2 &&
		group.records.every((record) => record.name === "apply_patch")
	);
}

/** Child rows under a group header — SSOT for compact + cursor. */
export function selectGroupVisibleChildren<T>(
	items: readonly T[],
	absorb_before: number,
): T[] {
	const start = Math.max(0, Math.min(absorb_before, items.length));
	return items.slice(start);
}

function groupVisibleChildren(group: DiscoveryGroup): CompactCall[] {
	return selectGroupVisibleChildren(group.records, group.childAbsorbBefore ?? 0);
}

/** Whether the group still needs the shared 20 FPS gradient tick. */
export function group_needs_gradient_tick(group: DiscoveryGroup): boolean {
	if (group.thinkingChild && isThinkingBlocksHidden()) return true;
	const visible = groupVisibleChildren(group);
	if (visible.some((record) => !record._completed)) return true;
	if (!group.settled && group.records.some((record) => !record._completed)) return true;
	return false;
}

/** Errors in folded/absorbed members are historical — only the visible wave is active. */
function group_has_active_error(group: DiscoveryGroup): boolean {
	return groupVisibleChildren(group).some((r) => r.isError);
}

function is_active_group_error(record: CompactCall, group: DiscoveryGroup | undefined): boolean {
	if (!record.isError) return false;
	if (!group) return true;
	return groupVisibleChildren(group).includes(record);
}

function group_status_records(group: DiscoveryGroup): CompactCall[] {
	const visible = groupVisibleChildren(group);
	return visible.length > 0 ? visible : group.records;
}

function formatGroup(group: DiscoveryGroup, theme: ThemeLike): string {
	if (
		is_multi_patch_group(group) ||
		(!is_work_group(group) && group.type === "patching" && group.records.length >= 2)
	) {
		return format_patch_group(group, theme);
	}
	const headerText = groupHeaderLabel(group, theme);
	const lines = [groupBulletColor(group, theme) + headerText];
	const children = groupVisibleChildren(group);
	const show_thinking = group.thinkingChild && isThinkingBlocksHidden();
	for (const [index, record] of children.entries()) {
		const is_last_child = index === children.length - 1 && !show_thinking;
		const prefix = is_last_child ? TREE_BRANCH_LAST : TREE_BRANCH_TEE;
		lines.push(theme.fg("dim", prefix) + formatGroupChildRow(record, theme));
	}
	if (show_thinking) {
		lines.push(theme.fg("dim", TREE_BRANCH_LAST) + formatGroupThinkingChildRow(theme));
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
	if (name !== "edit" && name !== "write" && name !== "apply_patch") return "";
	let stats = "";
	if (name === "apply_patch") {
		const files = completed
			? patch_files_for_record({ name, args, result } as CompactCall)
			: patch_files_from_input(patch_input(args));
		let additions = 0;
		let removals = 0;
		for (const file of files) {
			additions += file.additions;
			removals += file.removals;
		}
		stats = formatEditStatsFromCounts({ additions, removals }, theme, removals > 0, true);
	} else if (completed) {
		if (name === "edit") {
			const counts = edit_diff_counts(args, result, true);
			if (counts) stats = formatEditStatsFromCounts(counts, theme, true, true);
		} else {
			stats = formatEditStatsFromCounts(
				streamingWriteStats(args) ?? { additions: 0, removals: 0 },
				theme,
				false,
				true,
			);
		}
	} else {
		const live = name === "edit" ? streamingEditStats(args) : streamingWriteStats(args);
		const show_removals = name === "edit";
		if (live) stats = formatEditStatsFromCounts(live, theme, show_removals, true);
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

/** Fold completed tool rows into the group header — SSOT flush boundary. */
export function fold_group_child_rows(group: DiscoveryGroup): void {
	group.childAbsorbBefore = group.records.length;
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
	/** Debounce prior-wave child folds during rapid tool-call bursts. */
	private childFoldDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private childFoldDebounceGroup: DiscoveryGroup | undefined;
	private childFoldAbsorbBefore = 0;
	/** Last same-key group type kept for reopen after soft settle. */
	private reopenGroupKey: string | undefined;
	/** Set by the inter-run-gap pre-token arm so the next noteThinking folds
	 *  lingering tool children and the `└ Thinking` lane owns the slot. */
	private foldChildrenOnNextThinking = false;

	/** Request that the next noteThinking folds lingering tool children.
	 *  Used by the inter-run-gap pre-token arm so `└ Thinking` replaces the
	 *  tool lane rather than appending after it. */
	requestFoldChildrenForThinking(): void {
		this.foldChildrenOnNextThinking = true;
	}

	beginTurn(): void {
		// Child rows linger through turn_end; fold only on thinking stream,
		// tool-wave reopen (appendToGroup), or hard boundaries.
	}

	endTurn(_thinkingHidden?: boolean, _message?: unknown): void {
		// Same as beginTurn — do not flush the tool lane at Pi turn boundaries.
	}

	/**
	 * Compact group lifecycle (thinking blocks hidden):
	 *
	 * - Tool lane: running/lingering children (Searching, Reading, …).
	 * - Thinking lane: one gradient `└ Thinking` row replaces the linger child.
	 *
	 * Enter thinking lane: the wait arm or a real thinking stream
	 * (`armInGroupThinking()` / `noteThinking()`).
	 * Leave thinking lane:
	 *   - same-key `tool_call` → `appendToGroup` (reopen tool lane);
	 *   - visible assistant text, user message, or hard non-groupable tool
	 *     (`noteInterveningToolCall`) → `hardExitGroup()` (never reopen in place);
	 *   - soft-boundary tools (`noteSoftInterveningToolCall`, e.g. `todo`) →
	 *     settle header-only, keep reopenable for the next same-key batch;
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
		this.cancelDebouncedChildFold();
		const group = this.currentGroup;
		if (group) {
			group.hardExited = true;
			fold_group_child_rows(group);
		}
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

	/** Recover the latest settled same-key group when `currentGroup` was lost. */
	private findReopenableGroup(key: string): DiscoveryGroup | undefined {
		let candidate: DiscoveryGroup | undefined;
		let candidate_index = -1;
		let index = 0;
		for (const record of this.calls.values()) {
			const group = record.group;
			if (group && !group.hardExited && group.key === key) {
				if (index >= candidate_index) {
					candidate_index = index;
					candidate = group;
				}
			}
			index++;
		}
		return candidate;
	}

	/** Hard boundary: non-groupable tool (subagent, quiz, …) appeared
	 *  chronologically after the work group — freeze header and never reopen. */
	noteInterveningToolCall(): void {
		this.hardExitGroup();
	}

	/** Soft boundary: transcript tools that must not spawn a fresh work header
	 *  after they complete (SSOT: `WORK_GROUP_SOFT_BOUNDARY_TOOLS`). Settles
	 *  to header-only and keeps `reopenGroupKey` so the next groupable call
	 *  reopens the same bundle (Thinking lane when blocks are hidden). */
	noteSoftInterveningToolCall(): void {
		this.cancelDebouncedChildFold();
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.records.length < 1) return;
		this.settleGroups();
		group.thinkingChild = false;
		if (group.key) this.reopenGroupKey = group.key;
		group.migrateAnchorOnNextWave = true;
		this.currentGroup = group;
		this.refreshGroupInPlace(group);
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

	/** Hard boundary when thinking is visible in the transcript: freeze the work
	 *  group header and spawn a fresh group for the next tool wave downstream. */
	noteVisibleThinking(): void {
		this.cancelDebouncedChildFold();
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.records.length < 1) return;
		if (group.records.some((r) => !r._completed)) return;
		this.hardExitGroup();
	}

	/** Soft settle for hidden thinking: past-tense header + in-group `└ Thinking`
	 *  appended after lingering tool rows until the next tool call reopens the lane. */
	/** Core implementation for arming the in-group `└ Thinking` lane. */
	private arm_in_group_thinking(): void {
		this.cancelDebouncedChildFold();
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		this.settleGroups();
		if (!group || group.records.length < 1) return;
		// Arm the in-group `└ Thinking` lane even while a tool is still running:
		// a thinking stream can arrive between tool batches (inter-run gap)
		// before the prior tool's result renders. The thinking row appends
		// after the lingering tool row.
		if (group.migrateAnchorOnNextWave) return;
		this.currentGroup = group;
		if (isThinkingBlocksHidden()) {
			const entering_thinking_lane = !group.thinkingChild;
			// Fold lingering tool children when the caller requested it (inter-run
			// gap pre-token arm). Outside that, children linger and the thinking
			// row appends after them.
			if (entering_thinking_lane && this.foldChildrenOnNextThinking) {
				fold_group_child_rows(group);
				this.foldChildrenOnNextThinking = false;
			}
			group.thinkingChild = true;
			group.settled = true;
			if (entering_thinking_lane) {
				reset_thinking_pass_timer();
			}
		}
		this.reopenGroupKey = group.key;
		this.refreshGroupInPlace(group);
		this.syncGroupTick(group);
	}

	/** Public seam: arm the renderer's in-group `└ Thinking` lane when blocks
	 *  are hidden and the group has at least one completed record. */
	armInGroupThinking(): void {
		if (!isThinkingBlocksHidden()) return;
		this.arm_in_group_thinking();
	}

	noteThinking(): void {
		this.arm_in_group_thinking();
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
		this.cancelDebouncedChildFold();
		this.unsubscribeGroupTick();
		this.calls.clear();
		this.currentGroup = undefined;
		this.reopenGroupKey = undefined;
		this.foldChildrenOnNextThinking = false;
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
		if (group.thinkingChild && isThinkingBlocksHidden()) return true;
		return group.records.some((r) => !r._completed);
	}

	/** Whether the live group can host in-group Thinking (settled / thinking lane). */
	hasReopenableGroup(): boolean {
		const group = this.resolveLiveGroup();
		if (!group || group.hardExited || group.records.length < 1) return false;
		return group.settled === true;
	}

	/** Whether the live group is painting an in-group Thinking child row. */
	hasGroupThinkingChild(): boolean {
		const group = this.resolveLiveGroup();
		return group?.thinkingChild === true && isThinkingBlocksHidden();
	}

	/** Whether the live group still shows lingering tool child rows. */
	hasVisibleGroupChildren(): boolean {
		const group = this.resolveLiveGroup();
		if (!group) return false;
		return groupVisibleChildren(group).length > 0;
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

	/** Shrink/fold transitions: repaint in place without invalidating the anchor
	 *  owner — invalidation can re-anchor the block at the transcript tail. */
	private refreshGroupInPlace(group: DiscoveryGroup | undefined): void {
		this.refreshGroupVisual(group);
		if (group) group.pendingShrink = false;
	}

	private group_transcript_anchor(group: DiscoveryGroup): CompactCall | undefined {
		if (!group.anchorOwner) {
			group.anchorOwner = group.renderOwner ?? group.records[0];
		}
		return group.anchorOwner ?? group.renderOwner ?? group.records[0];
	}

	private should_schedule_group_shrink_invalidation(group: DiscoveryGroup): boolean {
		return Boolean(group.pendingShrink && !(group.thinkingChild && isThinkingBlocksHidden()));
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
			if (!this.refreshActiveGroupText()) return;
			requestTuiRender();
		};
		subscribeGradientTick(this.groupTickCb);
	}

	private refreshActiveGroupText(): boolean {
		const group = this.groupTickGroup;
		const theme = this.lastTheme;
		if (!group?.callText || !theme) return false;
		const next = formatGroup(group, theme);
		if (group.callText.text === next) return false;
		set_compact_call_text(group, group.callText, next);
		return true;
	}

	/** Keep the gradient tick subscribed while visible child rows render
	 *  (runners and lingering completed children). Settled groups are
	 *  header-only and static. */
	private syncGroupTick(group: DiscoveryGroup): void {
		if (group_needs_gradient_tick(group)) {
			this.subscribeGroupTick(group);
			return;
		}
		this.unsubscribeGroupTick();
	}

	/** Re-evaluate gradient tick subscription after agent settle or transcript rebuild. */
	resyncGroupGradientTick(): void {
		const group = this.currentGroup;
		if (!group) {
			this.unsubscribeGroupTick();
			return;
		}
		this.syncGroupTick(group);
	}

	/** Repaint work groups after Ctrl+T without folding lingering child rows. */
	repaintAfterThinkingBlocksToggle(blocks_hidden: boolean, restore_thinking_lane = false): void {
		this.cancelDebouncedChildFold();
		const seen = new Set<DiscoveryGroup>();
		for (const record of this.calls.values()) {
			const group = record.group;
			if (!group || seen.has(group)) continue;
			seen.add(group);
			if (!blocks_hidden && group.thinkingChild) {
				group.thinkingChild = false;
				if (!group.settled) group.settled = true;
			}
		}
		if (blocks_hidden && restore_thinking_lane) {
			this.restoreInGroupThinkingLaneIfSettled();
		}
		this.repaintAllGroupVisuals();
		this.resyncGroupGradientTick();
	}

	/** Re-arm in-group `└ Thinking` after hiding blocks during an active wait. */
	restoreInGroupThinkingLaneIfSettled(): void {
		if (!isThinkingBlocksHidden()) return;
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.hardExited || group.migrateAnchorOnNextWave) return;
		if (group.records.length < 1 || group.records.some((record) => !record._completed)) return;
		if (group.thinkingChild) return;
		if (!group.settled && groupVisibleChildren(group).length === 0) return;
		group.thinkingChild = true;
		group.settled = true;
		this.currentGroup = group;
		this.reopenGroupKey = group.key;
		this.refreshGroupInPlace(group);
		this.syncGroupTick(group);
	}

	private repaintAllGroupVisuals(): void {
		const theme = this.lastTheme;
		if (!theme) return;
		const seen = new Set<DiscoveryGroup>();
		for (const record of this.calls.values()) {
			const group = record.group;
			if (!group || group.records.length <= 1 || seen.has(group)) continue;
			seen.add(group);
			const callText = group.callText ?? group.renderOwner?.callText;
			if (!callText) continue;
			group.callText = callText;
			set_compact_call_text(group, callText, formatGroup(group, theme));
		}
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

	private cancelDebouncedChildFold(): void {
		if (this.childFoldDebounceTimer) {
			clearTimeout(this.childFoldDebounceTimer);
			this.childFoldDebounceTimer = undefined;
		}
		this.childFoldDebounceGroup = undefined;
		this.childFoldAbsorbBefore = 0;
	}

	private scheduleDebouncedChildFold(group: DiscoveryGroup, absorb_before: number): void {
		const same_group = this.childFoldDebounceGroup === group;
		const next_absorb = same_group
			? Math.max(this.childFoldAbsorbBefore, absorb_before)
			: absorb_before;
		if (this.childFoldDebounceTimer) {
			clearTimeout(this.childFoldDebounceTimer);
		}
		this.childFoldDebounceGroup = group;
		this.childFoldAbsorbBefore = next_absorb;
		this.childFoldDebounceTimer = setTimeout(() => {
			this.childFoldDebounceTimer = undefined;
			const pending = this.childFoldDebounceGroup;
			const absorb = this.childFoldAbsorbBefore;
			this.childFoldDebounceGroup = undefined;
			this.childFoldAbsorbBefore = 0;
			if (!pending || pending !== group) return;
			pending.childAbsorbBefore = Math.max(pending.childAbsorbBefore ?? 0, absorb);
			this.refreshGroupInPlace(pending);
		}, GROUP_CHILD_FOLD_DEBOUNCE_MS);
	}

	private migrate_group_anchor(group: DiscoveryGroup, record: CompactCall): void {
		const prev = this.group_transcript_anchor(group);
		group.renderOwner = record;
		group.anchorOwner = record;
		group.migrateAnchorOnNextWave = false;
		if (prev && prev !== record) prev.invalidate?.();
	}

	private appendToGroup(group: DiscoveryGroup, record: CompactCall): void {
		if (group.migrateAnchorOnNextWave) {
			this.migrate_group_anchor(group, record);
		}
		for (const member of group.records) member.group = group;
		const prior_all_done =
			group.records.length > 0 && group.records.every((member) => member._completed);
		const has_visible_children = groupVisibleChildren(group).length > 0;
		const reopening_from_thinking = group.thinkingChild;
		const repeats_visible_child = is_repeat_visible_group_call(group, record.name, record.args);
		// New tool wave: absorb prior rows when the group has visibly moved on
		// (every prior member done, or the group already settled before this
		// call reopened it) or we are leaving the thinking lane. Skip todo-style
		// soft boundaries and repeated same-signature calls — those keep
		// lingering. A settled group reopening with a still-running prior member
		// still folds: the prior wave is historical. Reopening from the thinking
		// lane folds immediately (synchronous) so the new tool wave is the only
		// visible lane; a completed-prior wave folds after the debounce window.
		const prior_wave_done = prior_all_done || group.settled === true;
		if (has_visible_children && !repeats_visible_child && reopening_from_thinking) {
			this.cancelDebouncedChildFold();
			fold_group_child_rows(group);
		} else if (
			has_visible_children &&
			!repeats_visible_child &&
			prior_wave_done
		) {
			this.scheduleDebouncedChildFold(group, group.records.length);
		} else if (group.records.length === 0 || group.records.every((r) => r._completed)) {
			this.cancelDebouncedChildFold();
		}
		group.thinkingChild = false;
		group.settled = false;
		group.records.push(record);
		record.group = group;
		// Transcript anchor stays on the first member unless a soft boundary
		// (todo) requested migration on the next tool wave.
		this.currentGroup = group;
		if (group.key) this.reopenGroupKey = group.key;
		this.scheduleGroupInvalidation(group);
	}

	private startGroup(key: string, record: CompactCall): DiscoveryGroup {
		const group: DiscoveryGroup = {
			records: [record],
			renderOwner: record,
			anchorOwner: record,
			type: key === WORK_GROUP_KEY ? "work" : "discovery",
			key,
			childAbsorbBefore: 0,
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
			const block_reopen =
				this.currentGroup != null &&
				!this.currentGroup.hardExited &&
				this.currentGroup.key !== key;
			const reopenable = block_reopen ? undefined : this.findReopenableGroup(key);
			if (reopenable) {
				this.currentGroup = reopenable;
				this.appendToGroup(reopenable, record);
			} else {
				if (block_reopen && this.currentGroup) {
					this.currentGroup.hardExited = true;
					this.freezeGroup(this.currentGroup);
					this.unsubscribeGroupTick();
				}
				this.startGroup(key, record);
			}
		}
		record.invalidate = invalidate;
		return record;
	}

	private refreshRecordGroupHeader(record: CompactCall): void {
		const group = record.group;
		if (!group || group.records.length <= 1 || !group.callText || !this.lastTheme) return;
		if (record.name !== "edit" && record.name !== "write" && record.name !== "apply_patch") return;
		set_compact_call_text(group, group.callText, formatGroup(group, this.lastTheme));
	}

	setResult(record: CompactCall, result: ToolResult, isError: boolean): void {
		const prev_diff = typeof record.result?.details?.diff === "string" ? record.result.details.diff : "";
		const next_diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
		const unchanged_snapshot =
			record._completed &&
			record.result === result &&
			record.isError === isError &&
			prev_diff === next_diff;
		if (unchanged_snapshot) {
			this.refreshRecordGroupHeader(record);
			return;
		}
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
		const group = record.group;
		if (group && group.records.length > 1) {
			if (this.group_transcript_anchor(group) !== record) return new Text("", 0, 0);
			const callText =
				context.state.callText instanceof CompactGroupText
					? context.state.callText
					: new CompactGroupText();
			context.state.callText = callText;
			// Re-bind the group's shared visual handle to the owner's live
			// component on every render. On Pi rebuilds (thinking-toggle,
			// compaction, settings) context.state is fresh, so a new component is
			// created and the group handle is repointed to the live owner.
			group.callText = callText;
			set_compact_call_text(group, callText, formatGroup(group, theme));
			if (this.should_schedule_group_shrink_invalidation(group)) {
				this.scheduleGroupInvalidation(group);
			}
			this.syncGroupTick(group);
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
				if (this.should_schedule_group_shrink_invalidation(record.group)) {
					this.scheduleGroupInvalidation(record.group);
				}
			}
			this.syncGroupTick(record.group);
			if (this.group_transcript_anchor(record.group) !== record) return new Text("", 0, 0);
			// When the group is collapsed (settled + thinking hidden), hide the
			// per-member error row too — the header bullet already turns red to
			// signal the failure. Reuses the same collapse gate as formatGroup.
			const group_collapsed =
				record.group.settled === true &&
				record.group.records.length > 0 &&
				record.group.records.every((r) => r._completed) &&
				isThinkingBlocksHidden();
			const error = errorText(result, context.isError);
			if (
				error &&
				is_active_group_error(record, record.group) &&
				name !== "apply_patch" &&
				!group_collapsed
			) {
				return compactErrorComponent(error, theme);
			}
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
		if (error && is_active_group_error(record, record.group) && name !== "apply_patch") {
			return compactErrorComponent(error, theme);
		}
		if (expanded) {
			const output = formatExpandedOutput(result, theme);
			if (output) return new Text(output, 0, 0);
		}
		return new Text("", 0, 0);
	}
}

export { DISCOVERY_TOOLS, GROUPABLE_TOOLS };
export { bashGrepInfo } from "./bash-grep.ts";
export const __test_only = { set_compact_call_text };
