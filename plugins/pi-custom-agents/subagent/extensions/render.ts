/**
 * TUI rendering for pi-subagent.
 *
 * Renders sub-agent results in collapsed and expanded views.
 * Collapsed: status icon, agent name, last few items, usage stats.
 * Expanded (Ctrl+O): full task text, all tool calls, final markdown output.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { renderGradientLabel } from "../../../pi-ember-ui/index.ts";
import { getActiveModeColor } from "../../../pi-ember-ui/mode-colors.ts";
import { Box, Container, type Component, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import { type SubAgentResult, isFailedResult, getResultOutput } from "./runner.ts";

type Foreground = (color: string, text: string) => string;

/**
 * Width-aware cap for the running subagent shell. It renders at the width
 * supplied by the TUI instead of baking a terminal width into the component.
 */
export class SubagentCapLine implements Component {
	private foreground: Foreground;

	constructor(
		private readonly isVisible: () => boolean,
		foreground: Foreground,
	) {
		this.foreground = foreground;
	}

	setForeground(foreground: Foreground): void {
		this.foreground = foreground;
	}

	render(width: number): string[] {
		if (!this.isVisible()) return [];
		return [this.foreground("border", "\u2500".repeat(Math.max(0, width)))];
	}

	invalidate(): void {}
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
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number; turns?: number },
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
							0, 0,
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
	}
	else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
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

function agentIcon(status: AgentStatus, theme: any): string {
	if (status === "failed") return theme.fg("error", "✗ ");
	return theme.fg("success", "✓ ");
}

function hashPhase(name: string): number {
	let n = 7;
	for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
	return (n % 1000) / 1000;
}

function renderAgentLabel(status: AgentStatus, agentName: string, theme: any, result?: SubAgentResult): string {
	if (status === "running") return renderGradientLabel(agentName, getActiveModeColor(), hashPhase(agentName));
	let suffix = "";
	if (status === "failed" && result) {
		const output = getResultOutput(result).trim();
		if (output) {
			const clipped = output.length > 60 ? `${output.slice(0, 60)}...` : output;
			suffix = ` ${theme.fg("muted", clipped)}`;
		}
	}
	return agentIcon(status, theme) + theme.fg("accent", agentName) + suffix;
}

function renderGroupLabel(
	label: string,
	_hasError: boolean,
	_allDone: boolean,
	theme: any,
): string {
	// Header is always plain dim/bold; never gradient.
	return theme.fg("dim", theme.bold(label));
}

/**
 * Render the compact grouped layout for a subagent tool call.
 *
 * - Single mode: running `agentName` uses the Thinking gradient; completed
 *   and failed agents use green/red bullets.
 * - Parallel mode: `Subagents` header + `└ agent` children with the same
 *   running/completed/failed treatment.
 * - Chain mode: same grouped structure, but only running + completed steps
 *   appear (pending steps are hidden until they start).
 *
 * No `⏳`, no `[scope]`, no `parallel (N tasks)` — just bullets and names.
 */
export function renderSubagentLayout(
	args: any,
	results: SubAgentResult[],
	theme: any,
): string {
	const fg = theme.fg.bind(theme);

	// --- Single mode ---
	if (args.agent && args.task && !(args.tasks?.length > 0) && !(args.chain?.length > 0)) {
		const status = agentStatus(results[0]);
		return renderAgentLabel(status, args.agent, theme, results[0]);
	}

	// --- Parallel mode ---
	if (args.tasks && args.tasks.length > 0) {
		const tasks = args.tasks as Array<{ agent: string }>;
		const statuses = tasks.map((_, i) => agentStatus(results[i]));
		const hasError = statuses.some((s) => s === "failed");
		const allDone = statuses.every((s) => s !== "running");
		const lines = [renderGroupLabel("Subagents", hasError, allDone, theme)];
		for (const [i, t] of tasks.entries()) {
			const prefix = i === 0 ? "  └ " : "    ";
			lines.push(fg("dim", prefix) + renderAgentLabel(statuses[i], t.agent, theme, results[i]));
		}
		return lines.join("\n");
	}

	// --- Chain mode ---
	if (args.chain && args.chain.length > 0) {
		const chain = args.chain as Array<{ agent: string }>;
		// Only show steps that have started (have a result entry).
		const started = chain.slice(0, results.length);
		const statuses = started.map((_, i) => agentStatus(results[i]));
		const hasError = statuses.some((s) => s === "failed");
		const allDone = statuses.length > 0 && statuses.every((s) => s !== "running");
		const lines = [renderGroupLabel("Subagents", hasError, allDone, theme)];
		for (const [i, step] of started.entries()) {
			const prefix = i === 0 ? "  └ " : "    ";
			lines.push(fg("dim", prefix) + renderAgentLabel(statuses[i], step.agent, theme, results[i]));
		}
		return lines.join("\n");
	}

	// Fallback (should not reach here)
	return fg("dim", "subagent");
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
		return args.chain.slice(0, results.length).some((_s: any, i: number) => agentStatus(results[i]) === "running");
	}
	return false;
}

// ---------------------------------------------------------------------------
// Expanded view (Ctrl+O)
// ---------------------------------------------------------------------------

/**
 * Detailed per-agent output for the expanded view, wrapped in a
 * subagentBg Box so it stays visually integrated with the collapsed row.
 */
export function renderSubagentExpanded(
	details: { mode: "single" | "parallel" | "chain"; results: SubAgentResult[] },
	theme: any,
): Component | undefined {
	const fg = theme.fg.bind(theme);
	const mdTheme = getMarkdownTheme();
	const box = new Box(1, 0, (s: string) => (theme.bg as any)("subagentBg", s));

	if (details.mode === "single" && details.results.length === 1) {
		const inner = renderSingleResult(details.results[0], true, theme);
		if (inner instanceof Container) {
			box.addChild(inner);
		} else if (inner instanceof Text) {
			box.addChild(inner);
		}
		return box;
	}

	const container = new Container();
	for (const r of details.results) {
		const stepIcon = isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
		container.addChild(new Text(`${stepIcon} ${fg("accent", r.agent)}`, 0, 0));
		if (r.errorMessage) {
			container.addChild(new Text(fg("error", `Error: ${r.errorMessage}`), 0, 0));
		}
		const finalOutput = getResultOutput(r);
		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) container.addChild(new Text(fg("dim", usageStr), 0, 0));
		container.addChild(new Spacer(1));
	}
	const totalUsage = formatUsageStats(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Text(fg("dim", `Total: ${totalUsage}`), 0, 0));
	}
	box.addChild(container);
	return box;
}
