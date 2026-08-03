/**
 * TUI rendering for pi-subagent.
 *
 * Renders sub-agent results in collapsed and expanded views.
 * Collapsed: status icon, agent name, last few items, usage stats.
 * Expanded (Ctrl+O): full task text, all tool calls, final markdown output.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	BULLET,
	formatCompactChildRow,
	formatGroupChildRows,
	formatUnifiedWorkHeader,
	groupBulletColorFromFlags,
	GROUP_CHILD_LAST,
	GROUP_CHILD_TEE,
	merge_group_child_rows,
	statusBulletColor,
	TREE_BRANCH_LAST,
	TREE_BRANCH_PIPE,
	WORK_GROUP_KEY,
	type CompactCall,
	type DiscoveryGroup,
} from "../../../pi-compact-tools/renderer.ts";
import {
	chatboxBorderColor,
	formatElapsed,
	renderLiveGradient,
} from "../../../pi-ember-ui/index.ts";
import { format_in_group_thinking_row } from "../../../pi-ember-ui/thinking-status-render.ts";
import {
	getResultOutput,
	isFailedResult,
	resolve_failure_message,
	SUBAGENT_LIVE_OUTPUT_MAX_ROWS,
	type SubAgentResult,
	type SubagentLiveItem,
	type SubagentLiveToolRow,
} from "./runner.ts";
import { isSingleModeSubagentArgs, type SubagentArgs } from "./subagent-group.ts";
import { format_subagent_thinking_elapsed_suffix } from "./subagent-timing.ts";

export type { SubagentArgs };

interface ThemeLike {
	fg(tag: string, text: string): string;
	bold(text: string): string;
}

/**
 * Width-aware truncating text for the latest-tool-call row under a running
 * subagent. Unlike pi-tui's `Text` (which wraps long lines), this truncates
 * to half the viewport width with an ellipsis so a long bash command never
 * spans more than one terminal row. Half-width keeps the nested preview
 * visually compact under the agent name without sprawling across the TUI.
 */
const TOOL_ROW_WIDTH_FRACTION = 0.5;

/**
 * Per-subagent gradient phase offset in ms, multiplied by the agent's
 * index. Staggers the gradient sweep of parallel/chain subagents so
 * their running labels don't animate in perfect sync. 64 ms per index
 * gives 2x the divergence of the previous 32 ms step, making the
 * stagger clearly visible across simultaneous agents.
 */
const SUBAGENT_PHASE_OFFSET_MS = 64;

export class SubagentToolText implements Component {
	text = "";

	constructor(text = "") {
		this.text = text;
	}

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const maxToolWidth = Math.max(1, Math.floor(width * TOOL_ROW_WIDTH_FRACTION));
		return [truncateToWidth(this.text, maxToolWidth)];
	}
}

/**
 * Full-width dim horizontal separator between consecutive subagent blocks.
 * Reuses the SSOT `chatboxBorderColor` (DIM_COLOR token) — same rule as the
 * Ember bash/chatbox borders. The edge is a connected tee `├` so the rule
 * visually hooks into the agent tree on the left, then continues as `──` to
 * the right edge. Renders a single row at the supplied width (tee + dashes).
 */
export class DimSeparator implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		const rule_width = Math.max(1, width);
		const dashes = Math.max(0, rule_width - 1);
		return [chatboxBorderColor("\u251c" + "\u2500".repeat(dashes))];
	}
}

/** Cap on visible text lines per live agent text block (before truncation). */
const LIVE_TEXT_MAX_LINES = 6;

type LiveSegment =
	| { kind: "text"; text: string }
	| { kind: "work"; rows: SubagentLiveToolRow[] };

/**
 * Split the chronological live buffer into alternating text blocks and work
 * bursts. Visible assistant text is a hard transcript boundary — it closes the
 * current work burst (its children fold into the header summary) exactly like
 * the main agent's `noteVisibleText()` hard exit. Consecutive tool calls stay
 * in one burst.
 */
function buildLiveSegments(items: SubagentLiveItem[]): LiveSegment[] {
	const segments: LiveSegment[] = [];
	let burst: SubagentLiveToolRow[] | null = null;
	for (const item of items) {
		if (item.kind === "text") {
			burst = null;
			if (item.text.length > 0) segments.push({ kind: "text", text: item.text });
		} else {
			if (burst === null) {
				burst = [];
				segments.push({ kind: "work", rows: burst });
			}
			burst.push(item.row);
		}
	}
	return segments;
}

/**
 * Visible child wave inside a work burst: same-name calls append without
 * folding; a different tool name folds the prior wave once every prior member
 * has completed (the compact renderer's "genuinely new tool wave" rule), so
 * stale `Reading`/`Searching` rows never linger past the next tool family.
 */
function currentWaveRows(rows: SubagentLiveToolRow[]): SubagentLiveToolRow[] {
	let visibleStart = 0;
	for (let i = 1; i < rows.length; i++) {
		const prior_complete = rows.slice(visibleStart, i).every((r) => r.completed);
		if (prior_complete && rows[i].name !== rows[i - 1].name) {
			visibleStart = i;
		}
	}
	return rows.slice(visibleStart);
}

/** Pseudo CompactCall view over a live tool row for the SSOT formatters. */
function liveRowToCall(row: SubagentLiveToolRow, index: number): CompactCall {
	return {
		id: row.toolCallId ?? `live-${index}`,
		name: row.name,
		args: row.args,
		isError: row.error,
		_completed: row.completed,
		result: row.details ? { details: row.details } : undefined,
	} as CompactCall;
}

/**
 * Unified work-bundle header for a burst — the exact `• Edited N files, …
 * +N -N` line the main agent renders (`formatUnifiedWorkHeader` SSOT), with
 * the shared group bullet. Completed work summarizes into the past-tense
 * segments; while everything is still running the present-tense label
 * (Exploring/Editing/…) is used, matching the main compact group header.
 */
function renderLiveWorkHeader(rows: SubagentLiveToolRow[], theme: ThemeLike): string {
	const calls = rows.map(liveRowToCall);
	const group = {
		records: calls,
		key: WORK_GROUP_KEY,
		type: "work",
		childAbsorbBefore: 0,
	} as DiscoveryGroup;
	const hasError = rows.some((r) => r.error);
	const allCompleted = rows.length > 0 && rows.every((r) => r.completed);
	const bullet = groupBulletColorFromFlags(hasError, allCompleted, theme);
	return bullet + formatUnifiedWorkHeader(group, theme);
}

/**
 * Current-wave child rows (merged same-file calls, accumulated +N -N) with
 * the compact group branch prefixes — the same row shape as main-agent
 * groups. Running members animate with the shared gradient verbs.
 */
function renderLiveWorkChildren(rows: SubagentLiveToolRow[], theme: ThemeLike): string[] {
	const calls = currentWaveRows(rows).map(liveRowToCall);
	const merged = merge_group_child_rows(calls);
	const bodies = merged.map((records) => formatGroupChildRows(records, theme));
	return bodies.map((body, index) => {
		const branch = index === bodies.length - 1 ? GROUP_CHILD_LAST : GROUP_CHILD_TEE;
		return theme.fg("dim", branch) + body;
	});
}

/**
 * Multi-line live output tray for a running subagent (thinking blocks
 * visible). Renders the child session's chronological `liveItems` as a
 * compact work-bundle mirroring the main agent's `pi-compact-tools` groups:
 * one `•` header per burst (past-tense summary while any member completed,
 * present-tense while everything is running), current-wave children as
 * bullet-less compact rows with gradient verbs, streamed assistant text
 * blocks as plain lines, and an in-group `└ Thinking` lane while the child
 * reasons after a tool wave. Prior waves fold into the header summary on a
 * genuinely new tool family or visible text — stale Reading/Searching rows
 * never stay open. Reuses the SSOT formatters; no duplicate tool-row logic.
 */
export class SubagentLiveOutputText implements Component {
	items: SubagentLiveItem[] = [];
	treePrefix = "";
	running = true;
	isThinking = false;
	theme: ThemeLike | undefined;
	toolCallId?: string;

	constructor(
		items: SubagentLiveItem[] = [],
		treePrefix = "",
		running = true,
		theme?: ThemeLike,
		isThinking = false,
		toolCallId?: string,
	) {
		this.items = items;
		this.treePrefix = treePrefix;
		this.running = running;
		this.theme = theme;
		this.isThinking = isThinking;
		this.toolCallId = toolCallId;
	}

	setItems(items: SubagentLiveItem[]): void {
		this.items = items;
	}

	setRunning(running: boolean): void {
		this.running = running;
	}

	setIsThinking(isThinking: boolean): void {
		this.isThinking = isThinking;
	}

	setTreePrefix(treePrefix: string): void {
		this.treePrefix = treePrefix;
	}

	setTheme(theme: ThemeLike): void {
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		const fg = theme.fg.bind(theme);
		const segments = buildLiveSegments(this.items);
		if (segments.length === 0) return [];

		const segmentLines: string[][] = segments.map((seg) => {
			if (seg.kind === "text") {
				const lines: string[] = [];
				const textLines = seg.text.split("\n");
				const shown = textLines.slice(0, LIVE_TEXT_MAX_LINES);
				for (const line of shown) {
					lines.push(fg("text", line.length > 0 ? line : " "));
				}
				if (textLines.length > LIVE_TEXT_MAX_LINES) {
					lines.push(fg("dim", "…"));
				}
				return lines;
			}
			const lines = [renderLiveWorkHeader(seg.rows, theme)];
			if (seg === segments[segments.length - 1]) {
				lines.push(...renderLiveWorkChildren(seg.rows, theme));
			}
			return lines;
		});

		// In-group `└ Thinking` lane while the child reasons after its latest
		// tool wave — the same slot the main agent's compact groups paint.
		if (this.isThinking) {
			const last = segments[segments.length - 1];
			if (last.kind === "work" && last.rows.length > 0) {
				const elapsed = format_subagent_thinking_elapsed_suffix(theme, this.toolCallId);
				segmentLines[segmentLines.length - 1].push(
					fg("dim", GROUP_CHILD_LAST) + format_in_group_thinking_row(elapsed),
				);
			}
		}

		// One blank spacer row between segments (tool bursts and agent text
		// blocks), matching the main transcript's block spacing.
		const spacer_count = Math.max(0, segmentLines.length - 1);

		// Budget: drop the oldest whole segments until the tray fits
		// SUBAGENT_LIVE_OUTPUT_MAX_ROWS lines; never the newest burst.
		let start = 0;
		let total = segmentLines.reduce((sum, lines) => sum + lines.length, 0) + spacer_count;
		while (start < segmentLines.length - 1 && total > SUBAGENT_LIVE_OUTPUT_MAX_ROWS) {
			total -= segmentLines[start].length + 1;
			start++;
		}
		const lines: string[] = [];
		for (let i = start; i < segmentLines.length; i++) {
			if (i > start) lines.push("");
			lines.push(...segmentLines[i]);
		}
		if (lines.length > SUBAGENT_LIVE_OUTPUT_MAX_ROWS) {
			const header = lines[0];
			const tail = lines.slice(lines.length - (SUBAGENT_LIVE_OUTPUT_MAX_ROWS - 1));
			lines.length = 0;
			lines.push(header, ...tail);
		}

		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const body = lines[i];
			// Spacer rows are fully blank — no branch glyph, like the blank
			// lines Pi paints between transcript blocks.
			if (body.length === 0) {
				out.push("");
				continue;
			}
			const outerBranch = i === lines.length - 1 ? TREE_BRANCH_LAST : TREE_BRANCH_PIPE;
			const prefix = this.treePrefix + fg("dim", outerBranch);
			const prefixWidth = visibleWidth(prefix);
			const contentWidth = Math.max(1, width - prefixWidth);
			out.push(prefix + truncateToWidth(body, contentWidth));
		}
		if (!this.running && out.length > 0) {
			out.push(chatboxBorderColor("\u2500".repeat(width)));
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// Safe type guards
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = "..."): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: string, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = asString(args.command);
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = asString(args.file_path ?? args.path);
			const filePath = shortenPath(rawPath);
			const offset = asNumber(args.offset);
			const limit = asNumber(args.limit);
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = asString(args.file_path ?? args.path);
			const content = asString(args.content, "");
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = asString(args.file_path ?? args.path);
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = asString(args.path, ".");
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = asString(args.pattern, "*");
			const rawPath = asString(args.path, ".");
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = asString(args.pattern);
			const rawPath = asString(args.path, ".");
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({
						type: "toolCall",
						name: part.name,
						args: asRecord(part.arguments),
					});
				}
			}
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// Collapsed renderer
// ---------------------------------------------------------------------------

const COLLAPSED_ITEM_COUNT = 10;

function renderDisplayItems(
	items: DisplayItem[],
	theme: { fg: (c: string, t: string) => string },
	limit?: number,
): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

// ---------------------------------------------------------------------------
// Single agent result
// ---------------------------------------------------------------------------

export function renderSingleResult(
	result: SubAgentResult,
	expanded: boolean,
	theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
): Container | Text {
	const isError = isFailedResult(result);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getResultOutput(result);
	const failureMessage = isError ? resolve_failure_message(result) : undefined;

	if (expanded) {
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		let header = `${icon} ${theme.fg("dim", theme.bold(result.agent))}`;
		if (isError && result.stopReason) {
			const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
			header += ` ${theme.fg(reasonColor, `[${result.stopReason}]`)}`;
		}
		container.addChild(new Text(header, 0, 0));
		if (failureMessage) {
			const messageColor = result.stopReason === "timeout" ? "warning" : "error";
			container.addChild(new Text(theme.fg(messageColor, `Error: ${failureMessage}`), 0, 0));
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(result.usage, result.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	// Collapsed
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}`;
	if (isError && result.stopReason) {
		const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
		text += ` ${theme.fg(reasonColor, `[${result.stopReason}]`)}`;
	}
	if (failureMessage) {
		const messageColor = result.stopReason === "timeout" ? "warning" : "error";
		text += `\n${theme.fg(messageColor, `Error: ${failureMessage}`)}`;
	} else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
	else {
		text += `\n${renderDisplayItems(displayItems, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
	}
	const usageStr = formatUsageStats(result.usage, result.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

export function aggregateUsage(results: SubAgentResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Compact grouped layout (Exploring-style)
// ---------------------------------------------------------------------------

/**
 * Per-agent status derived from a SubAgentResult.
 * `exitCode === -1` means still running (no result yet).
 */
type AgentStatus = "running" | "completed" | "failed";

function agentStatus(result: SubAgentResult | undefined, terminal = false): AgentStatus {
	if (!result) return terminal ? "failed" : "running";
	if (result.exitCode === -1) return terminal ? "failed" : "running";
	return isFailedResult(result) ? "failed" : "completed";
}

function agentStatusSuffix(status: AgentStatus, theme: ThemeLike): string {
	if (status === "failed") return theme.fg("error", " ✗");
	if (status === "completed") return theme.fg("success", " ✓");
	return "";
}

function renderAgentLabel(
	status: AgentStatus,
	agentName: string,
	theme: ThemeLike,
	result?: SubAgentResult,
	failureMessage?: string,
	_phaseOffsetMs: number = 0,
	isSingle = false,
	elapsedMs?: number,
): string {
	const elapsedSuffix = isSingle ? formatSubagentElapsedSuffix(theme, elapsedMs) : "";
	const prefix = isSingle
		? status === "running"
			? statusBulletColor(false, false, theme)
			: theme.fg("muted", BULLET)
		: "";
	if (status === "running") {
		return prefix + theme.fg("text", agentName) + elapsedSuffix;
	}
	let suffix = "";
	if (status === "failed") {
		const output = (
			failureMessage ?? (result ? resolve_failure_message(result) : undefined)
		)?.trim();
		if (output) {
			const singleLine = output.replace(/\s+/g, " ");
			const clipped = singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
			suffix = ` ${theme.fg("error", clipped)}`;
		}
	}
	return (
		prefix + theme.fg("dim", agentName) + suffix + agentStatusSuffix(status, theme) + elapsedSuffix
	);
}

/**
 * Render a single agent row as a plain string (no background). Terminal
 * rows are wrapped in a plain Text (no background) by `buildSubagentLayout`;
 * running rows and the group header stay transparent.
 */
function renderAgentRow(
	status: AgentStatus,
	agentName: string,
	theme: ThemeLike,
	result?: SubAgentResult,
	prefix = "",
	failureMessage?: string,
	phaseOffsetMs: number = 0,
	isSingle = false,
	elapsedMs?: number,
): string {
	return (
		prefix +
		renderAgentLabel(
			status,
			agentName,
			theme,
			result,
			failureMessage,
			phaseOffsetMs,
			isSingle,
			elapsedMs,
		)
	);
}

type FlatEntry =
	| { type: "agent"; descriptor: AgentRowDescriptor; agentIndex: number }
	| { type: "tool"; descriptor: AgentRowDescriptor; parentAgentIndex: number }
	| { type: "thinking"; descriptor: AgentRowDescriptor; parentAgentIndex: number }
	| { type: "liveOutput"; descriptor: AgentRowDescriptor; parentAgentIndex: number };

function buildFlatEntries(rows: AgentRowDescriptor[], thinkingBlocksVisible: boolean): FlatEntry[] {
	const entries: FlatEntry[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		entries.push({ type: "agent", descriptor: row, agentIndex: i });
		const has_live_output =
			row.status === "running" &&
			thinkingBlocksVisible &&
			Array.isArray(row.result?.liveItems) &&
			(row.result?.liveItems?.length ?? 0) > 0;
		// When the live output tray is active, the compact work-bundle rows
		// (header + folded child waves + agent text) replace the single
		// latest-tool/thinking preview row — no duplicate
		// `└ Searching` line above the tray.
		if (!has_live_output) {
			if (row.status === "running" && row.result?.latestToolCall) {
				entries.push({ type: "tool", descriptor: row, parentAgentIndex: i });
			} else if (
				row.status === "running" &&
				row.result?.isThinking &&
				row.result.reasoning !== false
			) {
				entries.push({ type: "thinking", descriptor: row, parentAgentIndex: i });
			}
		}
		if (has_live_output) {
			entries.push({ type: "liveOutput", descriptor: row, parentAgentIndex: i });
		}
	}
	return entries;
}

/**
 * Indent for grouped subagent tree branches: one bullet+space wide (`• ` =
 * 2 cells) so the `├`/`└` pipe starts below the first header letter (`D` of
 * `Delegating`, `S` of `Subagents`), not below the bullet point. Mirrors the
 * todo plugin's `TODO_TREE_INDENT` so grouped trees align across the package.
 */
const SUBAGENT_TREE_INDENT = "  ";

/** Agent rows close with └ on the last agent; earlier agents use ├. Branch
 *  glyphs are flush with the agent name (compact group child style): the
 *  pipe sits under the header's first letter and the name starts one column
 *  to its right. */
function agentTreePrefix(agentIndex: number, agentCount: number): string {
	return agentIndex < agentCount - 1 ? GROUP_CHILD_TEE : GROUP_CHILD_LAST;
}

/** Outer tree prefix for the live output tray under an agent (spaces or the
 *  group tree pipe). Keeps a trailing space so the tray's own `│ `/`└ `
 *  branch reads with a gap under the tree (e.g. `│ │`). */
export function outerPrefixForAgent(
	agentIndex: number,
	agentCount: number,
	hasHeader: boolean,
): string {
	if (!hasHeader) return "  ";
	return SUBAGENT_TREE_INDENT + (agentIndex < agentCount - 1 ? TREE_BRANCH_PIPE : "  ");
}

/** Full tree prefix for a child item (tool, thinking, liveOutput) under an
 *  agent. Flush like the agent rows: the nested └ sits on the agent-name
 *  column (one column right of the tree pipe). Single-mode rows (no header)
 *  keep the `  └ ` spacing so the └ hangs below the bare agent name. */
export function childTreePrefix(
	agentIndex: number,
	agentCount: number,
	hasHeader: boolean,
	isLastChild = true,
): string {
	if (!hasHeader) {
		return "  " + (isLastChild ? TREE_BRANCH_LAST : TREE_BRANCH_PIPE);
	}
	const outer = SUBAGENT_TREE_INDENT + (agentIndex < agentCount - 1 ? "│" : " ");
	const inner = isLastChild ? "└" : "│";
	return outer + inner;
}

function treePrefixForEntry(entry: FlatEntry, hasHeader: boolean, agentCount: number): string {
	if (entry.type === "agent") {
		return hasHeader ? agentTreePrefix(entry.agentIndex, agentCount) : "";
	}
	return childTreePrefix(entry.parentAgentIndex, agentCount, hasHeader, true);
}

/** Nested Thinking row while a running subagent waits between tool calls. */
export function renderSubagentThinkingRow(
	theme: ThemeLike,
	treePrefix: string,
	toolCallId?: string,
): string {
	const fg = theme.fg.bind(theme);
	const elapsed = format_subagent_thinking_elapsed_suffix(theme, toolCallId);
	return fg("dim", treePrefix) + format_in_group_thinking_row(elapsed);
}

function renderSubagentChildRow(
	entry: FlatEntry,
	row: AgentRowDescriptor,
	theme: ThemeLike,
	treePrefix: string,
): string | undefined {
	if (entry.type === "thinking") {
		return renderSubagentThinkingRow(theme, treePrefix, row.toolCallId);
	}
	if (entry.type === "tool") {
		return renderLatestToolRow(row, theme, treePrefix);
	}
	return undefined;
}

function renderLatestToolRow(
	row: AgentRowDescriptor,
	theme: ThemeLike,
	treePrefix: string,
): string | undefined {
	if (!row.result?.latestToolCall) return undefined;
	const { name, args } = row.result.latestToolCall;
	const completed = row.status !== "running";
	const fg = theme.fg.bind(theme);
	// DRY with the compact group child row formatter: running agents get the
	// gradient verb, completed/failed agents get the muted past-tense form.
	const body = formatCompactChildRow(name, args, completed, undefined, theme);
	return `${fg("dim", treePrefix)}${body}`;
}

const DELEGATING_LABEL = "Delegating";

/** Same 1 s threshold as the Thinking status row. */
const SUBAGENT_ELAPSED_MIN_MS = 1000;

/** Dim elapsed suffix for subagent labels — SSOT with Thinking. */
export function formatSubagentElapsedSuffix(
	theme: ThemeLike,
	elapsedMs: number | undefined,
): string {
	if (elapsedMs === undefined || elapsedMs < SUBAGENT_ELAPSED_MIN_MS) return "";
	return theme.fg("dim", ` ${formatElapsed(elapsedMs)}`);
}

/** Parent tool is running but child session placeholders are not published yet. */
export function isSubagentDelegating(results: SubAgentResult[]): boolean {
	return results.length === 0;
}

/** Whether to paint the gradient Delegating row (never after the tool has settled). */
export function shouldShowSubagentDelegating(
	results: SubAgentResult[],
	terminal: boolean,
): boolean {
	if (terminal) return false;
	return isSubagentDelegating(results);
}

/** Compact single-row state while the parent invokes the subagent tool. */
export function renderDelegatingRow(theme: ThemeLike): string {
	const bullet = groupBulletColorFromFlags(false, false, theme);
	const label = renderLiveGradient(DELEGATING_LABEL, "subagent");
	return bullet + label;
}

function renderGroupLabel(
	label: string,
	_hasError: boolean,
	_allDone: boolean,
	theme: ThemeLike,
	elapsedMs?: number,
): string {
	// Header is plain dim/bold with the same bullet spacing as a compact
	// group header (e.g. "• Exploring") so the group columns align.
	return (
		theme.fg("dim", BULLET) +
		theme.fg("dim", theme.bold(label)) +
		formatSubagentElapsedSuffix(theme, elapsedMs)
	);
}

// ---------------------------------------------------------------------------
// Compact layout — pure string (tests) + component builder (production)
// ---------------------------------------------------------------------------

/**
 * Per-agent row descriptor for the compact layout. Derived once from
 * args + results; consumed by both the string renderer (tests) and the
 * component builder (production). Single source of truth for status
 * and layout — no duplicate derivation logic.
 */
interface AgentRowDescriptor {
	status: AgentStatus;
	name: string;
	result?: SubAgentResult;
	failureMessage?: string;
	isSingle: boolean;
	toolCallId?: string;
	/** Member is still delegating (args brace open / no results yet). */
	delegating?: boolean;
}

export interface SubagentLayoutMember {
	args: SubagentArgs;
	results: SubAgentResult[];
	failureMessage?: string;
	displayName?: string;
	/** Tool execution finished — stop Delegating gradient + live elapsed timer. */
	terminal?: boolean;
	toolCallId?: string;
}

function resolve_member_display_name(member: SubagentLayoutMember): string {
	return member.results[0]?.agent ?? member.displayName ?? asString(member.args.agent, "subagent");
}

/**
 * Rows for consecutive single-mode subagent tool calls grouped under Subagents.
 * Members with no results yet (args still streaming or awaiting execute) are
 * in the "delegating" phase: they surface the unveiled agent type once it is
 * written and render with the gradient label while current, closing the
 * gradient when the next subagent invocation starts.
 */
export function memberRecordsToRows(members: SubagentLayoutMember[]): AgentRowDescriptor[] {
	return members.map((member) => {
		const displayName = resolve_member_display_name(member);
		const terminal = member.terminal === true;
		// Not yet invoked: brace still open or worker not started. Surface the
		// agent type as soon as it is written; unknown-agent members render as
		// the gradient header only (spare row) so "Delegating" never repeats.
		if (!terminal && !member.failureMessage && member.results.length === 0) {
			const agentType =
				(typeof member.displayName === "string" && member.displayName.trim() !== ""
					? member.displayName.trim()
					: undefined) ??
				(typeof member.args.agent === "string" && member.args.agent.trim() !== ""
					? member.args.agent.trim()
					: undefined);
			return {
				status: "running" as const,
				name: agentType ?? DELEGATING_LABEL,
				result: undefined,
				delegating: true,
				isSingle: false,
				toolCallId: member.toolCallId,
			};
		}
		return {
			status: member.failureMessage ? "failed" : agentStatus(member.results[0], terminal),
			name: displayName,
			result: member.results[0],
			failureMessage: member.failureMessage,
			isSingle: false,
			toolCallId: member.toolCallId,
		};
	});
}

/**
 * Group header line: while any member is still delegating (no results yet),
 * the header itself is the single gradient `Delegating` row so repeated
 * subagent tool calls never stack redundant labels; otherwise the settled
 * `Subagents` label is used.
 */
function renderGroupHeaderLine(
	headerLabel: string,
	rows: AgentRowDescriptor[],
	theme: ThemeLike,
	elapsedMs?: number,
): string {
	if (rows.some((r) => r.delegating)) return renderDelegatingRow(theme);
	const hasError = rows.some((r) => r.status === "failed");
	const allDone = rows.length > 0 && rows.every((r) => r.status !== "running");
	return renderGroupLabel(headerLabel, hasError, allDone, theme, allDone ? elapsedMs : undefined);
}

/**
 * Last *visible* row still in the delegating phase — the one that owns the
 * gradient. Unknown-agent placeholder rows (name `Delegating`) are skipped in
 * the render loops, so they must not claim the gradient index.
 */
function lastDelegatingIndex(rows: AgentRowDescriptor[]): number {
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].delegating && rows[i].name !== DELEGATING_LABEL) return i;
	}
	return -1;
}

/**
 * A member still in the delegating phase: show the unveiled agent type with
 * the gradient label while it is the current invocation, settling to static
 * text once the next subagent is invoked (gradient closed on the prior).
 */
function renderDelegatingAgentLabel(
	theme: ThemeLike,
	name: string,
	prefix: string,
	gradient: boolean,
): string {
	const label = gradient ? renderLiveGradient(name, "subagent") : theme.fg("text", name);
	return prefix + label;
}

function fillSubagentLayoutContainer(
	container: Container,
	headerLabel: string | undefined,
	rows: AgentRowDescriptor[],
	theme: ThemeLike,
	elapsedMs?: number,
	thinkingBlocksVisible = false,
): void {
	const fg = theme.fg.bind(theme);
	const hasHeader = headerLabel !== undefined;
	if (headerLabel) {
		container.addChild(
			new Text(renderGroupHeaderLine(headerLabel, rows, theme, elapsedMs), 0, 0),
		);
	}
	const flatEntries = buildFlatEntries(rows, thinkingBlocksVisible);
	const lastDelegatingIdx = lastDelegatingIndex(rows);
	let agent_seen = 0;
	for (const entry of flatEntries) {
		const row = entry.descriptor;
		const treePrefix = treePrefixForEntry(entry, hasHeader, rows.length);
		if (entry.type === "agent") {
			// A still-delegating member whose agent type is unknown: the
			// gradient header already says "Delegating" — no redundant child.
			if (row.delegating && row.name === DELEGATING_LABEL) {
				agent_seen += 1;
				continue;
			}
			// Dim separator between consecutive agents when more than one is
			// shown and thinking blocks are visible (SSOT chatbox border color).
			if (agent_seen > 0 && rows.length > 1 && thinkingBlocksVisible) {
				container.addChild(new DimSeparator());
			}
			agent_seen += 1;
			const rowText = row.delegating
				? renderDelegatingAgentLabel(
						theme,
						row.name,
						hasHeader ? fg("dim", treePrefix) : "",
						entry.agentIndex === lastDelegatingIdx,
					)
				: renderAgentRow(
						row.status,
						row.name,
						theme,
						row.result,
						hasHeader ? fg("dim", treePrefix) : "",
						row.failureMessage,
						entry.agentIndex * SUBAGENT_PHASE_OFFSET_MS,
						row.isSingle,
						row.isSingle && row.status !== "running" ? elapsedMs : undefined,
					);
			container.addChild(new Text(rowText, 0, 0));
		} else if (entry.type === "liveOutput") {
			const rawLiveItems = row.result?.liveItems;
			const liveItems = Array.isArray(rawLiveItems) ? rawLiveItems : [];
			const outerPrefix = outerPrefixForAgent(entry.parentAgentIndex, rows.length, hasHeader);
			container.addChild(
				new SubagentLiveOutputText(
					liveItems,
					fg("dim", outerPrefix),
					row.status === "running",
					theme,
					row.result?.isThinking === true,
					row.toolCallId,
				),
			);
		} else {
			const childRow = renderSubagentChildRow(entry, row, theme, treePrefix);
			if (childRow) container.addChild(new SubagentToolText(childRow));
		}
	}
	if (container.children.length === 0) {
		container.addChild(new Text(renderDelegatingRow(theme), 0, 0));
	}
}

/**
 * Derive the ordered list of visible agent rows from args + results.
 * Single mode: one row. Parallel: all tasks. Chain: only started steps
 * (pending steps hidden until they start). The header label string is
 * returned separately so callers can render it transparently.
 */
function deriveAgentRows(
	args: SubagentArgs,
	results: SubAgentResult[],
	terminal = false,
	toolCallId?: string,
	failureMessage?: string,
): {
	headerLabel: string | undefined;
	rows: AgentRowDescriptor[];
} {
	if (isSingleModeSubagentArgs(args)) {
		return {
			headerLabel: undefined,
			rows: [
				{
					status: failureMessage ? "failed" : agentStatus(results[0], terminal),
					name: results[0]?.agent ?? args.agent ?? "subagent",
					result: results[0],
					failureMessage,
					isSingle: true,
					toolCallId,
				},
			],
		};
	}

	if (args.tasks && args.tasks.length > 0) {
		const tasks = args.tasks as Array<{ agent: string }>;
		const statuses = tasks.map((_, i) => agentStatus(results[i], terminal));
		const rows: AgentRowDescriptor[] = tasks.map((t, i) => ({
			status: statuses[i],
			name: results[i]?.agent ?? t.agent,
			result: results[i],
			isSingle: false,
		}));
		return { headerLabel: "Subagents", rows };
	}

	if (args.chain && args.chain.length > 0) {
		const chain = args.chain as Array<{ agent: string }>;
		const started = chain.slice(0, results.length);
		const statuses = started.map((_, i) => agentStatus(results[i], terminal));
		const rows: AgentRowDescriptor[] = started.map((s, i) => ({
			status: statuses[i],
			name: results[i]?.agent ?? s.agent,
			result: results[i],
			isSingle: false,
		}));
		return { headerLabel: "Subagents", rows };
	}

	return { headerLabel: undefined, rows: [] };
}

/**
 * Render the compact grouped layout for a subagent tool call as a plain
 * string (no per-row backgrounds). Used by tests and as the text source
 * for the component builder.
 *
 * - Single mode: running `agentName` uses plain text color; nested tool rows
 *   use the compact-group gradient verbs (Searching, Reading, …).
 *   completed and failed agents use green/red bullets.
 * - Parallel mode: `Subagents` header + `└ agent` children with the same
 *   running/completed/failed treatment.
 * - Chain mode: same grouped structure, but only running + completed steps
 *   appear (pending steps are hidden until they start).
 *
 * No `⏳`, no `[scope]`, no `parallel (N tasks)` — just bullets and names.
 */
export function renderSubagentLayout(
	args: SubagentArgs,
	results: SubAgentResult[],
	theme: ThemeLike,
	elapsedMs?: number,
	groupedMembers?: SubagentLayoutMember[],
	terminal = false,
	failureMessage?: string,
): string {
	if (groupedMembers && groupedMembers.length > 1) {
		const rows = memberRecordsToRows(groupedMembers);
		const lines: string[] = [];
		const fg = theme.fg.bind(theme);
		const hasHeader = true;
		lines.push(renderGroupHeaderLine("Subagents", rows, theme, elapsedMs));
		const flatEntries = buildFlatEntries(rows, false);
		const lastDelegatingIdx = lastDelegatingIndex(rows);
		for (const entry of flatEntries) {
			const row = entry.descriptor;
			const treePrefix = treePrefixForEntry(entry, hasHeader, rows.length);
			if (entry.type === "agent") {
				if (row.delegating && row.name === DELEGATING_LABEL) continue;
				lines.push(
					row.delegating
						? renderDelegatingAgentLabel(
								theme,
								row.name,
								fg("dim", treePrefix),
								entry.agentIndex === lastDelegatingIdx,
							)
						: renderAgentRow(
								row.status,
								row.name,
								theme,
								row.result,
								fg("dim", treePrefix),
								row.failureMessage,
								entry.agentIndex * SUBAGENT_PHASE_OFFSET_MS,
								false,
							),
					);
			} else {
				const childRow = renderSubagentChildRow(entry, row, theme, treePrefix);
				if (childRow) lines.push(childRow);
			}
		}
		return lines.join("\n");
	}
	if (shouldShowSubagentDelegating(results, terminal)) {
		if (isSingleModeSubagentArgs(args)) {
			return renderDelegatingRow(theme);
		}
	}
	const { headerLabel, rows } = deriveAgentRows(args, results, terminal, undefined, failureMessage);
	const fg = theme.fg.bind(theme);
	const lines: string[] = [];
	const hasHeader = headerLabel !== undefined;
	if (headerLabel) {
		const hasError = rows.some((r) => r.status === "failed");
		const allDone = rows.length > 0 && rows.every((r) => r.status !== "running");
		lines.push(
			renderGroupLabel(headerLabel, hasError, allDone, theme, allDone ? elapsedMs : undefined),
		);
	}
	const flatEntries = buildFlatEntries(rows, false);
	for (const entry of flatEntries) {
		const row = entry.descriptor;
		const treePrefix = treePrefixForEntry(entry, hasHeader, rows.length);
		if (entry.type === "agent") {
			lines.push(
				renderAgentRow(
					row.status,
					row.name,
					theme,
					row.result,
					hasHeader ? fg("dim", treePrefix) : "",
					row.failureMessage,
					entry.agentIndex * SUBAGENT_PHASE_OFFSET_MS,
					row.isSingle,
					row.isSingle && row.status !== "running" ? elapsedMs : undefined,
				),
			);
		} else {
			const childRow = renderSubagentChildRow(entry, row, theme, treePrefix);
			if (childRow) lines.push(childRow);
		}
	}
	if (lines.length === 0) {
		if (terminal) return "";
		return renderDelegatingRow(theme);
	}
	return lines.join("\n");
}

/**
 * Build the compact grouped layout as a Component tree with per-terminal-row
 * `subagentBg` Box backgrounds. All rows (running, completed, failed) and the
 * group header are transparent. Completed agent names render in plain text
 * color (not the live mode accent). No per-row background tint.
 *
 * The returned Container is rebuilt on every renderCall/renderResult, so
 * it always reflects the latest statuses. The stable tick subscription
 * (in index.ts) drives the invalidate that triggers the rebuild.
 */
export function buildSubagentLayoutComponent(
	args: SubagentArgs,
	results: SubAgentResult[],
	theme: ThemeLike,
	elapsedMs?: number,
	groupedMembers?: SubagentLayoutMember[],
	terminal = false,
	toolCallId?: string,
	failureMessage?: string,
	thinkingBlocksVisible = false,
): Container {
	const container = new Container();
	if (groupedMembers && groupedMembers.length > 1) {
		const rows = memberRecordsToRows(groupedMembers);
		fillSubagentLayoutContainer(
			container,
			"Subagents",
			rows,
			theme,
			elapsedMs,
			thinkingBlocksVisible,
		);
		return container;
	}
	if (shouldShowSubagentDelegating(results, terminal) && isSingleModeSubagentArgs(args)) {
		container.addChild(new Text(renderDelegatingRow(theme), 0, 0));
		return container;
	}
	const { headerLabel, rows } = deriveAgentRows(
		args,
		results,
		terminal,
		toolCallId,
		failureMessage,
	);
	fillSubagentLayoutContainer(
		container,
		headerLabel,
		rows,
		theme,
		elapsedMs,
		thinkingBlocksVisible,
	);
	return container;
}

/**
 * Whether any agent in the layout is still running (flashing).
 */
export function anySubagentRunning(
	args: SubagentArgs,
	results: SubAgentResult[],
	terminal = false,
): boolean {
	if (terminal) return false;
	if (isSingleModeSubagentArgs(args)) {
		return agentStatus(results[0], false) === "running";
	}
	if (args.tasks && args.tasks.length > 0) {
		return args.tasks.some(
			(_t: { agent: string; task: string }, i: number) =>
				agentStatus(results[i], false) === "running",
		);
	}
	if (args.chain && args.chain.length > 0) {
		return args.chain
			.slice(0, results.length)
			.some(
				(_s: { agent: string; task: string }, i: number) =>
					agentStatus(results[i], false) === "running",
			);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Expanded view (Ctrl+O)
// ---------------------------------------------------------------------------

/**
 * Detailed per-agent output for the expanded view. Each terminal agent
 * gets its own transparent section (no subagentBg). No aggregate outer box.
 * aggregate outer box — each section is independently tinted.
 */
export function renderSubagentExpanded(
	details: { mode: "single" | "parallel" | "chain"; results: SubAgentResult[] },
	theme: ThemeLike,
): Component | undefined {
	const fg = theme.fg.bind(theme);
	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleResult(details.results[0], true, theme);
	}

	const container = new Container();
	for (const r of details.results) {
		const rowContent = new Container();
		const stepIcon = isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
		rowContent.addChild(new Text(`${stepIcon} ${fg("dim", r.agent)}`, 0, 0));
		const failureMessage = isFailedResult(r) ? resolve_failure_message(r) : undefined;
		if (failureMessage) {
			rowContent.addChild(new Text(fg("error", `Error: ${failureMessage}`), 0, 0));
		}
		const finalOutput = getResultOutput(r);
		if (finalOutput) {
			rowContent.addChild(new Spacer(1));
			rowContent.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) rowContent.addChild(new Text(fg("dim", usageStr), 0, 0));
		// All expanded sections are transparent — no subagentBg background.
		container.addChild(rowContent);
		container.addChild(new Spacer(1));
	}
	const totalUsage = formatUsageStats(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Text(fg("dim", `Total: ${totalUsage}`), 0, 0));
	}
	return container;
}
