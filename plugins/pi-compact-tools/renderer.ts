import { parseStreamingJson } from "@earendil-works/pi-ai/compat";
import { type Component, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import {
	type ApplyPatchDetails,
	compact_patch_failure_reason,
	format_patch_error_row,
	type PatchFileRow,
	patch_file_errors_by_path,
	patch_files_from_input,
	patch_has_file_errors,
} from "../pi-ember-applypatch/display.ts";
import { get_gradient_phase, render_gradient } from "../pi-ember-ui/gradient.ts";
import {
	format_thinking_pass_elapsed_suffix,
	MUTED_GROUP_GRADIENT_PRESET,
	requestGradientRender,
	requestTuiRender,
	subscribeGradientTick,
	unsubscribeGradientTick,
} from "../pi-ember-ui/index.ts";
import { isThinkingBlocksHidden } from "../pi-ember-ui/mode-colors.ts";
import { format_in_group_thinking_row } from "../pi-ember-ui/thinking-status-render.ts";
import { bashGrepInfo } from "./bash-grep.ts";
import { BULLET, CompactGroupText } from "./compact-text.ts";
/** Kept for test imports but no longer used — different tool names fold immediately. */
export const GROUP_CHILD_FOLD_DEBOUNCE_MS = 0;

/** Whether the incoming tool shares its name with the last visible group
 *  child. Same-name calls (e.g. read a.ts → read b.ts) append below without
 *  folding prior children; only a different tool name folds the prior wave. */
function is_repeat_visible_group_call(group: DiscoveryGroup, name: string): boolean {
	const visible = groupVisibleChildren(group);
	const last = visible[visible.length - 1];
	return last?.name === name;
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
export const TREE_BRANCH_PIPE = "│ ";
/** Tee branch for non-terminal subagent rows (vertical continues + opens right). */
export const TREE_BRANCH_TEE = "├ ";
export const TREE_BRANCH_LAST = "└ ";
/** One branch vocabulary for main and nested subagent work-group children. */
export type CompactGroupChildBranch = "pipe" | "tee" | "last";

const COMPACT_GROUP_CHILD_PIPE = "│";
const COMPACT_GROUP_CHILD_TEE = "├";
const COMPACT_GROUP_CHILD_LAST = "└";
const COMPACT_GROUP_CHILD_LIVE_CONNECTOR = "─";
const COMPACT_GROUP_CHILD_INDENT = "  ";

/**
 * Build a compact work-group child prefix from the canonical branch
 * vocabulary. Completed prior rows use a bare vertical pipe and their body
 * starts immediately after it; only active rows and the Thinking frontier
 * carry the horizontal `─` connector.
 *
 * `indent` keeps nested subagent trays structurally identical without
 * duplicating the branch glyph or completed-row spacing policy.
 */
export function format_compact_group_child_prefix(
	branch: CompactGroupChildBranch,
	indent = COMPACT_GROUP_CHILD_INDENT,
): string {
	if (branch === "pipe") return `${indent}${COMPACT_GROUP_CHILD_PIPE}`;
	if (branch === "tee") {
		return `${indent}${COMPACT_GROUP_CHILD_TEE}${COMPACT_GROUP_CHILD_LIVE_CONNECTOR}`;
	}
	return `${indent}${COMPACT_GROUP_CHILD_LAST}${COMPACT_GROUP_CHILD_LIVE_CONNECTOR}`;
}

/** Main work-group derived prefixes. Nested trays call the formatter above. */
export const GROUP_CHILD_TEE = format_compact_group_child_prefix("tee");
export const GROUP_CHILD_LAST = format_compact_group_child_prefix("last");
/** Latest/active work-group frontier (running verb or Thinking lane). */
export const GROUP_CHILD_TEE_LIVE = GROUP_CHILD_LAST;
/** Completed prior child: no connector-width pad after the vertical pipe. */
export const GROUP_CHILD_PIPE = format_compact_group_child_prefix("pipe");
/** Nested subagent tool rows under a grouped (Subagents/Delegating) agent —
 *  flush with the branch glyph so the └ sits on the agent-name column
 *  (`  ├` places the name at column 3; tool └ goes there too). */
export const TREE_NESTED_PIPE = "  │└";
export const TREE_NESTED_LAST = "   └";
/** Single subagent tool row — └ sits at column 2 below the agent name's first letter. */
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
	 * Agent-pending wait with NO thinking stream: the latest completed child
	 * keeps its gradient `-ing` verb (Reading/Searching/…) instead of a
	 * premature `└ Thinking` lane. Cleared when a real thinking stream arms
	 * the lane, a new tool wave reopens the group, or the group freezes.
	 */
	holdingToolLane?: boolean;
	/**
	 * Cached header + child-row text (NO thinking lane) for the 20 FPS tick.
	 * Valid only while `staticTextValid` is true. The tick rebuilds just the
	 * `└ Thinking` lane instead of re-baking every child row every 50 ms.
	 */
	staticText?: string;
	/** Whether `staticText` is fresh (recomputed by the last full formatGroup). */
	staticTextValid?: boolean;
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

function set_compact_call_text(
	target: LineCountTarget,
	callText: CompactGroupText,
	text: string,
): void {
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

/** SSOT standalone single-call row (`• Read a.ts`, gradient edit/write verbs,
 *  apply_patch block). Exported for the subagent live output tray: a
 *  single-tool burst renders this bare row exactly like the main session's
 *  standalone tool call instead of a group header + child pair. */
export function formatStandaloneCallRow(record: CompactCall, theme: ThemeLike): string {
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
	// While a standalone edit/write/bash is still running (args streaming or tool
	// executing), use the gradient present-tense verb (Editing/Writing/Running) — same
	// path as group child rows — so the row animates at the shared 20 FPS cadence
	// instead of showing a static "Edit"/"Write"/"Bash" label. Completed rows keep the
	// muted past-tense label via formatCallBody.
	if ((name === "edit" || name === "write" || name === "bash") && !completed) {
		const verb = formatGroupChildGradientVerb(name, args);
		const details = formatCallBodyDetails(name, args, theme, false, false);
		if (name === "edit" || name === "write") {
			const live = name === "edit" ? streamingEditStats(args) : streamingWriteStats(args);
			const showRemovals = name === "edit";
			const stats = live
				? paint_compact_tool(theme, "  ", false) +
					formatEditStatsFromCounts(live, theme, showRemovals)
				: "";
			return bulletColor(record, theme) + verb + details + stats;
		}
		return bulletColor(record, theme) + verb + details;
	}
	const prefix = bulletColor(record, theme) + formatCallBody(name, args, theme, false, completed);
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
		if (final)
			return (
				prefix +
				paint_compact_tool(theme, "  ", true) +
				formatEditStatsFromCounts(final, theme, false)
			);
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
			if (bashGrepInfo(textValue(args?.command))) return "Searching";
			return "Running";
		}
		case "edit":
			return "Editing";
		case "write":
			return "Writing";
		case "apply_patch":
			return "Patching";
		case "todo":
			return "Todo";
		default:
			return name;
	}
}

function renderRunningGradient(text: string): string {
	return render_gradient(text, MUTED_GROUP_GRADIENT_PRESET, get_gradient_phase());
}

/** In-group `└ Thinking` lane row — elapsed comes from the SHARED turn pass
 *  timer (started on the user message, continued across every arming pass),
 *  so a real thinking stream never resets the visible elapsed suffix. */
function formatGroupThinkingChildRow(_group: DiscoveryGroup, theme: ThemeLike): string {
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
		visible.length === 1 && last_visible && is_diff_record(last_visible) && last_visible._completed
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

/** Derive a present-tense verb from the group's running (non-completed) records. */
function running_work_label(group: DiscoveryGroup): string {
	const running = group.records.filter((r) => !r._completed);
	if (running.length === 0) return "Working";
	const types = new Set<CompactGroupType | undefined>();
	for (const r of running) {
		types.add(resolve_compact_group_type(r.name, r.args));
	}
	if (types.size === 1) {
		const t = types.values().next().value;
		switch (t) {
			case "discovery": return "Exploring";
			case "editing": return "Editing";
			case "writing": return "Writing";
			case "bashing": return "Running";
			case "patching": return "Patching";
		}
	}
	return "Working";
}

/** Unified work-bundle header (`Edited N files, explored M files, … +N -N`). */
export function formatUnifiedWorkHeader(group: DiscoveryGroup, theme: ThemeLike): string {
	const segments = format_unified_work_segments(group);
	const label = segments.length > 0 ? segments.join(", ") : running_work_label(group);
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
			return paint_compact_tool(theme, ` ${stripped}`, completed);
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
		case "todo": {
			const action = textValue(args?.action);
			return action ? paint_compact_tool(theme, ` ${action}`, completed) : "";
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
	_inGroup = false,
	completed = true,
): string {
	// Bash grep calls are searches (counted in the `N searches` header and
	// routed to the discovery group) — label them `Search` exactly like the
	// grep tool row, never the empty verb or a misleading `Ran <pattern>`.
	// (The running path already animates these as `Searching`.)
	if (name === "bash" && bashGrepInfo(textValue(args?.command))) {
		return paint_compact_tool_label(theme, "Search", completed);
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
			return paint_compact_tool_label(theme, completed ? "Ran" : "Running", completed);
		case "edit":
			return paint_compact_tool_label(theme, "Edit", completed);
		case "write":
			return paint_compact_tool_label(theme, "Write", completed);
		case "apply_patch":
			return paint_compact_tool_label(theme, completed ? "Patched" : "Patch", completed);
		case "todo":
			return paint_compact_tool_label(theme, "Todo", completed);
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
			suffixes.push(
				theme.fg("muted", `${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`),
			);
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
	return `${base} ${suffixes.join(" ")}`;
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

function apply_patch_bullet(
	record: CompactCall,
	group: DiscoveryGroup | undefined,
	theme: ThemeLike,
): string {
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
	_record: CompactCall,
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
	const file_row_index = new Map<string, number>();
	for (const record of visible_records) {
		for (const file of patch_files_for_record(record)) {
			const key = normalize_patch_display_path(file.path);
			const existing = file_row_index.get(key);
			if (existing !== undefined) {
				const row = visible_file_rows[existing];
				if (row) {
					// Same file patched again: accumulate into the existing row
					// instead of adding a duplicate per-file child.
					row.file = {
						path: row.file.path,
						additions: row.file.additions + file.additions,
						removals: row.file.removals + file.removals,
					};
					if (record._completed !== true) row.completed = false;
					continue;
				}
			}
			file_row_index.set(key, visible_file_rows.length);
			visible_file_rows.push({ file: { ...file }, completed: record._completed === true });
		}
	}
	const has_errors = patch_errors_for_records(visible_records).size > 0;
	const bullet = has_errors ? theme.fg("error", BULLET) : groupBulletColor(group, theme);
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
		const is_last_child = index === children.length - 1;
		const prefix = format_compact_group_child_prefix(
			is_last_child ? "last" : child.completed ? "pipe" : "tee",
		);
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
		group.records.length >= 2 && group.records.every((record) => record.name === "apply_patch")
	);
}

/** Child rows under a group header — SSOT for compact + cursor. */
export function selectGroupVisibleChildren<T>(items: readonly T[], absorb_before: number): T[] {
	const start = Math.max(0, Math.min(absorb_before, items.length));
	return items.slice(start);
}

function groupVisibleChildren(group: DiscoveryGroup): CompactCall[] {
	return selectGroupVisibleChildren(group.records, group.childAbsorbBefore ?? 0);
}

/** Whether the group still needs the shared 20 FPS gradient tick. */
export function group_needs_gradient_tick(group: DiscoveryGroup): boolean {
	if (group.thinkingChild && isThinkingBlocksHidden()) return true;
	// The tool-lane hold animates the children's `-ing` verbs at 20 FPS
	// (both block-visibility modes).
	if (group.holdingToolLane === true) return true;
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
	const staticText = buildGroupStaticText(group, theme);
	// Refresh the tick cache: every non-tick path calls formatGroup AFTER
	// mutating group state, so the cached prefix is always the current one.
	group.staticText = staticText;
	group.staticTextValid = true;
	if (group.thinkingChild && isThinkingBlocksHidden()) {
		return `${staticText}\n${formatGroupThinkingLane(group, theme)}`;
	}
	return staticText;
}

/** Header + child rows (NO thinking lane) — cached on the group so the
 *  20 FPS tick rebuilds only the `└ Thinking` lane instead of re-baking
 *  every child row every 50 ms. The last-child prefix depends on
 *  `thinkingChild` and the latest row's live `-ing` state, so arming/clearing
 *  the lane or a verb change (which routes through formatGroup) refreshes the
 *  cache with the new prefix.
 *
 *  `noBullet` omits the group bullet for nested subagent trays where the
 *  outer tree branch already marks the block. `childPrefixIndent` overrides
 *  the default two-space child indent (use "" for nested trays whose outer
 *  prefix supplies the lateral spacing). */
export function buildGroupStaticText(
	group: DiscoveryGroup,
	theme: ThemeLike,
	noBullet = false,
	childPrefixIndent?: string,
): string {
	if (
		is_multi_patch_group(group) ||
		(!is_work_group(group) && group.type === "patching" && group.records.length >= 2)
	) {
		return format_patch_group(group, theme);
	}
	const headerText = groupHeaderLabel(group, theme);
	const lines = [noBullet ? headerText : groupBulletColor(group, theme) + headerText];
	const children = groupVisibleChildren(group);
	const show_thinking = group.thinkingChild && isThinkingBlocksHidden();
	// Agent-pending wait with no thinking stream: the visible children of the
	// current wave keep their gradient `-ing` verbs (Reading/Searching/…)
	// until a real thinking stream arms the lane or a new tool wave reopens
	// the group. Mutations snap to past tense (Edited/Wrote/Patched).
	const hold_lane = !show_thinking && group.holdingToolLane === true;
	const child_rows = merge_group_child_rows(children);
	for (const [index, row_records] of child_rows.entries()) {
		const is_last_child = index === child_rows.length - 1 && !show_thinking;
		// A merged row is "completed" for prefix purposes when all source
		// records are completed AND the hold lane is not active. The hold
		// lane keeps completed children in their gradient `-ing` verbs, so
		// they visually read as active and keep the `├─` tee.
		const row_completed = is_merged_row_completed(row_records) && !(hold_lane && is_last_child);
		// Completed prior children are bare `│` continuations with no
		// connector-width padding, so their body sits flush against the pipe.
		// Active children and the terminal Thinking lane use `├─` / `└─`.
		const prefix = format_compact_group_child_prefix(
			is_last_child ? "last" : row_completed ? "pipe" : "tee",
			childPrefixIndent,
		);
		lines.push(
			theme.fg("dim", prefix) +
				formatGroupChildRows(row_records, theme, hold_lane, is_last_child),
		);
	}
	return lines.join("\n");
}

/** The single in-group Thinking lane row — the latest/active entry, so it
 *  sits as an L-shaped `└─` live lane instead of a plain terminal `└`. */
function formatGroupThinkingLane(group: DiscoveryGroup, theme: ThemeLike): string {
	return (
		theme.fg("dim", format_compact_group_child_prefix("last")) +
		formatGroupThinkingChildRow(group, theme)
	);
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

/** Hold-state verb for the latest visible child during an agent-pending wait
 *  with no thinking stream: discovery tools keep the gradient `-ing` verb
 *  (Reading/Searching/…) as if the agent is still working, while completed
 *  mutations (edit/write/apply_patch) snap to past tense (Edited/Wrote/Patched). */
function hold_child_verb(record: CompactCall, theme: ThemeLike): string {
	switch (record.name) {
		case "edit":
			return paint_compact_tool_label(theme, "Edited", true);
		case "write":
			return paint_compact_tool_label(theme, "Wrote", true);
		case "apply_patch":
			return paint_compact_tool_label(theme, "Patched", true);
		default:
			return formatGroupChildGradientVerb(record.name, record.args);
	}
}

function formatGroupChildRow(record: CompactCall, theme: ThemeLike, hold_lane = false): string {
	const completed = record._completed === true;
	const verb = completed
		? hold_lane
			? hold_child_verb(record, theme)
			: formatCallBodyVerb(record.name, record.args, theme, true, true)
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

/**
 * Native compact single child row (verb + details + edit/write stats) — the
 * SSOT shared by the main agent's compact group children and the subagent
 * live tool tray. Plugins render nested subagent tool activity through this
 * formatter (never re-derive the row shape), so nested rows stay identical to
 * the main agent and merge/fold/diff-stats behavior flows through unchanged
 * instead of drifting into a parallel implementation that can stack rows.
 */
export function formatCompactChildRow(
	name: string,
	args: ToolArgs,
	completed: boolean,
	result: Record<string, unknown> | undefined,
	theme: ThemeLike,
): string {
	return formatGroupChildRow(
		{ name, args, _completed: completed, result } as CompactCall,
		theme,
	);
}

/**
 * Merge identity for same-file diff calls: `edit`/`write` merge by normalized
 * target path; `apply_patch` by its first touched file. Consecutive (or any
 * same-file) calls render as ONE child row with accumulated +N -N instead of a
 * duplicate row per call. Non-diff tools never merge.
 */
function group_child_merge_identity(record: CompactCall): string | undefined {
	if (record.name === "edit" || record.name === "write") {
		return `${record.name}:${targetPathForRecord(record)}`;
	}
	if (record.name === "apply_patch") {
		const first = patch_files_for_record(record)[0];
		if (!first) return undefined;
		return `apply_patch:${normalize_patch_display_path(first.path)}`;
	}
	return undefined;
}

/**
 * Collapse visible children into rows: same-file diff calls share one row
 * (first occurrence keeps the slot; later same-file calls merge into it),
 * so `edit a.ts; edit a.ts` shows one `Editing a.ts +N -N` row instead of a
 * duplicate. Merging is render-time only — each call keeps its own record
 * for result tracking and Pi rebuilds.
 */
/** SSOT same-file child merge — exported for the subagent live output tray. */
export function merge_group_child_rows(children: readonly CompactCall[]): CompactCall[][] {
	const rows: CompactCall[][] = [];
	const row_by_identity = new Map<string, number>();
	for (const record of children) {
		const identity = group_child_merge_identity(record);
		if (identity !== undefined) {
			const existing = row_by_identity.get(identity);
			if (existing !== undefined) {
				rows[existing]?.push(record);
				continue;
			}
			row_by_identity.set(identity, rows.length);
		}
		rows.push([record]);
	}
	return rows;
}

/** Whether a merged row (one or more same-file records) is fully completed.
 *  A merged row is completed only when ALL source records are completed —
 *  a still-running member keeps the row in its live `-ing` verb. */
export function is_merged_row_completed(records: readonly CompactCall[]): boolean {
	return records.length > 0 && records.every((r) => r._completed === true);
}

/** Accumulated +N -N across merged same-file diff records. */
function merged_child_diff_stats(
	records: readonly CompactCall[],
): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const record of records) {
		if (record.name === "edit") {
			const counts = edit_diff_counts(record.args, record.result, record._completed === true);
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

/** One visible child row; merged same-file records accumulate their +N -N.
 *  Exported for the subagent live output tray (same shape as main groups). */
export function formatGroupChildRows(
	records: readonly CompactCall[],
	theme: ThemeLike,
	hold_lane = false,
	is_last = false,
): string {
	const last = records[records.length - 1];
	if (!last) return "";
	const effective_hold = hold_lane && is_last;
	if (records.length === 1) return formatGroupChildRow(last, theme, effective_hold);
	const completed = last._completed === true;
	const verb = completed
		? effective_hold
			? hold_child_verb(last, theme)
			: formatCallBodyVerb(last.name, last.args, theme, true, true)
		: formatGroupChildGradientVerb(last.name, last.args);
	const details = formatCallBodyDetails(last.name, last.args, theme, true, completed);
	const counts = merged_child_diff_stats(records);
	const show_removals =
		last.name === "edit" ? true : last.name === "write" ? false : counts.removals > 0;
	const stats = formatEditStatsFromCounts(counts, theme, show_removals, true);
	return verb + details + (stats ? paint_compact_tool(theme, "  ", completed) + stats : "");
}

/** Fold completed tool rows into the group header — SSOT flush boundary. */
export function fold_group_child_rows(group: DiscoveryGroup): void {
	group.childAbsorbBefore = group.records.length;
	// The visible children changed; drop the tick's static-prefix cache so the
	// next frame re-bakes the header + remaining rows before the lane repaints.
	group.staticTextValid = false;
}

export class CompactRenderer {
	private readonly calls = new Map<string, CompactCall>();
	/** The single live group. Soft settles (thinking-hidden / agent_end) keep
	 *  this pointer so a later same-key call can reopen via appendToGroup.
	 *  Hard settles (visible text, visible thinking, user message) clear it
	 *  so the next group starts at its own transcript position. */
	private currentGroup: DiscoveryGroup | undefined;
	private readonly pendingGroupInvalidations = new Set<DiscoveryGroup>();
	private pendingGroupRenderRequestTimer: ReturnType<typeof queueMicrotask> | undefined;
	/** Invalidates queued native render requests across session replacement. */
	private renderGeneration = 0;

	/** Stable tick callback — updates component state before Pi's native render. */
	private groupTickCb: (() => void) | undefined;
	private groupTickGroup: DiscoveryGroup | undefined;
	/**
	 * O(1) count of groups currently painting the in-group `└ Thinking` lane
	 * (thinkingChild === true). Maintained by {@link setThinkingChild} so
	 * `hasAnyGroupThinkingChild()` is a cheap counter read — the render path
	 * (20 FPS widget/in-message host) can query it live without an O(calls)
	 * scan, immune to stale synced flags or jiti module duplication.
	 */
	private thinkingLaneCount = 0;
	/** Stable tick callback for a standalone running edit/write (single-member
	 *  work group) so its gradient Editing/Writing verb animates at 20 FPS. */
	private standaloneTickCb: (() => void) | undefined;
	private standaloneTickRecord: CompactCall | undefined;
	private lastTheme: ThemeLike | undefined;
	/** Last same-key group type kept for reopen after soft settle. */
	private reopenGroupKey: string | undefined;

	beginTurn(): void {
		// Child rows linger through turn_end; fold only on a genuinely new
		// tool wave (different tool name) or a hard boundary. Thinking never
		// folds prior tool children — the `└ Thinking` lane appends after
		// lingering tool rows.
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
	 * Enter thinking lane: a REAL thinking stream only
	 * (`apply_assistant_stream_boundary` → `noteHiddenThinking()` →
	 * `arm_in_group_thinking()`). The wait arm (`holdToolLane()`) never paints
	 * the lane — it keeps the tool lane with the latest child in its gradient
	 * `-ing` verb until the model actually emits reasoning.
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
		this.setThinkingChild(group, false);
		group.holdingToolLane = false;
		if (!group.settled) group.settled = true;
		this.refreshGroupVisual(group);
		this.scheduleGroupInvalidation(group);
	}

	/** Hard boundary — freeze the live group and stop reopening it. */
	private hardExitGroup(): void {
		const group = this.currentGroup;
		if (group) {
			group.hardExited = true;
			fold_group_child_rows(group);
		}
		this.freezeGroup(group);
		this.unsubscribeGroupTick();
		this.unsubscribeStandaloneTick();
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

	/** Mutate `group.thinkingChild` keeping the O(1) lane counter in sync.
	 *  Every arm/clear site must go through here so `hasAnyGroupThinkingChild()`
	 *  (the render-path gate) can never diverge from the painted lane. */
	private setThinkingChild(group: DiscoveryGroup, value: boolean): void {
		const current = group.thinkingChild === true;
		if (current === value) return;
		group.thinkingChild = value;
		this.thinkingLaneCount += value ? 1 : -1;
	}

	/** Soft boundary: transcript tools that must not spawn a fresh work header
	 *  after they complete (SSOT: `WORK_GROUP_SOFT_BOUNDARY_TOOLS`). Settles
	 *  to header-only and keeps `reopenGroupKey` so the next groupable call
	 *  reopens the same bundle (Thinking lane when blocks are hidden). */
	noteSoftInterveningToolCall(): void {
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.records.length < 1) return;
		this.settleGroups();
		this.setThinkingChild(group, false);
		group.holdingToolLane = false;
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
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.records.length < 1) return;
		this.hardExitGroup();
	}

	/** Core implementation for arming the in-group `└ Thinking` lane. */
	private arm_in_group_thinking(): void {
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
			// Thinking never folds prior tool children — the `└ Thinking` lane
			// appends after lingering tool rows. Children fold only on a
			// genuinely new tool wave (different tool name) or a hard boundary.
			this.setThinkingChild(group, true);
			group.settled = true;
			// The lane's elapsed suffix reads the SHARED turn pass timer (started
			// on the user message) — arming here never resets it, so a real
			// thinking stream continues the post-tool wait timer instead of
			// restarting it on every thinking_delta.
			group.holdingToolLane = false;
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

	/** Keep the tool lane live during an agent-pending wait with NO thinking
	 *  stream: the visible children of the current wave keep their gradient
	 *  `-ing` verbs (Reading/Searching/…) until a real thinking stream arms
	 *  the `└ Thinking` lane or a new tool wave reopens the group. Applies in
	 *  BOTH block-visibility modes — with blocks visible the transcript owns
	 *  reasoning, but the pre-thinking wait still reads as ongoing work. A
	 *  real thinking stream owns the lane — the hold must never disarm it.
	 *  The lane's elapsed suffix is driven by the shared turn pass timer, so
	 *  nothing here starts or resets a timer. */
	holdToolLane(): void {
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.hardExited || group.migrateAnchorOnNextWave) return;
		if (group.records.length < 1) return;
		// A real thinking stream owns the lane; never replace it with a hold.
		if (group.thinkingChild) return;
		this.currentGroup = group;
		// Pure multi-patch groups have no verb lanes to animate — settle them to
		// the past-tense summary like a normal completion.
		if (is_multi_patch_group(group)) {
			this.settleGroups();
			return;
		}
		if (group.holdingToolLane) {
			// agent_end/settle may have dropped the tick; keep it running so the
			// gradient `-ing` verb keeps animating through the whole wait.
			this.syncGroupTick(group);
			return;
		}
		group.holdingToolLane = true;
		group.settled = true;
		this.reopenGroupKey = group.key;
		this.refreshGroupInPlace(group);
		this.syncGroupTick(group);
	}

	noteThinking(): void {
		this.arm_in_group_thinking();
	}

	/** Arm the in-group `└ Thinking` lane for hidden reasoning.
	 *  Hidden reasoning is NOT a separate transcript block — the group stays
	 *  reopenable so the next tool wave folds prior children (different tool
	 *  name) and reopens under the same header instead of spawning a fresh
	 *  Explored/Edited/… row. */
	noteHiddenThinking(): void {
		// Hidden reasoning occupies the in-group `└ Thinking` lane but is NOT a
		// separate transcript block — the group stays reopenable so the next
		// tool wave folds prior children (different tool name) and reopens under
		// the same header instead of spawning a fresh Explored/Edited/… row.
		this.arm_in_group_thinking();
	}

	/** Leave the thinking/tool hold lane when the agent fully settles —
	 *  header-only, keep currentGroup for a later same-key reopen. */
	clearGroupThinkingChild(): void {
		const group = this.currentGroup;
		if (!group || (!group.thinkingChild && !group.holdingToolLane)) return;
		// A post-tool wait uses holdingToolLane rather than the Thinking child.
		// It must be cleared at agent_settled too; otherwise
		// resyncGroupGradientTick would keep the 20 FPS subscriber alive after
		// the agent is done.
		this.freezeGroup(group);
		this.syncGroupTick(group);
	}

	/** Stop every compact-renderer gradient subscription at a terminal agent
	 *  boundary. Incomplete standalone edit/write/bash calls may not receive a
	 *  result callback, so their tick cannot rely on renderResult cleanup. */
	stopGradientTicks(): void {
		this.unsubscribeGroupTick();
		this.unsubscribeStandaloneTick();
	}

	/** The model announced the next tool call (message_update toolcall_start or
	 *  the tool_call lifecycle event). Remove the in-group `└ Thinking` lane
	 *  immediately in this same component update — never wait for the 20 FPS
	 *  gradient tick or for tool_call to fire after args finish streaming. The
	 *  group stays settled and reopenable: the arriving same-key call reopens
	 *  the header via appendToGroup, preserving hidden-thinking soft grouping
	 *  and lingering children. Hard boundaries (visible text / visible thinking
	 *  / user message / non-groupable tool) still route through their own
	 *  note* methods — this never folds or hard-exits. */
	announceToolCall(): void {
		let group = this.resolveLiveGroup();
		if (!group && this.reopenGroupKey) {
			group = this.findReopenableGroup(this.reopenGroupKey);
			if (group) this.currentGroup = group;
		}
		if (!group || group.records.length < 1) return;
		if (!group.thinkingChild) return;
		this.setThinkingChild(group, false);
		// Repaint the shared CompactGroupText synchronously so the row loses the
		// `└ Thinking` lane in the frame Pi paints for this update, then re-arm
		// the gradient tick only if a visible child still needs it (a running
		// member left over from an inter-run gap).
		this.refreshGroupVisual(group);
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
		this.renderGeneration += 1;
		this.pendingGroupRenderRequestTimer = undefined;
		this.unsubscribeGroupTick();
		this.unsubscribeStandaloneTick();
		this.calls.clear();
		this.currentGroup = undefined;
		this.reopenGroupKey = undefined;
		this.pendingGroupInvalidations.clear();
		this.thinkingLaneCount = 0;
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

	/** Whether the live group can host in-group Thinking or keep a tool wave
	 *  from spawning a redundant external Thinking header. A group with any
	 *  non-hard-exited record is live; settled is not required because the
	 *  header must own the slot while a tool wave is still running/lingering. */
	hasReopenableGroup(): boolean {
		const group = this.resolveLiveGroup();
		if (!group || group.hardExited || group.records.length < 1) return false;
		return true;
	}

	/** Whether the live group is painting an in-group Thinking child row. */
	hasGroupThinkingChild(): boolean {
		const group = this.resolveLiveGroup();
		return group?.thinkingChild === true && isThinkingBlocksHidden();
	}

	/** Whether ANY group (live or lingering) has an armed/painted in-group
	 *  `└ Thinking` lane. Stronger than `hasGroupThinkingChild()` (live group
	 *  only): a painted lane that outlives the `currentGroup` pointer (rebuild
	 *  race, settle/arm ordering) must still suppress the external Thinking
	 *  hosts — hidden blocks render the lane as the ONE Thinking surface.
	 *  O(1): backed by `thinkingLaneCount`, which `setThinkingChild` keeps in
	 *  sync at every arm/clear site — so the 20 FPS render path can query it
	 *  LIVE (immune to stale synced flags or jiti module duplication) without
	 *  an O(calls) scan. */
	hasAnyGroupThinkingChild(): boolean {
		return isThinkingBlocksHidden() && this.thinkingLaneCount > 0;
	}

	/** Whether the live group still shows lingering tool child rows. */
	hasVisibleGroupChildren(): boolean {
		const group = this.resolveLiveGroup();
		if (!group) return false;
		return groupVisibleChildren(group).length > 0;
	}

	/** Re-paint the group text synchronously, but debounce the render request
	 *  so bursts of state changes (tool name switch, settle, fold) reach Pi as
	 *  one frame rather than multiple flickering intermediate frames. */
	private refreshGroupVisual(group: DiscoveryGroup | undefined): void {
		if (!group || !this.lastTheme) return;
		const callText = group.callText ?? group.renderOwner?.callText;
		if (!callText) return;
		group.callText = callText;
		set_compact_call_text(group, callText, formatGroup(group, this.lastTheme));
		this.debouncedGroupRenderRequest();
	}

	/** Coalesce TUI render requests from rapid group state changes. */
	private debouncedGroupRenderRequest(): void {
		if (this.pendingGroupRenderRequestTimer) return;
		const generation = this.renderGeneration;
		this.pendingGroupRenderRequestTimer = queueMicrotask(() => {
			if (generation !== this.renderGeneration) return;
			this.pendingGroupRenderRequestTimer = undefined;
			requestTuiRender();
		});
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
	 *  groupable tool. Idempotent per group via scheduleGroupInvalidation.
	 *  The tool-lane hold (post-tool wait) keeps its gradient tick through
	 *  settle — agent_end flips the label but the `-ing` verbs stay live
	 *  until a thinking stream or agent_settled takes over. */
	private settleGroups(): void {
		this.settleGroup(this.currentGroup);
		if (!this.currentGroup?.holdingToolLane) this.unsubscribeGroupTick();
	}

	/** Subscribe the group tick so Pi re-renders the live child verb normally. */
	private subscribeGroupTick(group: DiscoveryGroup): void {
		this.groupTickGroup = group;
		if (this.groupTickCb) return;
		this.groupTickCb = (): void => {
			// refreshActiveGroupText stages the rebuilt lane and returns false
			// when the text is unchanged (identical-frame skip). When it changed,
			// mark the gradient clock dirty — the clock issues the single native
			// render for this tick instead of the subscriber requesting one.
			if (!this.refreshActiveGroupText()) return;
			requestGradientRender();
		};
		subscribeGradientTick(this.groupTickCb);
	}

	private refreshActiveGroupText(): boolean {
		const group = this.groupTickGroup;
		const theme = this.lastTheme;
		if (!group?.callText || !theme) return false;
		let next: string;
		const lane_active = group.thinkingChild && isThinkingBlocksHidden();
		// The hold's gradient `-ing` verb is per-tick dynamic, so bypass the
		// static-prefix cache and re-bake the whole block (same cost as a
		// running child wave).
		const hold_active = group.holdingToolLane === true;
		const all_visible_completed =
			(!lane_active || groupVisibleChildren(group).every((record) => record._completed === true)) &&
			!hold_active;
		if (group.staticTextValid && group.staticText !== undefined && all_visible_completed) {
			// Static prefix cache hit: only the `└ Thinking` lane (gradient label
			// + elapsed suffix) is dynamic, so rebuild just that row instead of
			// re-baking the header and every child row every 50 ms.
			next = lane_active ? `${group.staticText}\n${formatGroupThinkingLane(group, theme)}` : group.staticText;
		} else {
			next = formatGroup(group, theme);
		}
		if (group.callText.text === next) return false;
		set_compact_call_text(group, group.callText, next);
		return true;
	}

	/** Subscribe the standalone tick so a single-member work group's running
	 *  edit/write gradient verb (Editing/Writing) animates at 20 FPS. */
	private subscribeStandaloneTick(record: CompactCall): void {
		this.standaloneTickRecord = record;
		if (this.standaloneTickCb) return;
		this.standaloneTickCb = (): void => {
			const rec = this.standaloneTickRecord;
			const theme = this.lastTheme;
			if (!rec?.callText || !theme || rec._completed) return;
			const next = formatStandaloneCallRow(rec, theme);
			if (rec.callText.text === next) return;
			set_compact_call_text(rec, rec.callText, next);
			// The gradient clock owns the single per-tick render.
			requestGradientRender();
		};
		subscribeGradientTick(this.standaloneTickCb);
	}

	/** Unsubscribe the standalone tick callback if one is active. */
	private unsubscribeStandaloneTick(): void {
		if (!this.standaloneTickCb) return;
		unsubscribeGradientTick(this.standaloneTickCb);
		this.standaloneTickCb = undefined;
		this.standaloneTickRecord = undefined;
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
		const seen = new Set<DiscoveryGroup>();
		for (const record of this.calls.values()) {
			const group = record.group;
			if (!group || seen.has(group)) continue;
			seen.add(group);
			if (!blocks_hidden && group.thinkingChild) {
				this.setThinkingChild(group, false);
				if (!group.settled) group.settled = true;
			}
		}
		if (blocks_hidden && restore_thinking_lane) {
			this.restoreInGroupThinkingLaneIfSettled(true);
		}
		this.repaintAllGroupVisuals();
		this.resyncGroupGradientTick();
	}

	/** Re-arm in-group `└ Thinking` after hiding blocks during an active wait.
	 *  `arm_lane` is true only when a real thinking stream is active — without
	 *  a stream the group enters the tool-lane hold (gradient `-ing` verbs)
	 *  instead of painting a premature Thinking lane. */
	restoreInGroupThinkingLaneIfSettled(arm_lane: boolean): void {
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
		this.currentGroup = group;
		this.reopenGroupKey = group.key;
		if (arm_lane) {
			this.setThinkingChild(group, true);
			group.settled = true;
			group.holdingToolLane = false;
			this.refreshGroupInPlace(group);
			this.syncGroupTick(group);
			return;
		}
		this.holdToolLane();
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
		const generation = this.renderGeneration;
		queueMicrotask(() => {
			if (generation !== this.renderGeneration) return;
			requestTuiRender();
		});
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
		const has_visible_children = groupVisibleChildren(group).length > 0;
		const repeats_visible_child = is_repeat_visible_group_call(group, record.name);
		// A different tool name begins a new wave: fold prior children
		// immediately so only the fresh wave is visible. Same-name calls
		// (read a.ts → read b.ts) append below without folding. Thinking
		// never folds children, but reopening from the thinking lane with a
		// different tool name folds immediately so the new tool wave owns
		// the lane.
		if (has_visible_children && !repeats_visible_child) {
			fold_group_child_rows(group);
		}
		this.setThinkingChild(group, false);
		group.holdingToolLane = false;
		group.settled = false;
		group.records.push(record);
		record.group = group;
		// A new child joined — the cached header/child prefix is stale until the
		// owner re-renders through formatGroup.
		group.staticTextValid = false;
		// The group is now multi-member: the group tick owns the gradient
		// animation, so drop any standalone tick the first member started.
		if (group.records.length > 1) this.unsubscribeStandaloneTick();
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
				this.currentGroup != null && !this.currentGroup.hardExited && this.currentGroup.key !== key;
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
		const prev_diff =
			typeof record.result?.details?.diff === "string" ? record.result.details.diff : "";
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
			fallback.setText(
				theme.fg("muted", BULLET) + formatCallBody(name, args as ToolArgs, theme, false, true),
			);
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
		} else if ((name === "edit" || name === "write" || name === "bash") && !record._completed) {
			this.subscribeStandaloneTick(record);
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
			//
			// Bind the shared visual handle when it is unset: the owner may have
			// rendered as a standalone row (records.length === 1) before a second
			// member joined and never re-rendered through the group path, so its
			// live component never became group.callText. Fall back the same way
			// repaintAllGroupVisuals does: current component -> group handle ->
			// the anchor owner's standalone handle.
			const group = record.group;
			const callText =
				context.state.callText instanceof CompactGroupText
					? context.state.callText
					: group.callText instanceof CompactGroupText
						? group.callText
						: group.renderOwner?.callText instanceof CompactGroupText
							? group.renderOwner.callText
							: new CompactGroupText();
			if (this.group_transcript_anchor(group) === record) {
				context.state.callText = callText;
			}
			group.callText = callText;
			set_compact_call_text(group, callText, formatGroup(group, theme));
			if (this.should_schedule_group_shrink_invalidation(group)) {
				this.scheduleGroupInvalidation(group);
			}
			this.syncGroupTick(group);
			if (this.group_transcript_anchor(group) !== record) return new Text("", 0, 0);
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
			set_compact_call_text(
				record,
				callText as CompactGroupText,
				formatStandaloneCallRow(record, theme),
			);
		}
		if (name === "apply_patch") {
			this.syncApplyPatchTick(record);
			this.scheduleRecordShrinkSnap(record);
		} else if (name === "edit" || name === "write" || name === "bash") {
			// Standalone edit/write/bash completed — drop the gradient tick and snap
			// to the muted past-tense label.
			this.unsubscribeStandaloneTick();
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

export { bashGrepInfo } from "./bash-grep.ts";
export { DISCOVERY_TOOLS, GROUPABLE_TOOLS };
export const __test_only = { set_compact_call_text };
