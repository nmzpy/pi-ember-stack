import { describe, expect, mock, test } from "bun:test";
import {
	renderSubagentLayout,
	buildSubagentLayoutComponent,
	anySubagentRunning,
	isSubagentDelegating,
	shouldShowSubagentDelegating,
	renderDelegatingRow,
	formatSubagentElapsedSuffix,
	memberRecordsToRows,
	SubagentToolText,
	SubagentLiveOutputText,
		renderSubagentExpanded,
	renderSubagentThinkingRow,
} from "../render.ts";
import {
	BULLET,
	formatCompactChildRow,
	formatGroupChildRows,
	TREE_BRANCH_TEE,
	TREE_NESTED_LAST,
	TREE_NESTED_PIPE,
	TREE_SINGLE_TOOL,
} from "../../../../pi-compact-tools/renderer.ts";
import { set_gradient_colorizer, reset_gradient_colorizer, type Rgb } from "../../../../pi-ember-ui/gradient.ts";
import { strip_subagent_leading_render_gap } from "../subagent-render-spacing.ts";
import {
	arm_subagent_thinking_pass,
	clear_subagent_thinking_pass,
} from "../subagent-timing.ts";

function forcedColorizer(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

set_gradient_colorizer(forcedColorizer);

function makeTheme() {
	const fg = mock((tag: string, text: string) => `[${tag}:${text}]`);
	return {
		fg,
		bold: mock((s: string) => `*${s}*`),
		bg: mock((tag: string, text: string) => `[bg:${tag}:${text}]`),
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeResult(agent: string, exitCode: number, failed = false) {
	return {
		agent,
		task: "test",
		exitCode,
		messages: [] as any[],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...(failed ? { stopReason: "error", errorMessage: "fail" } : {}),
	} as any;
}

function makeRunning(
	agent: string,
	opts?: { isThinking?: boolean; reasoning?: boolean },
): any {
	const r = makeResult(agent, -1);
	r.messages = [{ role: "assistant", content: [{ type: "text", text: "..." }] }];
	r.reasoning = opts?.reasoning ?? true;
	r.isThinking = opts?.isThinking ?? true;
	return r;
}

function toolItem(
	name: string,
	args: Record<string, unknown>,
	opts: {
		completed?: boolean;
		error?: boolean;
		details?: Record<string, unknown>;
		toolCallId?: string;
	} = {},
): any {
	return {
		kind: "tool",
		row: {
			toolCallId: opts.toolCallId,
			name,
			args,
			completed: opts.completed ?? false,
			error: opts.error ?? false,
			details: opts.details,
		},
	};
}

function textItem(text: string): any {
	return { kind: "text", text };
}

function renderComponent(component: any, width = 80): string {
	return component.render(width).join("\n");
}

describe("SubagentToolText", () => {
	test("truncates to half the viewport width with ellipsis", () => {
		const longText = "x".repeat(120);
		const comp = new SubagentToolText(longText);
		const out = comp.render(80);
		expect(out.length).toBe(1);
		expect(stripAnsi(out[0]).length).toBe(40);
		expect(stripAnsi(out[0]).endsWith("...")).toBe(true);
	});

	test("short text passes through unchanged", () => {
		const comp = new SubagentToolText("hello");
		const out = comp.render(80);
		expect(out).toEqual(["hello"]);
	});

	test("empty text renders empty line", () => {
		const comp = new SubagentToolText("");
		const out = comp.render(80);
		expect(out).toEqual([""]);
	});
});

describe("SubagentLiveOutputText", () => {
	test("parallel running tools share one burst with both children visible", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }),
			toolItem("grep", { pattern: "auth" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(60);
		const text = stripAnsi(out.join("\n"));
		// Header shows the present-tense label while everything is running.
		expect(text).toContain("Exploring");
		expect(text).toContain("Reading");
		expect(text).toContain("a.ts");
		expect(text).toContain("Searching");
		expect(text).toContain("auth");
	});

	test("a new tool family folds the prior wave into the header summary", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem("grep", { pattern: "toggleRecording" }, { completed: true, toolCallId: "c2" }),
			toolItem(
				"edit",
				{ file_path: "LaunchWindow.tsx", oldText: "a", newText: "b" },
				{ completed: true, toolCallId: "c3", details: { diff: "+one\n+two\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Explored 1 file");
		expect(text).toContain("1 search");
		expect(text).toContain("Edited 1 file");
		expect(text).toContain("+2");
		// Only the last wave's child lingers — stale Reading/Searching rows are folded.
		expect(text).not.toContain("Reading");
		expect(text).not.toContain("Searching");
		expect(text).toContain("LaunchWindow.tsx");
	});

	test("streamed agent text renders between folded work bursts in order", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true }),
			textItem("Let me check the launch window."),
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, details: { diff: "+1\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text.indexOf("Explored 1 file")).toBeLessThan(text.indexOf("Let me check the launch window."));
		expect(text.indexOf("Let me check the launch window.")).toBeLessThan(
			text.indexOf("Edited 1 file"),
		);
	});

	test("inserts a one-row spacer with a continuous branch pipe between segments", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true }),
			textItem("Checking the popover."),
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, details: { diff: "+1\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		// header, spacer, text, spacer, header (+ child)
		expect(stripAnsi(out[0])).toContain("Explored 1 file");
		// Spacer rows keep the vertical branch continuous through the one-row
		// padding gap (outer prefix + flush dim pipe, no inner content).
		expect(stripAnsi(out[1])).toBe("  [dim:\u2502]");
		expect(stripAnsi(out[2])).toContain("Checking the popover.");
		expect(stripAnsi(out[3])).toBe("  [dim:\u2502]");
		expect(stripAnsi(out[4])).toContain("Edited 1 file");
		// The outer branch terminates at the latest tool-call block header
		// (the second work burst), not at the trailing child row below it.
		expect(stripAnsi(out[4])).toContain("[dim:\u2514]");
		expect(stripAnsi(out[4])).not.toContain("[dim:\u2502]");
	});

	test("spacer rows stay width-safe at narrow widths", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true }),
			textItem("Checking the popover."),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(7);
		// The spacer truncates to the available width like every other row —
		// it never overflows the terminal width. (The fake theme's literal
		// `[dim:...]` markup counts as content, so narrow widths cut into it.)
		expect(stripAnsi(out[1]).length).toBeLessThanOrEqual(7);
	});

	test("no spacer when the tray is a single work burst", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }),
			toolItem("grep", { pattern: "x" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(60);
		const text = stripAnsi(out.join("\n"));
		expect(text.split("\n").every((line) => line.length > 0)).toBe(true);
	});

	test("no nested work-group bullet: the tray header carries no `•` (subagent-only suppression)", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("bash", { command: "python script.py" }),
			toolItem("read", { path: "a.ts" }),
			toolItem("grep", { pattern: "test" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const text = stripAnsi(out.join("\n"));
		// The nested tray header must not double-mark the work group with a
		// `•` — the outer `└` branch is the row marker (see renderLiveWorkHeader).
		expect(text.split("\u2022").length - 1).toBe(0);
		expect(text).toContain("Working");
		expect(text).toContain("Running");
		expect(text).toContain("python script.py");
		expect(text).toContain("Reading");
		expect(text).toContain("a.ts");
		expect(text).toContain("Searching");
		expect(text).toContain("test");
	});

	test("renders an in-group Thinking lane after a tool wave with continuous tree branching", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("read", { path: "a.ts" }, { completed: true })];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1");
		const out = comp.render(60);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Thinking");
		// Exact branch prefixes: the outer `└` terminates at the latest
		// tool-call block header, the preceding work-group child branches `├`
		// into the Thinking lane (continuous tree), and Thinking carries the
		// terminal inner `└` without extending the outer pipe. (The fake
		// theme keeps `[tag:…]` markup; stripAnsi only removes real ANSI.)
		expect(stripAnsi(out[0])).toBe("  [dim:\u2514][muted:*Explored 1 file*]");
		expect(stripAnsi(out[1])).toBe("   [dim:\u251c][muted:*Read*][muted: a.ts]");
		expect(stripAnsi(out[2])).toBe("   [dim:\u2514]Thinking");
	});

	test("adds a bottom rule when settled", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("read", { path: "a.ts" }, { completed: true })];
		const comp = new SubagentLiveOutputText(items, "", false, theme);
		const out = comp.render(40);
		expect(out.length).toBe(3);
		expect(stripAnsi(out[2])).toBe("\u2500".repeat(40));
	});

	test("running has no bottom rule", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("bash", { command: "ls" })];
		const comp = new SubagentLiveOutputText(items, "", true, theme);
		const out = comp.render(40);
		expect(stripAnsi(out.join("\n"))).not.toContain("\u2500");
	});

	test("truncates long rows to available width", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("bash", { command: "x".repeat(120) })];
		const comp = new SubagentLiveOutputText(items, "  │ ", true, theme);
		const out = comp.render(40);
		expect(out.length).toBe(2);
		for (const line of out) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
		}
	});

	test("caps the tray at 15 lines", () => {
		const theme = makeTheme() as any;
		const items = Array.from({ length: 20 }, (_, i) =>
			toolItem("read", { path: `f${i}.ts` }, { completed: true, toolCallId: `c${i}` }),
		);
		const comp = new SubagentLiveOutputText(items, "", false, theme);
		const out = comp.render(80);
		expect(out.length).toBe(16);
	});

	test("empty items renders nothing", () => {
		const theme = makeTheme() as any;
		const comp = new SubagentLiveOutputText([], "", true, theme);
		expect(comp.render(40)).toEqual([]);
	});
});

describe("nested tray tree composition (regression)", () => {
	test("no nested work-group bullet; 3-column tightening flush against the outer └", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
		];
		// Single-mode outer prefix "  " (the agent tool-row column).
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// No `•` anywhere in the nested tray, and every line sits 3 columns
		// tighter than the old `  │ • Explored` / `  │   └ Read` layout:
		// header text at column 4 (flush against the outer └ at column 3),
		// inner tree glyphs at column 4 (flush with the header text).
		expect(stripped.join("\n")).not.toContain("\u2022");
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Explored 1 file*]",
			"   [dim:\u2514][muted:*Read*][muted: a.ts]",
		]);
	});

	test("in-group Thinking: child branches ├ and Thinking carries the terminal └", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem("read", { path: "b.ts" }, { completed: true, toolCallId: "c2" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1");
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// Both work-group children branch `├` (the tree continues into
		// Thinking); the Thinking lane closes the group with `└` and does
		// NOT extend the outer pipe (no outer glyph at column 3 on it).
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Explored 2 files*]",
			"   [dim:\u251c][muted:*Read*][muted: a.ts]",
			"   [dim:\u251c][muted:*Read*][muted: b.ts]",
			"   [dim:\u2514]Thinking",
		]);
	});

	test("outer branch terminates at the latest tool-call block, not the trailing Thinking", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem("Checking the popover."),
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, toolCallId: "c2", details: { diff: "+1\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1");
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// First burst + spacer + text + spacer continue the outer pipe; the
		// second (latest) burst header terminates it with `└`; the trailing
		// child and Thinking rows hang inside the group without an outer pipe.
		expect(stripped).toEqual([
			"  [dim:\u2502][muted:*Explored 1 file*]",
			"  [dim:\u2502]",
			"  [dim:\u2502][text:Checking the popover.]",
			"  [dim:\u2502]",
			"  [dim:\u2514][muted:*Edited 1 file*]",
			"   [dim:\u251c][muted:*Edit*][muted: b.ts][muted:  ][muted:+1]",
			"   [dim:\u2514]Thinking",
		]);
	});

	test("grouped tray keeps the 3-column tightening flush with the agent branch", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("grep", { pattern: "auth", path: "src" }, { completed: true, toolCallId: "c1" }),
		];
		// Grouped outer prefix "  │" — the tray's own └/│ glyph sits one column
		// right of the tree pipe, directly below the agent name's first letter
		// (`C` of Coder / `S` of Scout at column 3), matching childTreePrefix.
		const comp = new SubagentLiveOutputText(items, "  │", true, theme, true, "call-1");
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// Header text and inner tree align at column 5 (flush with the agent
		// branch, not one column right under the agent name's second letter).
		expect(stripped).toEqual([
			"  │[dim:\u2514][muted:*1 search*]",
			"  │ [dim:\u251c][muted:*Search*][muted: auth][muted: in src]",
			"  │ [dim:\u2514]Thinking",
		]);
	});

	test("trailing agent message snaps the outer └ to the message", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem("Let me check the launch window."),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// The work-burst header keeps the continuous pipe; the agent message
		// is the latest output, so the outer branch terminates `└` on it
		// rather than staying on the older work header.
		expect(stripped).toEqual([
			"  [dim:\u2502][muted:*Explored 1 file*]",
			"  [dim:\u2502]",
			"  [dim:\u2514][text:Let me check the launch window.]",
		]);
	});

	test("running tray without Thinking closes the inner tree on the last child", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { toolCallId: "c1" }),
			toolItem("read", { path: "b.ts" }, { toolCallId: "c2" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// No thinking lane: the last work-group child closes with `└` (the
		// outer branch still terminates at the burst header).
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Exploring*]",
			"   [dim:\u251c]Reading[text: a.ts]",
			"   [dim:\u2514]Reading[text: b.ts]",
		]);
	});
});

describe("subagent native compact row SSOT", () => {
	test("live tool tray child rows equal the native compact group row formatter", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem(
				"edit",
				{ file_path: "foo.ts", oldText: "a", newText: "b" },
				{ completed: true, toolCallId: "c2", details: { diff: "+one\n+two\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const text = stripAnsi(out.join("\n"));
		// The header is the unified work summary (SSOT formatUnifiedWorkHeader).
		expect(text).toContain("Explored 1 file");
		expect(text).toContain("Edited 1 file");
		expect(text).toContain("+2");
		// Only the last wave's child lingers, with the native compact row shape.
		const child = stripAnsi(out[out.length - 1]);
		const native = stripAnsi(
			formatGroupChildRows(
				[
					{
						id: "c2",
						name: "edit",
						args: { file_path: "foo.ts", oldText: "a", newText: "b" },
						isError: false,
						_completed: true,
						result: { details: { diff: "+one\n+two\n" } },
					},
				],
				theme,
			),
		);
		expect(child).toContain(native);
	});

	test("latest tool row uses the native compact child row formatter", () => {
		const theme = makeTheme() as any;
		const running = makeResult("Scout A", -1);
		running.latestToolCall = { name: "grep", args: { pattern: "foo", path: "src" } };
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }] },
			[running],
			theme,
		);
		const toolLine = out.split("\n").find((line) => stripAnsi(line).includes("Searching"));
		expect(toolLine).toBeDefined();
		const native = stripAnsi(
			formatCompactChildRow("grep", { pattern: "foo", path: "src" }, false, undefined, theme),
		);
		expect(stripAnsi(toolLine!)).toContain(native);
	});
});

describe("subagent render spacing", () => {
	test("keeps the native leading separator so the header gets padding above", () => {
		expect(strip_subagent_leading_render_gap(["", "Subagents", "  └Coder A"])).toEqual([
			"",
			"Subagents",
			"  └Coder A",
		]);
	});

	test("does not remove a real first content row", () => {
		const lines = ["Subagents", "  └Coder A"];
		expect(strip_subagent_leading_render_gap(lines)).toBe(lines);
	});

	test("drops the lone separator for empty non-owner members", () => {
		expect(strip_subagent_leading_render_gap([""])).toEqual([]);
		expect(strip_subagent_leading_render_gap([])).toEqual([]);
	});
});

describe("subagent delegating state", () => {
	test("empty results show Delegating with gradient label", () => {
		const theme = makeTheme() as any;
		expect(isSubagentDelegating([])).toBe(true);
		const out = renderSubagentLayout({ agent: "Scout", task: "explore" }, [], theme);
		expect(stripAnsi(out)).toContain("Delegating");
		expect(stripAnsi(out)).toContain("\u2022");
		expect(out).toContain("\u001b[38;2;");
		expect(stripAnsi(renderDelegatingRow(theme))).toContain("Delegating");
	});

	test("running placeholders without activity show Subagents header rows", () => {
		const theme = makeTheme() as any;
		const placeholders = [makeResult("Scout A", -1), makeResult("Scout B", -1)];
		expect(isSubagentDelegating(placeholders)).toBe(false);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Scout", task: "b" }] },
			placeholders,
			theme,
		);
		expect(stripAnsi(out)).toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).toContain("Scout B");
	});

	test("first subagent tool call leaves delegating for the agent tree", () => {
		const theme = makeTheme() as any;
		const active = makeResult("Scout A", -1);
		expect(isSubagentDelegating([active])).toBe(false);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }] },
			[active],
			theme,
		);
		expect(stripAnsi(out)).toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
	});

	test("single placeholder shows agent row once worker is built", () => {
		const theme = makeTheme() as any;
		const placeholder = makeResult("Coder", -1);
		expect(isSubagentDelegating([])).toBe(true);
		expect(isSubagentDelegating([placeholder])).toBe(false);
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [placeholder], theme);
		expect(stripAnsi(out)).not.toContain("Delegating");
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).toContain("[text:Coder]");
	});

	test("terminal empty results show failed agent row, not Delegating", () => {
		const theme = makeTheme() as any;
		expect(shouldShowSubagentDelegating([], true)).toBe(false);
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [], theme, 146_000, undefined, true);
		expect(stripAnsi(out)).not.toContain("Delegating");
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).toContain("[dim:Coder]");
		expect(out).toContain("[dim: 2m 26s]");
		expect(out).not.toContain("\u001b[38;2;");
	});

	test("terminal freezes elapsed suffix and anySubagentRunning is false", () => {
		const args = { agent: "Coder", task: "do stuff" };
		expect(anySubagentRunning(args, [], true)).toBe(false);
		expect(shouldShowSubagentDelegating([], true)).toBe(false);
	});
});

describe("subagent elapsed time", () => {
	test("formatSubagentElapsedSuffix hides under 1s and formats dim elapsed text", () => {
		const theme = makeTheme() as any;
		expect(formatSubagentElapsedSuffix(theme, 500)).toBe("");
		expect(formatSubagentElapsedSuffix(theme, 2500)).toBe("[dim: 2s]");
	});

	test("single mode shows dim elapsed only after the agent finishes", () => {
		const theme = makeTheme() as any;
		const running = renderSubagentLayout(
			{ agent: "Coder", task: "do stuff" },
			[makeRunning("Coder")],
			theme,
			12_500,
		);
		expect(stripAnsi(running)).toContain("Coder");
		expect(running).not.toContain("[dim: 12s]");

		const completed = renderSubagentLayout(
			{ agent: "Coder", task: "do stuff" },
			[makeResult("Coder", 0)],
			theme,
			12_500,
		);
		expect(stripAnsi(completed)).toContain("Coder");
		expect(completed).toContain("[dim: 12s]");
	});

	test("parallel mode shows elapsed only on the Subagents header when all done", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] },
			[makeRunning("Scout"), makeRunning("Coder")],
			theme,
			65_000,
		);
		const lines = out.split("\n");
		expect(lines[0]).not.toContain("[dim: 1m 5s]");
		expect(stripAnsi(lines[1] ?? "")).toContain("Scout");
		expect(lines[1]).not.toContain("1m 5s");
		expect(stripAnsi(lines[3] ?? "")).toContain("Coder");
		expect(lines[3]).not.toContain("1m 5s");

		const done = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] },
			[makeResult("Scout", 0), makeResult("Coder", 0)],
			theme,
			65_000,
		);
		const doneLines = done.split("\n");
		expect(doneLines[0]).toContain("[dim: 1m 5s]");
	});

	test("single delegating row never shows an elapsed timer", () => {
		const theme = makeTheme() as any;
		const out = renderDelegatingRow(theme);
		expect(stripAnsi(out)).toContain("Delegating");
		expect(out).not.toContain("[dim: 3s]");
	});

	test("lingering subagent Thinking row shows time since thinking started", () => {
		const theme = makeTheme() as any;
		const id = "call-lingering-thinking";
		const original_now = performance.now;
		let now = 1_000_000;
		performance.now = () => now;
		try {
			arm_subagent_thinking_pass(id);
			now += 2500;
			const out = renderSubagentThinkingRow(theme, "  └ ", id);
			expect(stripAnsi(out)).toContain("Thinking");
			expect(out).toContain("[dim: 2s]");
		} finally {
			performance.now = original_now;
			clear_subagent_thinking_pass(id);
		}
	});

	test("grouped consecutive singles render one Subagents header", () => {
		const theme = makeTheme() as any;
		const members = [
			{ args: { agent: "Coder", task: "a" }, results: [makeRunning("Coder A")], displayName: "Coder A" },
			{ args: { agent: "Coder", task: "b" }, results: [makeRunning("Coder B")], displayName: "Coder B" },
			{ args: { agent: "Coder", task: "c" }, results: [makeRunning("Coder C")], displayName: "Coder C" },
		];
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, [], theme, 5000, members);
		const lines = out.split("\n");
		expect(stripAnsi(lines[0])).toContain("Subagents");
		expect(lines[0]).not.toContain("[dim: 5s]");
		expect(lines.length).toBeGreaterThanOrEqual(4);
		expect(memberRecordsToRows(members).length).toBe(3);
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Coder B");
		expect(stripAnsi(out)).toContain("Coder C");
	});

	test("grouped streaming members render one gradient Delegating header, agent types as they stream", () => {
		const theme = makeTheme() as any;
		// Brace still open: `agent` is written, `task` is not yet closed.
		const members = [
			{ args: { agent: "Coder", task: "a" }, results: [makeRunning("Coder A")], displayName: "Coder A" },
			{ args: { agent: "Scout" }, results: [], toolCallId: "call-b" },
		];
		const out = renderSubagentLayout(
			{ agent: "Coder", task: "a" },
			[makeRunning("Coder A")],
			theme,
			undefined,
			members,
		);
		const output = stripAnsi(out);
		// ONE Delegating label (the header), not one per streaming call.
		expect(output.split("Delegating").length - 1).toBe(1);
		expect(output).toContain("Coder A");
		expect(output).toContain("Scout");
		// Header carries the shared subagent gradient.
		expect(out.split("\n")[0]).toContain("\u001b[38;2;");
	});

	test("first streaming member with no agent yet shows only the header, no bare subagent text", () => {
		const theme = makeTheme() as any;
		const members = [
			{ args: {}, results: [], toolCallId: "call-a" },
			{ args: { agent: "Scout" }, results: [], toolCallId: "call-b" },
		];
		const out = renderSubagentLayout({}, [], theme, undefined, members);
		const output = stripAnsi(out);
		expect(output.split("Delegating").length - 1).toBe(1);
		expect(output).not.toContain("subagent");
		expect(output).toContain("Scout");
	});

	test("settled grouped members keep the static Subagents header (no gradient)", () => {
		const theme = makeTheme() as any;
		const members = [
			{ args: { agent: "Coder", task: "a" }, results: [makeResult("Coder A", 0)], displayName: "Coder A" },
			{ args: { agent: "Scout", task: "b" }, results: [makeResult("Scout B", 0)], displayName: "Scout B" },
		];
		const out = renderSubagentLayout(
			{ agent: "Coder", task: "a" },
			[makeResult("Coder A", 0)],
			theme,
			undefined,
			members,
		);
		expect(stripAnsi(out)).toContain("Subagents");
		expect(out.split("\n")[0]).not.toContain("\u001b[38;2;");
	});

	test("grouped tool-level failures keep each diagnostic on its agent row", () => {
		const theme = makeTheme() as any;
		const members = [
			{
				args: { agent: "Coder", task: "a" },
				results: [],
				displayName: "Coder A",
				terminal: true,
				failureMessage: "401 Unauthorized",
			},
			{
				args: { agent: "Coder", task: "b" },
				results: [],
				displayName: "Coder B",
				terminal: true,
				failureMessage: "503 Service Unavailable",
			},
		];
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, [], theme, undefined, members, true);
		const output = stripAnsi(out);
		expect(output).toContain("Coder A");
		expect(output).toContain("401 Unauthorized");
		expect(output).toContain("Coder B");
		expect(output).toContain("503 Service Unavailable");
	});

	test("grouped second running agent shows thinking after first completes", () => {
		const theme = makeTheme() as any;
		const completed = makeResult("Coder A", 0);
		const thinking = makeRunning("Scout B", { isThinking: true, reasoning: true });
		const members = [
			{
				args: { agent: "Coder", task: "a" },
				results: [completed],
				displayName: "Coder A",
				terminal: true,
				toolCallId: "call-a",
			},
			{
				args: { agent: "Scout", task: "b" },
				results: [thinking],
				displayName: "Scout B",
				terminal: false,
				toolCallId: "call-b",
			},
		];
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, members[0].results, theme, 5000, members);
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout B");
		expect(stripAnsi(out)).toContain("Thinking");
	});

	test("grouped second running agent shows nested tool row", () => {
		const theme = makeTheme() as any;
		const completed = makeResult("Coder A", 0);
		const withTool = makeRunning("Scout B", { isThinking: false, reasoning: true });
		withTool.latestToolCall = { name: "read", args: { path: "src/foo.ts" } };
		const members = [
			{
				args: { agent: "Coder", task: "a" },
				results: [completed],
				displayName: "Coder A",
				terminal: true,
				toolCallId: "call-a",
			},
			{
				args: { agent: "Scout", task: "b" },
				results: [withTool],
				displayName: "Scout B",
				terminal: false,
				toolCallId: "call-b",
			},
		];
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, members[0].results, theme, undefined, members);
		expect(stripAnsi(out)).toContain("Reading");
		expect(stripAnsi(out)).toContain("src/foo.ts");
	});
});

describe("renderSubagentLayout (string)", () => {
	test("running single mode uses text color for the agent label", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeRunning("Coder")], theme);
		const lines = out.split("\n");
		expect(stripAnsi(lines[0])).toContain("Coder");
		expect(lines[0]).toContain("[text:Coder]");
		expect(lines[0]).not.toContain("\u001b[38;2;");
		expect(stripAnsi(lines[1] ?? "")).toContain("Thinking");
		expect(lines[1]).toContain("\u001b[38;2;");
		expect(stripAnsi(lines[0])).toContain("\u2022");
		expect(out).not.toContain("\u2713");
		expect(out).not.toContain("\u2717");
		expect(out).not.toContain("subagent");
		expect(out).not.toContain("[user]");
		expect(out).not.toContain("\u23f3");
	});

	test("running single mode shows Thinking when reasoning stream is active", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeRunning("Coder A")], theme);
		const lines = out.split("\n");
		expect(lines.length).toBe(2);
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(stripAnsi(lines[1])).toContain("Thinking");
		expect(lines[1]).toContain("\u001b[38;2;");
	});

	test("running single mode hides Thinking when not reasoning", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ agent: "Coder", task: "do stuff" },
			[makeRunning("Coder A", { isThinking: false })],
			theme,
		);
		expect(out.split("\n").length).toBe(1);
		expect(stripAnsi(out)).not.toContain("Thinking");
	});

	test("running single mode hides Thinking when model.reasoning is false", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ agent: "Coder", task: "do stuff" },
			[makeRunning("Coder A", { isThinking: true, reasoning: false })],
			theme,
		);
		expect(out.split("\n").length).toBe(1);
		expect(stripAnsi(out)).not.toContain("Thinking");
	});

	test("running single mode shows latest tool call one column deeper than group children", () => {
		const theme = makeTheme() as any;
		const running = makeResult("Coder", -1);
		running.latestToolCall = { name: "read", args: { path: "plugins/render.ts" } };
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [running], theme);
		const lines = out.split("\n");
		expect(lines.length).toBe(2);
		expect(stripAnsi(lines[0])).toContain("\u2022");
		expect(stripAnsi(lines[0])).toContain("Coder");
		expect(stripAnsi(lines[1])).toContain("\u2514");
		expect(stripAnsi(lines[1])).toContain("Read");
		expect(stripAnsi(lines[1])).toContain("plugins/render.ts");
		expect(lines[1]).toContain("\u001b[38;2;");
	});

	test("running parallel agents show Thinking until a tool starts", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeRunning("Coder A"), makeRunning("Scout A")],
			theme,
		);
		const lines = out.split("\n");
		expect(lines.filter((line) => stripAnsi(line).includes("Thinking")).length).toBe(2);
	});

	test("running tool row uses compact-group gradient verb for grep", () => {
		const theme = makeTheme() as any;
		const running = makeResult("Scout A", -1);
		running.latestToolCall = { name: "grep", args: { pattern: "foo", path: "src" } };
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }] },
			[running],
			theme,
		);
		const toolLine = out.split("\n").find((line) => stripAnsi(line).includes("Searching"));
		expect(toolLine).toBeDefined();
		expect(toolLine).toContain("\u001b[38;2;");
	});

	test("completed single mode uses muted bullet and dim agent name", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 0)], theme);
		const line = stripAnsi(out);
		expect(line).toContain("Coder");
		expect(out).toContain("[dim:Coder]");
		expect(line).toContain("\u2022");
		expect(line.indexOf("Coder")).toBeLessThan(line.indexOf("\u2713"));
		expect(line.trimStart().startsWith("\u2713")).toBe(false);
		expect(out).not.toContain("\u001b[38;2;");
	});

	test("failed single mode uses muted bullet and trailing x", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 1, true)], theme);
		const line = stripAnsi(out);
		expect(line).toContain("Coder");
		expect(line).toContain("\u2022");
		expect(line.indexOf("Coder")).toBeLessThan(line.indexOf("\u2717"));
		expect(line.trimStart().startsWith("\u2717")).toBe(false);
		expect(out).not.toContain("\u001b[38;2;");
	});

	test("failed single mode includes inline error text", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder", 1, true);
		result.errorMessage = "timeout during read";
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [result], theme);
		expect(stripAnsi(out)).toContain("timeout during read");
		// Inline failure reason is rendered with the error color tag, not muted,
		// so the real reason stands out next to the agent name.
		expect(out).toContain("[error:timeout during read]");
		expect(out).not.toContain("[muted:timeout during read]");
	});

	test("failed row uses the provider error instead of a generic abort", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder A", 1, true);
		result.errorMessage = "This operation was aborted";
		result.messages = [
			{ role: "assistant", errorMessage: "401 Unauthorized: invalid api key", content: [] },
		];
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [result], theme);
		expect(stripAnsi(out)).toContain("401 Unauthorized: invalid api key");
		expect(stripAnsi(out)).not.toContain("This operation was aborted");
	});

	test("tool-level failure is shown when no per-agent result was persisted", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ agent: "Coder A", task: "do stuff" },
			[],
			theme,
			undefined,
			undefined,
			true,
			"No model resolved for agent",
		);
		expect(stripAnsi(out)).toContain("No model resolved for agent");
	});

	test("completed single mode does not include error text", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 0)], theme);
		expect(stripAnsi(out)).not.toContain("error");
		expect(stripAnsi(out)).not.toContain("Error");
	});

	test("completed parallel mode puts the checkmark on the right", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Scout", task: "a" }] };
		const out = renderSubagentLayout(args, [makeResult("Scout F", 0)], theme);
		const line = stripAnsi(out.split("\n").find((l) => l.includes("Scout F")) ?? "");
		expect(line.indexOf("Scout F")).toBeLessThan(line.indexOf("\u2713"));
		expect(line.trimStart().startsWith("\u2713")).toBe(false);
	});

	test("failed parallel mode shows inline error only on failed child", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const failed = makeResult("Coder A", 1, true);
		failed.errorMessage = "could not read file";
		const out = renderSubagentLayout(args, [failed, makeResult("Scout A", 0)], theme);
		const output = stripAnsi(out);
		expect(output).toContain("Coder A");
		expect(output).toContain("Scout A");
		expect(output).toContain("could not read file");
		const matches = output.split("could not read file").length - 1;
		expect(matches).toBe(1);
	});

	test("tool row └ sits on the agent name column", () => {
		// Grouped (Subagents/Delegating) agent names start at column 3
		// (bullet-width indent + flush `├`); nested └ sits there too. A
		// single subagent has no header so its name and └ sit at column 2.
		expect(TREE_BRANCH_TEE.length).toBe(2);
		expect(TREE_NESTED_PIPE.indexOf("\u2514")).toBe(3);
		expect(TREE_NESTED_LAST.indexOf("\u2514")).toBe(3);
		expect(BULLET.length).toBe(2);
		expect(TREE_SINGLE_TOOL.indexOf("\u2514")).toBe(2);
	});

	test("running parallel mode uses full Exploring-style tree with nested tool rows", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const coderRunning = makeResult("Coder A", -1);
		coderRunning.latestToolCall = { name: "grep", args: { pattern: "auth", path: "." } };
		const scoutRunning = makeResult("Scout A", -1);
		scoutRunning.latestToolCall = { name: "read", args: { path: "README.md" } };
		const out = renderSubagentLayout(args, [coderRunning, scoutRunning], theme);
		const lines = out.split("\n");
		expect(lines.length).toBe(5);
		expect(stripAnsi(lines[0])).toContain("Subagents");
		expect(stripAnsi(lines[0])).toContain("\u2022");
		expect(stripAnsi(lines[1])).toContain("\u251c");
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("\u2502\u2514");
		expect(stripAnsi(lines[2])).toContain("Search");
		expect(stripAnsi(lines[3])).toContain("\u2514");
		expect(stripAnsi(lines[3])).toContain("Scout A");
		expect(stripAnsi(lines[4])).toContain("   \u2514");
		expect(stripAnsi(lines[4])).toContain("Read");
	});

	test("parallel mode shows plain Subagents header with pipe tree children", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const out = renderSubagentLayout(args, [makeRunning("Coder A"), makeRunning("Scout A")], theme);
		const lines = out.split("\n");
		const header = lines[0];
		expect(stripAnsi(header)).toContain("Subagents");
		expect(header).not.toContain("\u001b[38;2;");
		expect(stripAnsi(lines[1])).toContain("\u251c");
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("Thinking");
		expect(stripAnsi(lines[3])).toContain("\u2514");
		expect(stripAnsi(lines[3])).toContain("Scout A");
		expect(stripAnsi(lines[4])).toContain("Thinking");
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("parallel");
		expect(out).not.toContain("[user]");
		expect(stripAnsi(header)).toContain("\u2022");
	});

	test("chain mode only shows started steps", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] };
		const out = renderSubagentLayout(args, [makeResult("Scout A", 0)], theme);
		expect(out).toContain("Scout A");
		expect(out).not.toContain("Coder");
	});

	test("no hourglass glyphs anywhere", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		const out = renderSubagentLayout(args, [makeResult("Coder A", -1)], theme);
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("\u25d0");
	});

	test("empty args during streaming show Delegating instead of bare tool name", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({}, [], theme);
		expect(stripAnsi(out)).toContain("Delegating");
		expect(stripAnsi(out)).not.toContain("subagent");
	});

	test("anySubagentRunning true when exitCode is -1", () => {
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("Coder A", -1)])).toBe(true);
	});

	test("anySubagentRunning false when all done", () => {
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("Coder A", 0)])).toBe(false);
	});
});

describe("buildSubagentLayoutComponent (transparent rows)", () => {
	test("running single mode has no subagentBg background", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent({ agent: "Coder", task: "do stuff" }, [makeRunning("Coder")], theme);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("completed single mode has no subagentBg Box (dim agent name)", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[makeResult("Coder", 0)],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
		expect(out).toContain("[dim:Coder]");
		expect(out).not.toContain("[text:Coder]");
		expect(out).not.toContain("[accent:Coder]");
	});

	test("failed single mode does not get a subagentBg Box", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[makeResult("Coder", 1, true)],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("parallel mode header is transparent (no subagentBg)", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeRunning("Coder A"), makeRunning("Scout A")],
			theme,
		);
		const out = renderComponent(component);
		const lines = out.split("\n");
		// Header is the first line
		expect(stripAnsi(lines[0])).toContain("Subagents");
		expect(lines[0]).not.toContain("[bg:subagentBg:");
	});

	test("mixed parallel: running and completed rows are both transparent", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", -1), makeResult("Scout A", 0)],
			theme,
		);
		const out = renderComponent(component);
		const lines = out.split("\n");
		// Line 0: header (transparent)
		// Line 1: Coder A running (transparent, text color)
		// Line 2+: Scout A completed (transparent, dim)
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(lines[1]).not.toContain("[bg:subagentBg:");
		expect(lines[1]).toContain("[text:Coder A]");
		const scoutLine = lines.find((l) => stripAnsi(l).includes("Scout A"));
		expect(scoutLine).toBeDefined();
		expect(scoutLine).not.toContain("[bg:subagentBg:");
		expect(scoutLine).toContain("[dim:Scout A]");
		// Tree-prefix column alignment: the completed row's prefix must start at
		// the same column as the running row's prefix. Both rows carry the
		// bullet-width indent so the `├` / `└` pipe sits below the header's
		// first letter (column 2), flush with the agent name. Tree branch prefixes always use the `dim` token, matching the
		// live output tray rows.
		expect(stripAnsi(lines[1]).startsWith("[dim:  \u251c]")).toBe(true);
		expect(stripAnsi(scoutLine!).startsWith("[dim:  \u2514]")).toBe(true);
	});

	test("all completed parallel: no subagentBg on any row", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", 0), makeResult("Scout A", 0)],
			theme,
		);
		const out = renderComponent(component);
		expect(out).not.toContain("[bg:subagentBg:");
		// Verify both agent names are present; finished rows use dim.
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(out).toContain("[dim:Coder A]");
		expect(out).toContain("[dim:Scout A]");
	});

	test("failed parallel row does not get subagentBg", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", 1, true)],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder A");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("chain mode: only started steps appear, completed is transparent", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Scout A", 0)],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).not.toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("chain mode: running step is transparent", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "Scout", task: "a" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeRunning("Scout A")],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Scout A");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("no hourglass glyphs in component output", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", -1)],
			theme,
		);
		const out = renderComponent(component);
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("\u25d0");
	});

	test("long bash latestToolCall is truncated to a single row at half width", () => {
		const theme = makeTheme() as any;
		const running = makeResult("Coder", -1);
		running.latestToolCall = {
			name: "bash",
			args: { command: `python - <<'PY' ${"x".repeat(200)} PY` },
		};
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[running],
			theme,
		);
		const out = renderComponent(component, 80);
		const lines = out.split("\n");
		expect(lines.length).toBe(2);
		const toolLine = lines[1];
		expect(stripAnsi(toolLine).length).toBeLessThanOrEqual(40);
		expect(stripAnsi(toolLine).endsWith("...")).toBe(true);
	});
});

describe("renderSubagentExpanded", () => {
	test("single mode is transparent (no subagentBg Box)", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder", 0);
		result.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		const component = renderSubagentExpanded(
			{ mode: "single", results: [result] },
			theme,
		);
		expect(component).toBeDefined();
		const out = renderComponent(component!);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
		// Agent name renders dim when finished.
		expect(out).toContain("[dim:");
		expect(out).not.toContain("[accent:Coder]");
	});

	test("single mode failed does not wrap in subagentBg Box", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder", 1, true);
		result.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		const component = renderSubagentExpanded(
			{ mode: "single", results: [result] },
			theme,
		);
		expect(component).toBeDefined();
		const out = renderComponent(component!);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("parallel mode: all agent sections are transparent (no subagentBg)", () => {
		const theme = makeTheme() as any;
		const r1 = makeResult("Coder A", 0);
		r1.messages = [{ role: "assistant", content: [{ type: "text", text: "result1" }] }];
		const r2 = makeResult("Scout A", 0);
		r2.messages = [{ role: "assistant", content: [{ type: "text", text: "result2" }] }];
		const component = renderSubagentExpanded(
			{ mode: "parallel", results: [r1, r2] },
			theme,
		);
		expect(component).toBeDefined();
		const out = renderComponent(component!);
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(out).not.toContain("[bg:subagentBg:");
		// Verify both agents' content is present
		expect(stripAnsi(out)).toContain("result1");
		expect(stripAnsi(out)).toContain("result2");
		// Agent names render dim when finished.
		expect(out).toContain("[dim:Coder A]");
		expect(out).toContain("[dim:Scout A]");
	});

	test("parallel mode failed sections do not get subagentBg Box", () => {
		const theme = makeTheme() as any;
		const r1 = makeResult("Coder A", 1, true);
		r1.messages = [{ role: "assistant", content: [{ type: "text", text: "fail" }] }];
		const r2 = makeResult("Scout A", 0);
		r2.messages = [{ role: "assistant", content: [{ type: "text", text: "result2" }] }];
		const component = renderSubagentExpanded(
			{ mode: "parallel", results: [r1, r2] },
			theme,
		);
		expect(component).toBeDefined();
		const out = renderComponent(component!);
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).toContain("result2");
		expect(out).not.toContain("[bg:subagentBg:");
	});
});

describe("buildSubagentLayoutComponent live output tray", () => {
	test("emits compact work-bundle rows when thinking blocks visible and agent running", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [
			toolItem("read", { path: "src/a.ts" }),
			toolItem("grep", { pattern: "auth" }),
		];
		result.latestToolCall = { name: "grep", args: { pattern: "auth" } };
		result.isThinking = false;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			true,
		);
		const out = renderComponent(component);
		const text = stripAnsi(out);
		expect(text).toContain("Exploring");
		expect(text).toContain("Reading");
		expect(text).toContain("src/a.ts");
		expect(text).toContain("Searching");
		expect(text).toContain("auth");
		// No duplicate single latest-tool preview row above the tray.
		expect((text.match(/auth/g) ?? []).length).toBe(1);
	});

	test("live tray shows streamed agent messages above the tool burst", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [
			textItem("Fixing the launch window."),
			toolItem(
				"edit",
				{ file_path: "LaunchWindow.tsx", oldText: "a", newText: "b" },
				{ completed: true, details: { diff: "+1\n-1\n" } },
			),
		];
		result.latestToolCall = undefined;
		result.isThinking = false;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			true,
		);
		const out = renderComponent(component);
		const text = stripAnsi(out);
		expect(text).toContain("Fixing the launch window.");
		expect(text).toContain("Edited 1 file");
		expect(text.indexOf("Fixing the launch window.")).toBeLessThan(text.indexOf("Edited 1 file"));
	});

	test("omits live items when thinking blocks hidden", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [toolItem("read", { path: "secret.ts" }, { completed: true })];
		result.latestToolCall = undefined;
		result.isThinking = false;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			false,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).not.toContain("secret.ts");
	});

	test("omits live items for completed agents even when thinking blocks visible", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder", 0);
		result.liveItems = [toolItem("read", { path: "leftover.ts" }, { completed: true })];
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			true,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).not.toContain("leftover.ts");
	});

	test("live tray renders a bullet-free work header plus bullet-free child rows", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("bash", { command: "python script.py" }),
			toolItem("read", { path: "a.ts" }),
			toolItem("grep", { pattern: "test" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const text = stripAnsi(out.join("\n"));
		// The nested work-group header carries no bullet (subagent seam only).
		expect(text.split("\u2022").length - 1).toBe(0);
		expect(text).toContain("Working");
		expect(text).toContain("Running");
		expect(text).toContain("python script.py");
		expect(text).toContain("Reading");
		expect(text).toContain("a.ts");
		expect(text).toContain("Searching");
		expect(text).toContain("test");
	});

	test("single subagent when thinking blocks hidden places L pipe below first letter of header at column 2", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Scout B");
		result.latestToolCall = { name: "read", args: { path: "index.ts" } };
		const component = buildSubagentLayoutComponent(
			{ agent: "Scout B", task: "find index" },
			[result],
			theme,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			false,
		);
		const out = renderComponent(component);
		const lines = stripAnsi(out).split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("Scout B"); // Pos 0: •, Pos 2: S
		expect(lines[1]).toContain("└"); // L pipe
		expect(lines[1]).not.toContain("\u2022"); // No bullet point
	});
});
