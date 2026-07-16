/**
 * TUI rendering for pi-subagent.
 *
 * Renders sub-agent results in collapsed and expanded views.
 * Collapsed: status icon, agent name, last few items, usage stats.
 * Expanded (Ctrl+O): full task text, all tool calls, final markdown output.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { MUTED_GROUP_GRADIENT_PRESET, renderLiveGradient } from "../../../pi-ember-ui/index.ts";
import {
	BULLET,
	formatCallBody,
	groupBulletColorFromFlags,
	statusBulletColor,
	TREE_BRANCH_LAST,
	TREE_BRANCH_TEE,
	TREE_NESTED_LAST,
	TREE_NESTED_PIPE,
	TREE_SINGLE_TOOL,
} from "../../../pi-compact-tools/renderer.ts";
import {
	Box,
	Container,
	type Component,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import { type SubAgentResult, isFailedResult, getResultOutput } from "./runner.ts";

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

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const maxToolWidth = Math.max(1, Math.floor(width * TOOL_ROW_WIDTH_FRACTION));
		return [truncateToWidth(this.text, maxToolWidth)];
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
	theme: { fg: (c: any, t: string) => string; bold: (t: string) => string },
): Container | Text {
	const isError = isFailedResult(result);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getResultOutput(result);

	if (expanded) {
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}`;
		if (isError && result.stopReason) {
			const reasonColor = result.stopReason === "timeout" ? "warning" : "error";
			header += ` ${theme.fg(reasonColor, `[${result.stopReason}]`)}`;
		}
		container.addChild(new Text(header, 0, 0));
		if (isError && result.errorMessage) {
			const messageColor = result.stopReason === "timeout" ? "warning" : "error";
			container.addChild(new Text(theme.fg(messageColor, `Error: ${result.errorMessage}`), 0, 0));
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
	if (isError && result.errorMessage) {
		const messageColor = result.stopReason === "timeout" ? "warning" : "error";
		text += `\n${theme.fg(messageColor, `Error: ${result.errorMessage}`)}`;
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

function agentStatus(result: SubAgentResult | undefined): AgentStatus {
	if (!result || result.exitCode === -1) return "running";
	return isFailedResult(result) ? "failed" : "completed";
}

function agentStatusSuffix(status: AgentStatus, theme: any): string {
	if (status === "failed") return theme.fg("error", " ✗");
	if (status === "completed") return theme.fg("success", " ✓");
	return "";
}

function renderAgentLabel(
	status: AgentStatus,
	agentName: string,
	theme: any,
	result?: SubAgentResult,
	phaseOffsetMs: number = 0,
	isSingle = false,
): string {
	const prefix = isSingle
		? status === "running"
			? statusBulletColor(false, false, theme)
			: theme.fg("muted", BULLET)
		: "";
	if (status === "running") {
		return prefix + renderLiveGradient(agentName, MUTED_GROUP_GRADIENT_PRESET, phaseOffsetMs);
	}
	let suffix = "";
	if (status === "failed" && result) {
		const output = getResultOutput(result).trim();
		if (output) {
			const clipped = output.length > 60 ? `${output.slice(0, 60)}...` : output;
			suffix = ` ${theme.fg("muted", clipped)}`;
		}
	}
	return prefix + theme.fg("accent", agentName) + suffix + agentStatusSuffix(status, theme);
}

/**
 * Render a single agent row as a plain string (no background). Terminal
 * rows are wrapped in a per-row `subagentBg` Box by `buildSubagentLayout`;
 * running rows and the group header stay transparent.
 */
function renderAgentRow(
	status: AgentStatus,
	agentName: string,
	theme: any,
	result?: SubAgentResult,
	prefix = "",
	phaseOffsetMs: number = 0,
	isSingle = false,
): string {
	return prefix + renderAgentLabel(status, agentName, theme, result, phaseOffsetMs, isSingle);
}

type FlatEntry =
	| { type: "agent"; descriptor: AgentRowDescriptor; agentIndex: number }
	| { type: "tool"; descriptor: AgentRowDescriptor; parentAgentIndex: number };

function buildFlatEntries(rows: AgentRowDescriptor[]): FlatEntry[] {
	const entries: FlatEntry[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		entries.push({ type: "agent", descriptor: row, agentIndex: i });
		if (row.status === "running" && row.result?.latestToolCall) {
			entries.push({ type: "tool", descriptor: row, parentAgentIndex: i });
		}
	}
	return entries;
}

/** Agent rows close with └ on the last agent; earlier agents use ├. */
function agentTreePrefix(agentIndex: number, agentCount: number): string {
	return agentIndex < agentCount - 1 ? TREE_BRANCH_TEE : TREE_BRANCH_LAST;
}

/** Tool rows nest under their agent; the last agent's tool closes with └. */
function toolTreePrefix(parentAgentIndex: number, agentCount: number): string {
	return parentAgentIndex < agentCount - 1 ? TREE_NESTED_PIPE : TREE_NESTED_LAST;
}

function treePrefixForEntry(entry: FlatEntry, hasHeader: boolean, agentCount: number): string {
	if (!hasHeader) {
		return TREE_SINGLE_TOOL;
	}
	if (entry.type === "agent") {
		return agentTreePrefix(entry.agentIndex, agentCount);
	}
	return toolTreePrefix(entry.parentAgentIndex, agentCount);
}

function renderLatestToolRow(
	row: AgentRowDescriptor,
	theme: any,
	treePrefix: string,
): string | undefined {
	if (row.status !== "running" || !row.result?.latestToolCall) return undefined;
	const fg = theme.fg.bind(theme);
	return `${fg("dim", treePrefix)}${formatCallBody(
		row.result.latestToolCall.name,
		row.result.latestToolCall.args,
		theme,
		true,
	)}`;
}

const DELEGATING_LABEL = "Delegating";

/** Parent tool is running but no subagent has emitted a tool call or message yet. */
export function isSubagentDelegating(results: SubAgentResult[]): boolean {
	if (results.length === 0) return true;
	return results.every((r) => r.exitCode === -1 && !r.latestToolCall && r.messages.length === 0);
}

/** Compact single-row state while the parent invokes the subagent tool. */
export function renderDelegatingRow(theme: any): string {
	const bullet = groupBulletColorFromFlags(false, false, theme);
	const label = renderLiveGradient(DELEGATING_LABEL, MUTED_GROUP_GRADIENT_PRESET);
	return bullet + label;
}

function renderGroupLabel(
	label: string,
	_hasError: boolean,
	_allDone: boolean,
	theme: any,
): string {
	// Header is plain dim/bold with the same bullet spacing as a compact
	// group header (e.g. "• Exploring") so the group columns align.
	return theme.fg("dim", BULLET) + theme.fg("dim", theme.bold(label));
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
	isSingle: boolean;
}

/**
 * Derive the ordered list of visible agent rows from args + results.
 * Single mode: one row. Parallel: all tasks. Chain: only started steps
 * (pending steps hidden until they start). The header label string is
 * returned separately so callers can render it transparently.
 */
function deriveAgentRows(
	args: any,
	results: SubAgentResult[],
): {
	headerLabel: string | undefined;
	rows: AgentRowDescriptor[];
} {
	if (args.agent && args.task && !(args.tasks?.length > 0) && !(args.chain?.length > 0)) {
		return {
			headerLabel: undefined,
			rows: [
				{
					status: agentStatus(results[0]),
					name: results[0]?.agent ?? args.agent,
					result: results[0],
					isSingle: true,
				},
			],
		};
	}

	if (args.tasks && args.tasks.length > 0) {
		const tasks = args.tasks as Array<{ agent: string }>;
		const statuses = tasks.map((_, i) => agentStatus(results[i]));
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
		const statuses = started.map((_, i) => agentStatus(results[i]));
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
 * - Single mode: running `agentName` uses the muted group gradient;
 *   completed and failed agents use green/red bullets.
 * - Parallel mode: `Subagents` header + `└ agent` children with the same
 *   running/completed/failed treatment.
 * - Chain mode: same grouped structure, but only running + completed steps
 *   appear (pending steps are hidden until they start).
 *
 * No `⏳`, no `[scope]`, no `parallel (N tasks)` — just bullets and names.
 */
export function renderSubagentLayout(args: any, results: SubAgentResult[], theme: any): string {
	if (isSubagentDelegating(results)) {
		return renderDelegatingRow(theme);
	}
	const { headerLabel, rows } = deriveAgentRows(args, results);
	const fg = theme.fg.bind(theme);
	const lines: string[] = [];
	const hasHeader = headerLabel !== undefined;
	if (headerLabel) {
		const hasError = rows.some((r) => r.status === "failed");
		const allDone = rows.length > 0 && rows.every((r) => r.status !== "running");
		lines.push(renderGroupLabel(headerLabel, hasError, allDone, theme));
	}
	const flatEntries = buildFlatEntries(rows);
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
					entry.agentIndex * 32,
					row.isSingle,
				),
			);
		} else {
			const toolRow = renderLatestToolRow(row, theme, treePrefix);
			if (toolRow) lines.push(toolRow);
		}
	}
	if (lines.length === 0) return fg("dim", "subagent");
	return lines.join("\n");
}

/**
 * Build the compact grouped layout as a Component tree with per-terminal-row
 * `subagentBg` Box backgrounds. Running rows and the group header remain
 * transparent. Each completed/failed row gets its own full-width Box so
 * mixed parallel/chain layouts show transparent live rows alongside
 * independently tinted terminal rows.
 *
 * The returned Container is rebuilt on every renderCall/renderResult, so
 * it always reflects the latest statuses. The stable tick subscription
 * (in index.ts) drives the invalidate that triggers the rebuild.
 */
export function buildSubagentLayoutComponent(
	args: any,
	results: SubAgentResult[],
	theme: any,
): Container {
	const container = new Container();
	if (isSubagentDelegating(results)) {
		container.addChild(new Text(renderDelegatingRow(theme), 0, 0));
		return container;
	}
	const { headerLabel, rows } = deriveAgentRows(args, results);
	const fg = theme.fg.bind(theme);

	if (headerLabel) {
		const hasError = rows.some((r) => r.status === "failed");
		const allDone = rows.length > 0 && rows.every((r) => r.status !== "running");
		// Header is always transparent — no subagentBg.
		container.addChild(new Text(renderGroupLabel(headerLabel, hasError, allDone, theme), 0, 0));
	}

	const hasHeader = headerLabel !== undefined;
	const flatEntries = buildFlatEntries(rows);
	for (let i = 0; i < flatEntries.length; i++) {
		const entry = flatEntries[i];
		const row = entry.descriptor;
		const treePrefix = treePrefixForEntry(entry, hasHeader, rows.length);
		if (entry.type === "agent") {
			const agentIndex = entry.agentIndex;
			const rowText = renderAgentRow(
				row.status,
				row.name,
				theme,
				row.result,
				hasHeader ? fg("dim", treePrefix) : "",
				agentIndex * 32,
				row.isSingle,
			);
			if (row.status === "completed") {
				// Completed rows get the user-message-style subagentBg background.
				const rowBox = new Box(1, 0, (s: string) => theme.bg("subagentBg", s));
				rowBox.addChild(new Text(rowText, 0, 0));
				container.addChild(rowBox);
			} else {
				// Running and failed rows are transparent.
				container.addChild(new Text(rowText, 0, 0));
			}
		} else {
			const toolRow = renderLatestToolRow(row, theme, treePrefix);
			if (toolRow) container.addChild(new SubagentToolText(toolRow));
		}
	}

	if (container.children.length === 0) {
		container.addChild(new Text(fg("dim", "subagent"), 0, 0));
	}
	return container;
}

/**
 * Whether any agent in the layout is still running (flashing).
 */
export function anySubagentRunning(args: any, results: SubAgentResult[]): boolean {
	if (args.agent && args.task && !(args.tasks?.length > 0) && !(args.chain?.length > 0)) {
		return agentStatus(results[0]) === "running";
	}
	if (args.tasks && args.tasks.length > 0) {
		return args.tasks.some((_t: any, i: number) => agentStatus(results[i]) === "running");
	}
	if (args.chain && args.chain.length > 0) {
		return args.chain
			.slice(0, results.length)
			.some((_s: any, i: number) => agentStatus(results[i]) === "running");
	}
	return false;
}

// ---------------------------------------------------------------------------
// Expanded view (Ctrl+O)
// ---------------------------------------------------------------------------

/**
 * Detailed per-agent output for the expanded view. Each terminal agent
 * gets its own `subagentBg` Box; running agents are transparent. No
 * aggregate outer box — each section is independently tinted.
 */
export function renderSubagentExpanded(
	details: { mode: "single" | "parallel" | "chain"; results: SubAgentResult[] },
	theme: any,
): Component | undefined {
	const fg = theme.fg.bind(theme);
	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		const inner = renderSingleResult(details.results[0], true, theme);
		if (isFailedResult(details.results[0])) {
			return inner;
		}
		const box = new Box(1, 0, (s: string) => theme.bg("subagentBg", s));
		box.addChild(inner);
		return box;
	}

	const container = new Container();
	for (const r of details.results) {
		const rowContent = new Container();
		const stepIcon = isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
		rowContent.addChild(new Text(`${stepIcon} ${fg("accent", r.agent)}`, 0, 0));
		if (r.errorMessage) {
			rowContent.addChild(new Text(fg("error", `Error: ${r.errorMessage}`), 0, 0));
		}
		const finalOutput = getResultOutput(r);
		if (finalOutput) {
			rowContent.addChild(new Spacer(1));
			rowContent.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) rowContent.addChild(new Text(fg("dim", usageStr), 0, 0));
		if (isFailedResult(r)) {
			// Failed expanded sections are transparent, not tinted.
			container.addChild(rowContent);
		} else {
			// Each terminal completed agent section gets its own subagentBg Box.
			const rowBox = new Box(1, 0, (s: string) => theme.bg("subagentBg", s));
			rowBox.addChild(rowContent);
			container.addChild(rowBox);
		}
		container.addChild(new Spacer(1));
	}
	const totalUsage = formatUsageStats(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Text(fg("dim", `Total: ${totalUsage}`), 0, 0));
	}
	return container;
}
