/**
 * TUI rendering for pi-subagent.
 *
 * Renders sub-agent results in collapsed and expanded views.
 * Collapsed: status icon, agent name, last few items, usage stats.
 * Expanded (Ctrl+O): full task text, all tool calls, final markdown output.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	buildGroupStaticText,
	formatCompactChildRow,
	formatStandaloneCallRow,
	format_compact_group_child_prefix,
	groupBulletColorFromFlags,
	statusBulletColor,
	WORK_GROUP_KEY,
	type CompactCall,
	type DiscoveryGroup,
} from "../../../pi-compact-tools/renderer.ts";
import {
	chatboxBorderColor,
	create_live_markdown,
	create_live_thinking_markdown,
	formatElapsed,
	renderLiveGradient,
} from "../../../pi-ember-ui/index.ts";
import {
	format_in_group_thinking_row,
	THINKING_GRADIENT_PRESET,
} from "../../../pi-ember-ui/thinking-status-render.ts";
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
import {
	format_subagent_thinking_elapsed_suffix,
	getSubagentElapsedMs,
} from "./subagent-timing.ts";

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

export class SubagentToolText implements Component {
	text = "";

	constructor(text = "") {
		this.text = text;
	}

	/** Required by Pi's public Component seam; the row has no render cache. */
	invalidate(): void {}

	render(width: number): string[] {
		const maxToolWidth = Math.max(1, Math.floor(width * TOOL_ROW_WIDTH_FRACTION));
		return [truncateToWidth(this.text, maxToolWidth)];
	}
}

/** Single source for subagent tree branch color — must always be `dim`. */
const SUBAGENT_TREE_COLOR = "dim";

/** Detect rendered content after Markdown's ANSI styles are removed. */
const ANSI_SGR_PATTERN = new RegExp(`${String.fromCharCode(27, 92, 91)}[0-9;]*m`, "g");

function hasVisibleTrayContent(text: string): boolean {
	return text.replace(ANSI_SGR_PATTERN, "").trim().length > 0;
}

/**
 * Outer subagent-tray branch. Inner work-group child prefixes are built by
 * `format_compact_group_child_prefix()` from pi-compact-tools so completed
 * rows and live Thinking lanes share the main renderer's one spacing policy.
 */
const SUBAGENT_TRAY_PIPE = "\u2502"; // │ — outer branch continuation
const SUBAGENT_TRAY_LAST = "\u2514"; // └ — outer branch terminator (latest tool-call block)
const SUBAGENT_TRAY_GAP = " "; // outer-branch slot for trailing Thinking/status rows

/**
 * Flush 1-column tree glyph for single-mode subagent child rows (no header).
 * No trailing space, so `  └Thinking` and `  └bash -c …` sit flush against
 * the content — the shared compact-tools TREE_BRANCH_* constants carry a
 * trailing space for compact group children and stay untouched. Subagent-only
 * composition seam, like the SUBAGENT_TRAY_* flush glyphs above.
 */
const SUBAGENT_BRANCH_LAST = "\u2514"; // └

/** Render the transient hidden-mode finalization row with Thinking's gradient. */
function renderLiveFinishingRow(
	theme: ThemeLike,
	treePrefix = `  ${SUBAGENT_BRANCH_LAST}`,
): string {
	return (
		theme.fg(SUBAGENT_TREE_COLOR, treePrefix) +
		renderLiveGradient("Finishing", THINKING_GRADIENT_PRESET)
	);
}

type LiveSegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "work"; rows: SubagentLiveToolRow[] };

type TrayRow = {
	body: string;
	header: boolean;
	/** Explicit outer-tree separator between two chronological segments. */
	separator?: boolean;
	/** Force the outer tray branch glyph instead of deriving it from the header index. */
	outer?: typeof SUBAGENT_TRAY_PIPE | typeof SUBAGENT_TRAY_LAST | typeof SUBAGENT_TRAY_GAP;
};

/**
 * SSOT subagent mirror of the main assistant stream boundary
 * (`resolve_assistant_stream_boundary_event` in pi-ember-ui): a live text item
 * is a hard work-burst boundary only when it carries non-empty visible text.
 * Bare `text_start` blocks and empty/whitespace-only deltas are NOT
 * boundaries — they must never split the current work burst, matching how the
 * main compact renderer ignores `text_start` and empty `text_delta`.
 */
export function is_live_text_boundary(text: string): boolean {
	return text.trim().length > 0;
}

/**
 * Split the chronological live buffer into transcript siblings and compact
 * tool bursts. Visible thinking is a chronological Markdown sibling: it closes
 * the preceding tool burst and lets the following wave start below the
 * reasoning. Hidden thinking remains activity within its surrounding compact
 * work burst, where the canonical in-group Thinking lane owns the slot.
 */
function buildLiveSegments(items: SubagentLiveItem[], showText = true): LiveSegment[] {
	const segments: LiveSegment[] = [];
	let burst: Extract<LiveSegment, { kind: "work" }> | null = null;

	function closeBurst(): void {
		burst = null;
	}

	function ensureBurst(): Extract<LiveSegment, { kind: "work" }> {
		if (burst === null) {
			burst = { kind: "work", rows: [] };
			segments.push(burst);
		}
		return burst;
	}

	function appendVisibleThinking(text: string): void {
		const content = text.trim();
		if (!content) return;
		const previous = segments[segments.length - 1];
		if (previous?.kind === "thinking") {
			previous.text = `${previous.text}\n\n${content}`;
			return;
		}
		segments.push({ kind: "thinking", text: content });
	}

	for (const item of items) {
		if (item.kind === "text") {
			if (!is_live_text_boundary(item.text)) continue;
			closeBurst();
			if (showText) segments.push({ kind: "text", text: item.text });
			continue;
		}

		if (item.kind === "thinking") {
			if (showText) {
				if (!item.text.trim()) continue;
				closeBurst();
				appendVisibleThinking(item.text);
			} else {
				ensureBurst();
			}
			continue;
		}

		ensureBurst().rows.push(item.row);
	}
	return segments;
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
 * Build a live work group whose aggregate retains every record but whose
 * visible child is always the latest tool call. This mirrors the main compact
 * renderer's `appendToGroup` rule: every new call advances the canonical
 * `childAbsorbBefore` boundary, including same-name and parallel calls.
 */
function buildLiveGroup(rows: SubagentLiveToolRow[]): DiscoveryGroup {
	const records = rows.map(liveRowToCall);
	return {
		records,
		key: WORK_GROUP_KEY,
		type: "work",
		childAbsorbBefore: Math.max(0, records.length - 1),
	} as DiscoveryGroup;
}

/**
 * In-group Thinking lane row body — shared by the single-tool and grouped
 * burst paths so the lane is identical whether the burst has one or many rows.
 */
function renderLiveThinkingLane(theme: ThemeLike, toolCallId?: string): string {
	const elapsed = format_subagent_thinking_elapsed_suffix(theme, toolCallId);
	return (
		theme.fg(SUBAGENT_TREE_COLOR, format_compact_group_child_prefix("last", "")) +
		format_in_group_thinking_row(elapsed)
	);
}

/**
 * Width-safe wrapper for streamed child text. Uses the SSOT
 * `create_live_markdown` pipeline so subagent text renders through the same
 * live heading binding, theme-generation cache, and Markdown lexing as
 * assistant text blocks — never raw `theme.fg("text", line)` lines.
 */
class SubagentLiveTextMarkdown implements Component {
	private readonly markdown: Component;

	constructor(text: string) {
		this.markdown = create_live_markdown(text);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		return [...this.markdown.render(width)];
	}

	renderForGutter(width: number, gutterWidth: number): string[] {
		return this.render(Math.max(1, width - gutterWidth));
	}
}

/**
 * Width-safe wrapper for child reasoning. It delegates Markdown parsing,
 * default thinking style, live heading binding, and theme-generation caching to
 * pi-ember-ui. Rendering returns a fresh row array; the tray prefixes only
 * rows with visible content so Markdown paragraph spacing never becomes a
 * branch-only tree row.
 */
class SubagentThinkingMarkdown implements Component {
	private readonly markdown: Component;

	constructor(text: string) {
		this.markdown = create_live_thinking_markdown(text);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	render(width: number): string[] {
		return [...this.markdown.render(width)];
	}

	renderForGutter(width: number, gutterWidth: number): string[] {
		return this.render(Math.max(1, width - gutterWidth));
	}
}

/**
 * Multi-line live output tray for a running subagent. Visible child reasoning
 * uses canonical shared Markdown as a chronological sibling of compact tool
 * bursts. Hidden reasoning stays raw-content-free and uses only the compact
 * in-group Thinking lane after its current work burst.
 */
export class SubagentLiveOutputText implements Component {
	items: SubagentLiveItem[] = [];
	treePrefix = "";
	running = true;
	isThinking = false;
	isFinishing = false;
	showText = true;
	theme: ThemeLike | undefined;
	toolCallId?: string;

	constructor(
		items: SubagentLiveItem[] = [],
		treePrefix = "",
		running = true,
		theme?: ThemeLike,
		isThinking = false,
		toolCallId?: string,
		showText = true,
		isFinishing = false,
	) {
		this.items = items;
		this.treePrefix = treePrefix;
		this.running = running;
		this.theme = theme;
		this.isThinking = isThinking;
		this.toolCallId = toolCallId;
		this.showText = showText;
		this.isFinishing = isFinishing;
	}

	/** Required by Pi's public Component seam; the row has no render cache. */
	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		const fg = theme.fg.bind(theme);
		const show_finishing = this.isFinishing && !this.showText;

		// Finalization is a transient status. In hidden-thinking mode it owns the
		// complete tray so stale retained tool, text, and raw-reasoning content
		// cannot leak beside the terminal Finishing row.
		if (show_finishing) {
			const prefix = this.treePrefix + SUBAGENT_TRAY_GAP;
			const row = renderLiveFinishingRow(theme);
			return [truncateToWidth(`${prefix}${row}`, Math.max(1, width))];
		}

		const segments = buildLiveSegments(this.items, this.showText);
		if (segments.length === 0) return [];

		const gutterWidth = visibleWidth(this.treePrefix + SUBAGENT_TRAY_PIPE);
		const segmentRows: Array<{ kind: LiveSegment["kind"]; rows: TrayRow[] }> = [];
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i];
			const rows: TrayRow[] = [];
			if (segment.kind === "text") {
				const textMd = new SubagentLiveTextMarkdown(segment.text);
				for (const body of textMd.renderForGutter(width, gutterWidth)) {
					rows.push({ body, header: false });
				}
			} else if (segment.kind === "thinking") {
				const markdown = new SubagentThinkingMarkdown(segment.text);
				for (const body of markdown.renderForGutter(width, gutterWidth)) {
					rows.push({ body, header: false });
				}
			} else if (segment.kind === "work") {
				// In-group `└ Thinking` owns the slot only when this burst is the
				// tray's last segment and the child agent is actively reasoning
				// with parent thinking blocks hidden.
				const thinking_follows = !this.showText && this.isThinking && i === segments.length - 1;
				if (segment.rows.length === 1) {
					// A single-tool burst is a bare standalone compact row — no
					// `Explored 1 file` header. Same `records.length > 1` threshold
					// as the main conversation's renderCallInner. The SSOT formatter
					// owns verb + path + stats; only the leading `•` bullet is
					// stripped because the outer tray branch already marks the block.
					const record = liveRowToCall(segment.rows[0], 0);
					const standalone = formatStandaloneCallRow(record, theme);
					const bullet = statusBulletColor(record.isError, record._completed === true, theme);
					const body = standalone.startsWith(bullet) ? standalone.slice(bullet.length) : standalone;
					rows.push({ body, header: false });
				} else if (segment.rows.length > 1) {
					const group = buildLiveGroup(segment.rows);
					// With a hidden-thinking lane below, the prior tool child collapses
					// (the in-group `└ Thinking` lane replaces it) via buildGroupStaticText's
					// show_thinking path (same SSOT as the main renderer). Production call
					// sites pass thinkingBlocksVisible = !isThinkingBlocksHidden(), so the
					// global flag is true whenever this tray is in hidden mode (showText === false).
					if (thinking_follows) group.thinkingChild = true;
					const block = buildGroupStaticText(group, theme, true, "");
					const blockLines = block.split("\n");
					for (let li = 0; li < blockLines.length; li++) {
						rows.push({ body: blockLines[li] ?? "", header: li === 0 });
					}
				}
				if (thinking_follows) {
					// The thinking lane renders below the work block with only its
					// own `└` prefix: the outer tray branch must not add a second
					// terminal `└`, so force the gap outer slot.
					rows.push({
						body: renderLiveThinkingLane(theme, this.toolCallId),
						header: false,
						// The gap slot keeps the inner `└` the only terminal marker.
						outer: SUBAGENT_TRAY_GAP,
					});
				}
			}

			// Empty thinking_start markers and Markdown render results deliberately
			// have no visible segment. Internal Markdown blank rows survive only
			// beside actual content; the prefix loop below paints them as pipe
			// continuation rows so the branch never visually breaks.
			if (rows.some((row) => hasVisibleTrayContent(row.body))) {
				segmentRows.push({ kind: segment.kind, rows });
			}
		}
		if (segmentRows.length === 0) return [];

		// Visible work/thinking segments have one explicit separator before the
		// next chronological segment. This is segment-level state, not Markdown
		// row state: adjacent transport deltas have already been coalesced into
		// one visual thinking segment by buildLiveSegments(). Markdown continuation
		// rows remain content rows and never create additional separators.
		if (this.showText) {
			for (let i = 0; i < segmentRows.length - 1; i++) {
				const segment_kind = segmentRows[i].kind;
				if (segment_kind === "work" || segment_kind === "thinking") {
					segmentRows[i].rows.push({ body: "", header: false, separator: true });
				}
			}
		}

		let start = 0;
		let total = segmentRows.reduce((sum, segment) => sum + segment.rows.length, 0);
		while (start < segmentRows.length - 1 && total > SUBAGENT_LIVE_OUTPUT_MAX_ROWS) {
			total -= segmentRows[start].rows.length;
			start++;
		}

		let rows: TrayRow[] = segmentRows.slice(start).flatMap((segment) => segment.rows);
		if (rows.length > SUBAGENT_LIVE_OUTPUT_MAX_ROWS) {
			const header = rows.find((row) => row.header) ?? rows[0];
			rows = [header, ...rows.slice(-(SUBAGENT_LIVE_OUTPUT_MAX_ROWS - 1))];
		}
		const lastSegment = segmentRows[segmentRows.length - 1];
		let lastHeaderIndex = -1;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].header) lastHeaderIndex = i;
		}
		if (lastSegment.kind === "text" || lastSegment.kind === "thinking") {
			for (let i = rows.length - 1; i >= 0; i--) {
				if (hasVisibleTrayContent(rows[i].body)) {
					lastHeaderIndex = i;
					break;
				}
			}
		}
		if (lastHeaderIndex < 0) {
			for (let i = rows.length - 1; i >= 0; i--) {
				if (hasVisibleTrayContent(rows[i].body)) {
					lastHeaderIndex = i;
					break;
				}
			}
		}

		const out: string[] = [];
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].separator) {
				// An explicit separator must lead to later rendered content. This
				// check is applied after the row cap so a retained pipe can never
				// dangle when the next segment was trimmed.
				const has_following_content = rows
					.slice(i + 1)
					.some((row) => !row.separator && hasVisibleTrayContent(row.body));
				if (!has_following_content) continue;
				out.push(
					truncateToWidth(
						this.treePrefix + fg(SUBAGENT_TREE_COLOR, SUBAGENT_TRAY_PIPE),
						Math.max(1, width),
					),
				);
				continue;
			}
			const body = rows[i].body;
			const outer =
				rows[i].outer ??
				(i < lastHeaderIndex
					? SUBAGENT_TRAY_PIPE
					: i === lastHeaderIndex
						? SUBAGENT_TRAY_LAST
						: SUBAGENT_TRAY_GAP);
			const outerStyled = outer === SUBAGENT_TRAY_GAP ? outer : fg(SUBAGENT_TREE_COLOR, outer);
			const prefix = this.treePrefix + outerStyled;
			if (hasVisibleTrayContent(body)) {
				out.push(truncateToWidth(`${prefix}${body}`, Math.max(1, width)));
			} else if (outer === SUBAGENT_TRAY_GAP) {
				// Trailing blank rows after the last visible header remain unprefixed.
				out.push("");
			} else {
				// Interior blank rows emitted by Markdown or text stay on the tree:
				// repeat the pipe so the vertical branch never visually breaks
				// mid-segment. Only trailing blanks (outer GAP, past the last
				// visible header) remain unprefixed.
				out.push(
					truncateToWidth(
						this.treePrefix + fg(SUBAGENT_TREE_COLOR, SUBAGENT_TRAY_PIPE),
						Math.max(1, width),
					),
				);
			}
		}
		if (!this.running && out.length > 0) {
			out.push(chatboxBorderColor("─".repeat(width)));
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
				container.addChild(create_live_markdown(finalOutput.trim()));
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
// Compact per-agent block layout
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
	elapsedMs?: number,
): string {
	const elapsedSuffix = formatSubagentElapsedSuffix(theme, elapsedMs);
	// Every per-agent block uses the canonical status bullet: muted while
	// running, success green when completed, error red on failure (SSOT
	// statusBulletColor).
	const prefix =
		status === "running"
			? statusBulletColor(false, false, theme)
			: statusBulletColor(status === "failed", status === "completed", theme);
	// Running rows never carry an elapsed suffix — call sites pass elapsedMs
	// only for terminal rows, and this guard keeps it that way.
	if (status === "running") {
		return prefix + theme.fg("text", agentName);
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

/** Render a single agent row as a plain string (no background). */
function renderAgentRow(
	status: AgentStatus,
	agentName: string,
	theme: ThemeLike,
	result?: SubAgentResult,
	failureMessage?: string,
	elapsedMs?: number,
): string {
	return renderAgentLabel(status, agentName, theme, result, failureMessage, elapsedMs);
}

type FlatEntry =
	| { type: "agent"; descriptor: AgentRowDescriptor; agentIndex: number }
	| { type: "tool"; descriptor: AgentRowDescriptor; parentAgentIndex: number }
	| { type: "thinking"; descriptor: AgentRowDescriptor; parentAgentIndex: number }
	| { type: "finishing"; descriptor: AgentRowDescriptor; parentAgentIndex: number }
	| { type: "liveOutput"; descriptor: AgentRowDescriptor; parentAgentIndex: number };

function buildFlatEntries(rows: AgentRowDescriptor[], thinkingBlocksVisible: boolean): FlatEntry[] {
	const entries: FlatEntry[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		entries.push({ type: "agent", descriptor: row, agentIndex: i });
		const live_items = row.result?.liveItems;
		const has_live_items = Array.isArray(live_items) && live_items.length > 0;

		// Visible thinking blocks show the full child live output tray.
		// When thinking blocks are hidden, show only ONE single row below the agent header
		// (the latest tool call, thinking status, or finishing status).
		const has_live_output = row.status === "running" && thinkingBlocksVisible && has_live_items;

		if (!has_live_output) {
			if (row.status === "running") {
				if (row.result?.isFinishing) {
					entries.push({ type: "finishing", descriptor: row, parentAgentIndex: i });
				} else if (row.result?.isThinking && row.result.reasoning !== false) {
					entries.push({ type: "thinking", descriptor: row, parentAgentIndex: i });
				} else if (row.result?.latestToolCall) {
					entries.push({ type: "tool", descriptor: row, parentAgentIndex: i });
				}
			}
		} else {
			entries.push({ type: "liveOutput", descriptor: row, parentAgentIndex: i });
		}
	}
	return entries;
}

/**
 * Nested Thinking row while a running subagent waits between tool calls.
 */
export function renderSubagentThinkingRow(
	theme: ThemeLike,
	treePrefix: string,
	toolCallId?: string,
): string {
	const fg = theme.fg.bind(theme);
	const elapsed = format_subagent_thinking_elapsed_suffix(theme, toolCallId);
	return fg(SUBAGENT_TREE_COLOR, treePrefix) + format_in_group_thinking_row(elapsed);
}

function renderSubagentChildRow(
	entry: FlatEntry,
	row: AgentRowDescriptor,
	theme: ThemeLike,
	treePrefix: string,
): string | undefined {
	if (entry.type === "finishing") {
		return renderLiveFinishingRow(theme, treePrefix);
	}
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
	return `${fg(SUBAGENT_TREE_COLOR, treePrefix)}${body}`;
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

// ---------------------------------------------------------------------------
// Compact layout — per-agent blocks (pure string + component builder)
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
	toolCallId?: string;
}

/** Flush child prefix for the nested latest-tool/Thinking row under an agent. */
function childPrefix(): string {
	return `  ${SUBAGENT_BRANCH_LAST}`;
}

/**
 * Append one per-agent block to a Container: the agent row (bullet + name +
 * status suffix + frozen elapsed) followed by its nested latest-tool /
 * Thinking / live-output tray rows. Every subagent — single mode, and each
 * member of a native parallel/chain call — renders through this one path, so
 * consecutive blocks look identical and are separated by exactly one blank
 * row (inserted by the caller between blocks). No duplicate top padding:
 * Pi's self-shell separator is the single leading blank above the first
 * block.
 */
function addAgentBlockToContainer(
	container: Container,
	row: AgentRowDescriptor,
	theme: ThemeLike,
	elapsedMs?: number,
	thinkingBlocksVisible = false,
): void {
	const rowElapsed = row.toolCallId ? getSubagentElapsedMs(row.toolCallId) : elapsedMs;
	container.addChild(
		new Text(
			renderAgentRow(
				row.status,
				row.name,
				theme,
				row.result,
				row.failureMessage,
				row.status !== "running" ? rowElapsed : undefined,
			),
			0,
			0,
		),
	);
	const flatEntries = buildFlatEntries([row], thinkingBlocksVisible);
	for (const entry of flatEntries) {
		if (entry.type === "agent") continue;
		if (entry.type === "liveOutput") {
			const rawLiveItems = row.result?.liveItems;
			const liveItems = Array.isArray(rawLiveItems) ? rawLiveItems : [];
			container.addChild(
				new SubagentLiveOutputText(
					liveItems,
					theme.fg(SUBAGENT_TREE_COLOR, "  "),
					row.status === "running",
					theme,
					row.result?.isThinking === true,
					row.toolCallId,
					thinkingBlocksVisible,
					row.result?.isFinishing === true,
				),
			);
			continue;
		}
		const childRow = renderSubagentChildRow(entry, row, theme, childPrefix());
		if (childRow) container.addChild(new SubagentToolText(childRow));
	}
}

/** Render one per-agent block as a plain string (tests). */
function renderAgentBlockString(
	row: AgentRowDescriptor,
	theme: ThemeLike,
	elapsedMs?: number,
): string {
	const rowElapsed = row.toolCallId ? getSubagentElapsedMs(row.toolCallId) : elapsedMs;
	const lines = [
		renderAgentRow(
			row.status,
			row.name,
			theme,
			row.result,
			row.failureMessage,
			row.status !== "running" ? rowElapsed : undefined,
		),
	];
	const flatEntries = buildFlatEntries([row], false);
	for (const entry of flatEntries) {
		if (entry.type === "agent" || entry.type === "liveOutput") continue;
		const childRow = renderSubagentChildRow(entry, row, theme, childPrefix());
		if (childRow) lines.push(childRow);
	}
	return lines.join("\n");
}

/**
 * Derive the ordered list of visible agent rows from args + results.
 * Single mode: one row. Parallel: all tasks. Chain: only started steps
 * (pending steps hidden until they start). Each row renders as its own
 * direct agent block — there is no group header.
 */
function deriveAgentRows(
	args: SubagentArgs,
	results: SubAgentResult[],
	terminal = false,
	failureMessage?: string,
): AgentRowDescriptor[] {
	if (isSingleModeSubagentArgs(args)) {
		return [
			{
				status: failureMessage ? "failed" : agentStatus(results[0], terminal),
				name: results[0]?.agent ?? args.agent ?? "subagent",
				result: results[0],
				failureMessage,
				toolCallId: results[0]?.toolCallId,
			},
		];
	}

	if (args.tasks && args.tasks.length > 0) {
		const tasks = args.tasks as Array<{ agent: string }>;
		return tasks.map((t, i) => ({
			status: agentStatus(results[i], terminal),
			name: results[i]?.agent ?? t.agent,
			result: results[i],
			toolCallId: results[i]?.toolCallId,
		}));
	}

	if (args.chain && args.chain.length > 0) {
		const chain = args.chain as Array<{ agent: string }>;
		const started = chain.slice(0, results.length);
		return started.map((s, i) => ({
			status: agentStatus(results[i], terminal),
			name: results[i]?.agent ?? s.agent,
			result: results[i],
			toolCallId: results[i]?.toolCallId,
		}));
	}

	return [];
}

/**
 * Render the per-agent block layout for a subagent tool call as a plain
 * string (no per-row backgrounds). Used by tests and as the text source
 * for the component builder.
 *
 * - Single mode: running `agentName` uses plain text color; nested tool rows
 *   use the compact-group gradient verbs (Searching, Reading, …).
 *   completed and failed agents use green/red bullets.
 * - Parallel mode: every task is its own direct agent block, one below
 *   another with exactly one blank row between blocks (no `Subagents`
 *   header).
 * - Chain mode: each started step is its own block (pending steps are
 *   hidden until they start).
 *
 * No `⏳`, no `[scope]`, no `parallel (N tasks)` — just bullets and names.
 */
export function renderSubagentLayout(
	args: SubagentArgs,
	results: SubAgentResult[],
	theme: ThemeLike,
	elapsedMs?: number,
	terminal = false,
	failureMessage?: string,
): string {
	if (shouldShowSubagentDelegating(results, terminal)) {
		if (isSingleModeSubagentArgs(args)) {
			return renderDelegatingRow(theme);
		}
	}
	const rows = deriveAgentRows(args, results, terminal, failureMessage);
	if (rows.length === 0) {
		if (terminal) return "";
		return renderDelegatingRow(theme);
	}
	const blocks = rows.map((row) => renderAgentBlockString(row, theme, elapsedMs));
	return blocks.join("\n\n");
}

/**
 * Build the per-agent block layout as a Component tree. All rows (running,
 * completed, failed) are transparent; completed agent names render in plain
 * text color (not the live mode accent). No per-row background tint, no
 * group header. Multiple visible members (native parallel/chain) render one
 * block per agent with exactly one blank row between blocks and no duplicate
 * top/trailing padding — Pi's self-shell separator supplies the single
 * leading blank above the first block.
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
	terminal = false,
	_toolCallId?: string,
	failureMessage?: string,
	thinkingBlocksVisible = false,
): Container {
	const container = new Container();
	if (shouldShowSubagentDelegating(results, terminal) && isSingleModeSubagentArgs(args)) {
		container.addChild(new Text(renderDelegatingRow(theme), 0, 0));
		return container;
	}
	const rows = deriveAgentRows(args, results, terminal, failureMessage);
	if (rows.length === 0) {
		// Unrecognized streaming args (`{}` before the mode is written): the
		// whole call renders its own gradient Delegating row until execute
		// publishes a placeholder.
		if (!terminal) container.addChild(new Text(renderDelegatingRow(theme), 0, 0));
		return container;
	}
	rows.forEach((row, index) => {
		if (index > 0) container.addChild(new Spacer(1));
		addAgentBlockToContainer(container, row, theme, elapsedMs, thinkingBlocksVisible);
	});
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
			rowContent.addChild(create_live_markdown(finalOutput.trim()));
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
