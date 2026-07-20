import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { parseJsonWithRepair } from "@earendil-works/pi-ai/compat";
import * as Diff from "diff";
import {
	MUTED_GROUP_GRADIENT_PRESET,
	renderLiveGradient,
	requestTuiRenderSnapToBottom,
	subscribeGradientTick,
	unsubscribeGradientTick,
} from "../pi-ember-ui/index.ts";
import { isThinkingBlocksHidden } from "../pi-ember-ui/mode-colors.ts";

const BULLET = "• ";

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
const DISCOVERY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const GROUPABLE_TOOLS = new Set([...DISCOVERY_TOOLS, "edit", "write", "bash"]);

export type ToolRenderContext = {
	args: any;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, any>;
	expanded?: boolean;
};

export type ToolRenderResultOptions = {
	isPartial: boolean;
	expanded?: boolean;
};

export type CompactCall = {
	id: string;
	name: string;
	args: any;
	group?: DiscoveryGroup;
	invalidate?: () => void;
	isError: boolean;
	_completed?: boolean;
	result?: any;
	/** Standalone (non-group-owner) call row visual — repainted on theme change. */
	callText?: CompactGroupText;
};

export type DiscoveryGroup = {
	records: CompactCall[];
	/** Group type and its matching present/past-tense label pair. */
	type?: "discovery" | "editing" | "writing" | "bashing";
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
	 * in a different group). The label only flips to past tense when both
	 * all members are complete AND the group is settled.
	 * While complete-but-unsettled, the group stays active (gradient + present
	 * tense) so there is no premature past-tense label.
	 */
	settled?: boolean;
	/**
	 * Shared visual handle for the group block. The owner re-binds this
	 * to its live `Text` on every `renderCall`; members write into it
	 * directly via `setText` in `renderResultInner` so the group stays
	 * visible across Pi rebuilds (thinking-toggle, compaction, settings)
	 * without relying on owner invalidation.
	 */
	callText?: CompactGroupText;
};

/**
 * Compact call rows must never wrap: wrapping long bash commands or file
 * paths produces visually noisy multi-row blocks. The TUI supplies the
 * authoritative available width on every render, so truncate each
 * independently styled line at that boundary. Used for both group rows
 * and standalone (non-group) call rows.
 */
export class CompactGroupText implements Component {
	text = "";

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		return this.text.split("\n").map((line) => truncateToWidth(line, availableWidth));
	}
}

function textValue(value: unknown, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	return String(value).replace(/[\r\n]+/g, " ");
}

function toolPath(args: any): string {
	return textValue(args?.file_path ?? args?.path, ".");
}

function normalizedTargetPath(args: any): string {
	const target = toolPath(args).replace(/\\/g, "/").replace(/\/+$/, "");
	return target || ".";
}

function targetPathForRecord(record: CompactCall): string {
	if (record.name === "bash") {
		return bashGrepInfo(textValue(record.args?.command))?.path ?? normalizedTargetPath(record.args);
	}
	return normalizedTargetPath(record.args);
}

function readRangeLabel(args: any): string {
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

function groupKey(name: string, args: any): string | undefined {
	if (DISCOVERY_TOOLS.has(name)) return "__discovery__";
	if (name === "edit") return "__editing__";
	if (name === "write") return "__writing__";
	if (name === "bash") {
		const command = textValue(args?.command);
		if (bashGrepInfo(command)) return "__discovery__";
		return "__bashing__";
	}
	return undefined;
}

function errorText(result: any, isError: boolean): string | undefined {
	const content = result?.content?.find((item: any) => item.type === "text");
	if (!isError && !content?.text?.startsWith("Error")) return undefined;
	const text = typeof content?.text === "string" ? content.text : "Tool failed";
	return text.replace(/\r\n?/g, "\n").split("\n")[0] || "Tool failed";
}

function compactErrorComponent(error: string, theme: any): Component {
	const component = new CompactGroupText();
	component.setText(theme.fg("error", error));
	return component;
}

function fullOutputText(result: any): string {
	const content = result?.content?.find((item: any) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return "";
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatExpandedOutput(result: any, theme: any): string {
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

function bashLastLine(result: any): string | undefined {
	const content = result?.content?.find((item: any) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return undefined;
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length > 0) return line;
	}
	return undefined;
}

function formatBashResultLine(result: any, theme: any, isError = false): string {
	if (isError) return "";
	const lastLine = bashLastLine(result);
	if (lastLine === undefined) return "";
	return "\n" + theme.fg("dim", "  ") + theme.fg("text", lastLine);
}

function diffStats(result: any): { additions: number; removals: number } {
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
function extractStreamingEdits(args: any): Array<{ oldText: string; newText: string }> | undefined {
	if (args == null) return undefined;
	if (Array.isArray(args.edits)) return args.edits;
	if (typeof args.edits === "string") {
		const trimmed = args.edits.trim();
		if (!trimmed) return undefined;
		try {
			const parsed = parseJsonWithRepair<any>(trimmed);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// Partial / unparseable string: fall through.
		}
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
function streamingEditStats(args: any): { additions: number; removals: number } | undefined {
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
function streamingWriteStats(args: any): { additions: number; removals: number } | undefined {
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

function matchCount(result: any): number | undefined {
	const total = result?.details?.totalMatched;
	if (typeof total === "number") return total;
	return undefined;
}

function matchLabel(result: any, theme: any): string {
	const total = matchCount(result);
	if (total === undefined) return "";
	const label = total === 1 ? "1 match" : `${total} matches`;
	// Match counts stay muted/normal — never the live mode accent.
	return theme.fg("dim", "  ") + theme.fg("muted", label);
}

export const PULSE_INTERVAL_MS = 600;

/**
 * Canonical status-bullet color: error→red, completed→green, else a
 * flashing muted/dim bullet driven by PULSE_INTERVAL_MS. Shared by the
 * compact and subagent renderers; only subagent rows own a pulse timer.
 */
export function statusBulletColor(isError: boolean, isCompleted: boolean, theme: any): string {
	if (isError) return theme.fg("error", BULLET);
	if (isCompleted) return theme.fg("success", BULLET);
	const pulse = Math.floor(Date.now() / PULSE_INTERVAL_MS) % 2 === 0;
	return pulse ? theme.fg("muted", BULLET) : theme.fg("dim", BULLET);
}

/**
 * Canonical group-bullet color: any error→red, all completed→green,
 * else flashing. Derived from statusBulletColor's pulse logic.
 */
export function groupBulletColorFromFlags(
	hasError: boolean,
	allCompleted: boolean,
	theme: any,
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

function bulletColor(record: CompactCall, theme: any): string {
	return statusBulletColor(record.isError, record._completed === true, theme);
}

function formatStandaloneCallRow(record: CompactCall, theme: any): string {
	const { name, args, result } = record;
	const prefix = bulletColor(record, theme) + formatCallBody(name, args, theme);
	// Live edit/write stats: while the model streams args (before the tool
	// runs), show a running +N -N count that updates on each token. Once the
	// edit completes, the authoritative diff stats take over; write has no
	// diff, so it keeps the args-based content line count as final.
	if ((name === "edit" || name === "write") && !record._completed) {
		const live = name === "edit" ? streamingEditStats(args) : streamingWriteStats(args);
		if (live) {
			return prefix + theme.fg("dim", "  ") + formatEditStatsFromCounts(live, theme);
		}
		return prefix;
	}
	if (!record._completed || result === undefined) return prefix;
	if (name === "edit") {
		return prefix + theme.fg("dim", "  ") + formatEditStats(result, theme);
	}
	if (name === "write") {
		const final = streamingWriteStats(args);
		if (final) return prefix + theme.fg("dim", "  ") + formatEditStatsFromCounts(final, theme);
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

function formatEditStats(result: any, theme: any): string {
	const { additions, removals } = diffStats(result);
	return formatEditStatsFromCounts({ additions, removals }, theme);
}

function formatEditStatsFromCounts(counts: { additions: number; removals: number }, theme: any): string {
	// Avoid noisy +0 -0 placeholders when there is nothing to diff.
	if (counts.additions === 0 && counts.removals === 0) return "";
	return (
		theme.fg("success", `+${counts.additions}`) +
		theme.fg("dim", " ") +
		theme.fg("error", `-${counts.removals}`)
	);
}

export function formatCallBody(name: string, args: any, theme: any, inGroup = false): string {
	const pathName = toolPath(args);
	switch (name) {
		case "read":
			return (
				theme.fg("dim", theme.bold("Read")) + theme.fg("dim", ` ${pathName}${readRangeLabel(args)}`)
			);
		case "grep":
			return (
				theme.fg("dim", theme.bold("Search")) +
				theme.fg("dim", ` ${textValue(args?.pattern)}`) +
				theme.fg("dim", ` in ${pathName}`)
			);
		case "find":
			return (
				theme.fg("dim", theme.bold("Find")) +
				theme.fg("dim", ` ${textValue(args?.pattern)}`) +
				theme.fg("dim", ` in ${pathName}`)
			);
		case "ls":
			return theme.fg("dim", theme.bold("List")) + theme.fg("dim", ` ${pathName}`);
		case "bash": {
			const cmd = textValue(args?.command);
			const grepInfo = bashGrepInfo(cmd);
			if (grepInfo) {
				return (
					theme.fg("dim", theme.bold("Search")) +
					theme.fg("dim", ` ${grepInfo.pattern}`) +
					theme.fg("dim", ` in ${grepInfo.path}`)
				);
			}
			const stripped = inGroup ? cmd.replace(/^\s*cd\s+[^\s&]+\s*&&\s*/, "") || cmd : cmd;
			if (inGroup) return theme.fg("dim", `$ ${stripped}`);
			return theme.fg("dim", theme.bold("Bash")) + theme.fg("dim", ` $ ${stripped}`);
		}
		case "edit":
			return inGroup
				? theme.fg("dim", pathName)
				: theme.fg("dim", theme.bold("Edit")) + theme.fg("dim", ` ${pathName}`);
		case "write":
			return inGroup
				? theme.fg("dim", pathName)
				: theme.fg("dim", theme.bold("Write")) + theme.fg("dim", ` ${pathName}`);
		default:
			return theme.fg("dim", theme.bold(name));
	}
}

function groupBulletColor(group: DiscoveryGroup, theme: any): string {
	const hasError = group.records.some((r) => r.isError);
	const allCompleted = group.records.every((r) => r._completed);
	return groupBulletColorFromFlags(hasError, allCompleted, theme);
}

function groupHeaderLabel(group: DiscoveryGroup): string {
	const allDone =
		group.records.length > 0 && group.records.every((r) => r._completed) && group.settled === true;
	const labels =
		group.type === "editing"
			? { present: "Editing", past: "Edited", noun: "file" }
			: group.type === "writing"
				? { present: "Writing", past: "Written", noun: "file" }
				: group.type === "bashing"
					? { present: "Bashing", past: "Ran", noun: "command" }
					: { present: "Exploring", past: "Explored", noun: "file" };
	if (!allDone) return labels.present;
	const count =
		group.type === "bashing"
			? group.records.length
			: new Set(group.records.map(targetPathForRecord)).size;
	return `${labels.past} ${count} ${count === 1 ? labels.noun : `${labels.noun}s`}`;
}

function formatGroupCallBody(record: CompactCall, theme: any): string {
	const body = formatCallBody(record.name, record.args, theme, true);
	// Live edit/write stats while streaming, authoritative diff once edit completes.
	// Write has no post-run diff, so its final stats come from args.content line count.
	if (record.name !== "edit" && record.name !== "write") return body;
	if (!record._completed) {
		const live = record.name === "edit" ? streamingEditStats(record.args) : streamingWriteStats(record.args);
		if (live) return body + theme.fg("dim", "  ") + formatEditStatsFromCounts(live, theme);
		return body;
	}
	if (record.name === "edit") {
		return body + theme.fg("dim", "  ") + formatEditStats(record.result, theme);
	}
	const final = streamingWriteStats(record.args);
	if (final) return body + theme.fg("dim", "  ") + formatEditStatsFromCounts(final, theme);
	return body;
}

function formatGroup(group: DiscoveryGroup, theme: any): string {
	const allCompleted =
		group.records.length > 0 && group.records.every((r) => r._completed) && group.settled === true;
	const headerLabel = groupHeaderLabel(group);
	const headerText = allCompleted
		? theme.fg("muted", theme.bold(headerLabel))
		: renderLiveGradient(headerLabel, MUTED_GROUP_GRADIENT_PRESET);
	const lines = [groupBulletColor(group, theme) + headerText];
	// Settled groups collapse to header-only when thinking blocks are hidden
	// (compact mode). The shared isThinkingBlocksHidden() flag in
	// pi-ember-ui/mode-colors.ts is the SSOT, mirrored from Pi's Ctrl+T toggle.
	// Ctrl+T (show thinking) triggers rebuildChatFromMessages(), which re-runs
	// renderCall on every owner and reveals the child rows again. Never
	// duplicate this collapse condition in other plugins.
	const collapse_children = allCompleted && isThinkingBlocksHidden();
	if (!collapse_children) {
		for (const [index, record] of group.records.entries()) {
			const prefix =
				index === group.records.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_PIPE;
			const suffix =
				record._completed && (record.name === "grep" || record.name === "find")
					? matchLabel(record.result, theme)
					: "";
			lines.push(theme.fg("dim", prefix) + formatGroupCallBody(record, theme) + suffix);
		}
	}
	return lines.join("\n");
}

export class CompactRenderer {
	private readonly calls = new Map<string, CompactCall>();
	/** The single live group. Settled groups are dropped so a later
	 *  same-type call starts a fresh group at its own transcript position
	 *  instead of reopening the old one. */
	private currentGroup: DiscoveryGroup | undefined;
	private readonly pendingGroupInvalidations = new Set<DiscoveryGroup>();

	/** Tick callback that re-renders the active group owner so the group
	 *  header gradient sweeps in lockstep with the Thinking
	 *  widget. Subscribed while any group is unsettled (active); removed
	 *  on settle or session reset. The callback identity is stable for
	 *  the subscription lifecycle; the invalidate target is rebound on
	 *  each renderCall so Pi rebuilds (which provide a fresh invalidate
	 *  closure) rebind without churning the subscriber Set. */
	private groupTickCb: (() => void) | undefined;
	private groupTickTarget: (() => void) | undefined;

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

	/** Called by the plugin when the current turn produces visible text
	 *  output (text_start/text_delta). Break the old group immediately so
	 *  an intervening non-group tool cannot update it. */
	noteVisibleText(): void {
		this.settleGroups();
		this.resetGroupingState();
	}

	noteUserMessage(): void {
		this.settleGroups();
		this.resetGroupingState();
	}

	/** Settle the active group and clear it. Called at agent end so completed
	 *  groups flip to past tense once the run finishes. */
	settleAllGroups(): void {
		this.settleGroups();
		this.resetGroupingState();
	}

	/** Clear all accumulated call state. Called on session replacement
	 *  (/resume, /new, /fork) so stale rows from the previous session do
	 *  not leak into the new one. */
	resetForSession(): void {
		this.unsubscribeGroupTick();
		this.calls.clear();
		this.currentGroup = undefined;
		this.pendingGroupInvalidations.clear();
	}

	/** Re-paint compact rows after a live accent/theme rebuild. */
	refreshThemeColors(theme: any): void {
		const groups_refreshed = new Set<DiscoveryGroup>();
		for (const record of this.calls.values()) {
			const group = record.group;
			if (group?.callText && group.records.length > 1 && !groups_refreshed.has(group)) {
				groups_refreshed.add(group);
				group.callText.setText(formatGroup(group, theme));
				continue;
			}
			if (record.callText) {
				record.callText.setText(formatStandaloneCallRow(record, theme));
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
		if (group.records.some((r) => !r._completed)) return true;
		return group.records.every((r) => r._completed) && !group.settled;
	}

	/** Settle a single group so its label flips to past tense. No-op if
	 *  the group is missing, empty, or already settled. */
	private settleGroup(group: DiscoveryGroup | undefined): void {
		if (!group || group.records.length === 0 || group.settled) return;
		group.settled = true;
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

	/** Subscribe the group owner to the thinking tick so the group header
	 *  gradient animates at the same cadence as the Thinking
	 *  widget. The callback identity is stable for the subscription
	 *  lifecycle; only the invalidate target is rebound. This prevents
	 *  Set live-iteration hazards when renderCall provides a fresh
	 *  invalidate closure on Pi rebuilds. */
	private subscribeGroupTick(ownerInvalidate: (() => void) | undefined): void {
		if (!ownerInvalidate) return;
		this.groupTickTarget = ownerInvalidate;
		if (this.groupTickCb) return;
		this.groupTickCb = (): void => {
			this.groupTickTarget?.();
		};
		subscribeGradientTick(this.groupTickCb);
	}

	/** Unsubscribe the group tick callback if one is active. */
	private unsubscribeGroupTick(): void {
		if (!this.groupTickCb) return;
		unsubscribeGradientTick(this.groupTickCb);
		this.groupTickCb = undefined;
		this.groupTickTarget = undefined;
	}

	private resetGroupingState(): void {
		this.currentGroup = undefined;
	}

	private scheduleGroupInvalidation(group: DiscoveryGroup): void {
		if (this.pendingGroupInvalidations.has(group)) return;
		this.pendingGroupInvalidations.add(group);
		// When the group is about to collapse (settled + all completed + thinking
		// hidden), the re-render shrinks the line count. Pi's differential
		// clearOnShrink path then fires a fullRender with a stale
		// previousViewportTop, leaving the chatbox not pinned to the bottom
		// (the "janked up" state). Snap the viewport to the bottom via the
		// scrollback-preserving helper: it clears only the visible screen (`2J`,
		// never `3J`), resets previousViewportTop/maxLinesRendered, and requests
		// a normal render whose first-render path re-anchors the chatbox to the
		// bottom without destroying terminal scrollback. Never use
		// requestTuiRender(true) here — it emits `3J` and nukes scrollback.
		// Only when collapsing — non-collapse invalidations (live gradient
		// tick, mid-run bullet pulse) stay differential.
		const will_collapse =
			group.settled === true &&
			group.records.length > 0 &&
			group.records.every((r) => r._completed) &&
			isThinkingBlocksHidden();
		queueMicrotask(() => {
			if (!this.pendingGroupInvalidations.delete(group)) return;
			group.renderOwner?.invalidate?.();
			if (will_collapse) requestTuiRenderSnapToBottom();
		});
	}

	private appendToGroup(group: DiscoveryGroup, record: CompactCall): void {
		for (const member of group.records) member.group = group;
		group.settled = false;
		group.records.push(record);
		record.group = group;
		this.currentGroup = group;
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
						: "discovery";
		const group: DiscoveryGroup = {
			records: [record],
			renderOwner: record,
			type,
			key,
		};
		this.currentGroup = group;
		return group;
	}

	registerCall(name: string, id: string, args: any, invalidate?: () => void): CompactCall {
		const existing = this.calls.get(id);
		if (existing) {
			existing.args = args;
			if (invalidate) {
				existing.invalidate = invalidate;
			}
			return existing;
		}

		const record: CompactCall = { id, name, args, isError: false };
		this.calls.set(id, record);
		const key = groupKey(name, args);

		if (key === undefined) {
			this.settleGroups();
		} else if (this.currentGroup && !this.currentGroup.settled && this.currentGroup.key === key) {
			this.appendToGroup(this.currentGroup, record);
		} else {
			this.settleGroups();
			this.startGroup(key, record);
		}
		record.invalidate = invalidate;
		return record;
	}

	setResult(record: CompactCall, result: any, isError: boolean): void {
		if (record._completed && record.result === result && record.isError === isError) return;
		record.isError = isError;
		record._completed = true;
		record.result = result;
		// Do NOT invalidate the owner here. The group visual is updated
		// directly via group.callText.setText() in renderResultInner so the
		// owner's next render picks up the change. Invalidating the owner
		// synchronously triggers updateDisplay -> renderResult -> setResult,
		// which races during Pi rebuilds (thinking-toggle, compaction) when
		// the owner component has been destroyed and recreated.
	}

	renderCall(name: string, args: any, theme: any, context: ToolRenderContext): Component {
		try {
			return this.renderCallInner(name, args, theme, context);
		} catch {
			// Never throw: Pi's fallback would dump raw content. Return a
			// compact call row instead. Use CompactGroupText (truncating) so
			// even the fallback never wraps to multiple rows.
			const fallback = new CompactGroupText();
			fallback.setText(theme.fg("muted", BULLET) + formatCallBody(name, args, theme));
			return fallback;
		}
	}

	private renderCallInner(
		name: string,
		args: any,
		theme: any,
		context: ToolRenderContext,
	): Component {
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
			callText.setText(formatGroup(record.group, theme));
			// While the group is not settled (agent hasn't moved on), subscribe
			// the owner's invalidate to the thinking tick so the gradient
			// header sweeps in lockstep with the Thinking widget.
			if (!record.group.settled) {
				this.subscribeGroupTick(record.invalidate);
			} else {
				this.unsubscribeGroupTick();
			}
			return callText;
		}
		const callText =
			context.state.callText instanceof CompactGroupText
				? context.state.callText
				: new CompactGroupText();
		context.state.callText = callText;
		record.callText = callText;
		callText.setText(formatStandaloneCallRow(record, theme));
		return callText;
	}

	renderResult(
		name: string,
		args: any,
		result: any,
		options: ToolRenderResultOptions,
		theme: any,
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
		args: any,
		result: any,
		options: ToolRenderResultOptions,
		theme: any,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		this.setResult(record, result, context.isError);
		const expanded = options.expanded === true;

		if (record.group && record.group.records.length > 1) {
			// Update the shared group visual directly so the owner's row
			// reflects this member's completion (bullet color, match count,
			// final label) without invalidating the owner. Pi's next requestRender
			// renders the owner's selfRenderContainer with the updated component.
			record.group.callText?.setText(formatGroup(record.group, theme));
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
			if (error && !group_collapsed) return compactErrorComponent(error, theme);
			if (expanded && !options.isPartial && !group_collapsed) {
				const output = formatExpandedOutput(result, theme);
				if (output) return new Text(output, 0, 0);
			}
			return new Text("", 0, 0);
		}
		if (options.isPartial) return new Text("", 0, 0);

		const error = errorText(result, context.isError);
		const callText = context.state.callText;
		if (callText instanceof CompactGroupText) {
			record.callText = callText;
			callText.setText(formatStandaloneCallRow(record, theme));
		}
		if (error) return compactErrorComponent(error, theme);
		if (expanded) {
			const output = formatExpandedOutput(result, theme);
			if (output) return new Text(output, 0, 0);
		}
		return new Text("", 0, 0);
	}
}

export { BULLET, DISCOVERY_TOOLS, GROUPABLE_TOOLS, bashGrepInfo };
