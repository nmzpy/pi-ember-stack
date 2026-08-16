import { describe, expect, mock, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import {
	renderSubagentLayout,
	buildSubagentLayoutComponent,
	anySubagentRunning,
	isSubagentDelegating,
	shouldShowSubagentDelegating,
	renderDelegatingRow,
	formatSubagentElapsedSuffix,
	SubagentToolText,
	SubagentLiveOutputText,
	renderSubagentExpanded,
	renderSubagentThinkingRow,
	is_live_text_boundary,
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
import {
	buildThemeBgColors,
	buildThemeFgColors,
	MUTED_COLOR,
} from "../../../../pi-ember-ui/mode-colors.ts";
import {
	arm_subagent_thinking_pass,
	clear_subagent_thinking_pass,
	clearSubagentTiming,
	make_subagent_member_tool_call_id,
	markSubagentRunning,
	markSubagentTerminal,
} from "../subagent-timing.ts";

const TEST_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
(globalThis as Record<PropertyKey, unknown>)[TEST_THEME_KEY] = new Theme(
	buildThemeFgColors(MUTED_COLOR) as never,
	buildThemeBgColors(MUTED_COLOR) as never,
	"truecolor",
);

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

function thinkingItem(text: string): any {
	return { kind: "thinking", text };
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

	test("streamed agent text renders between work bursts in order", () => {
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
		// Single-tool bursts render as bare standalone rows (no `Explored`/
		// `Edited` headers) — the Read row precedes the streamed text, which
		// precedes the Edit row.
		expect(text.indexOf("Read")).toBeLessThan(text.indexOf("Let me check the launch window."));
		expect(text.indexOf("Let me check the launch window.")).toBeLessThan(text.indexOf("Edit"));
	});

	test("keeps chronological segments contiguous with one pipe padding row below output", () => {
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
		const out = new SubagentLiveOutputText(items, "  ", true, theme).render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text.indexOf("Read")).toBeLessThan(text.indexOf("Checking the popover."));
		expect(text.indexOf("Checking the popover.")).toBeLessThan(text.indexOf("Edit"));
		// Exactly one pipe-continuation padding row below the streamed output,
		// before the next tool call — no other bare-pipe rows.
		expect(out.map(stripAnsi).filter((line) => line === "  [dim:│]").length).toBe(1);
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

	test("hidden thinking keeps the canonical in-group Thinking lane", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("read", { path: "a.ts" }, { completed: true })];
		const out = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1", false).render(60);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Thinking");
		expect(stripAnsi(out[out.length - 1])).toContain("[dim:└─]Thinking");
	});

	test("renders visible thinking content without a tool burst", () => {
		const theme = makeTheme() as any;
		const items = [thinkingItem("I am checking the current implementation.")];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1");
		const text = stripAnsi(comp.render(80).join("\n"));
		expect(text).toContain("I am checking the current implementation.");
	});

	test("renders visible Markdown paragraphs without dead branch-only rows", () => {
		const theme = makeTheme() as any;
		const items = [
			thinkingItem(""),
			thinkingItem("# Reasoning\n\n**First paragraph.**\n\nSecond paragraph."),
		];
		const out = new SubagentLiveOutputText(items, "  ", true, theme).render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Reasoning");
		expect(text).toContain("First paragraph.");
		expect(text).toContain("Second paragraph.");
		expect(text).not.toContain("#");
		expect(text).not.toContain("**");
	});

	test("keeps visible thinking chronological between tool waves", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			thinkingItem("I need to compare the related call site."),
			toolItem("grep", { pattern: "call site", path: "b.ts" }, { completed: true, toolCallId: "c2" }),
		];
		const text = stripAnsi(new SubagentLiveOutputText(items, "  ", true, theme).render(80).join("\n"));
		// Unified work groups on either side of the reasoning keep chronological order.
		expect(text.indexOf("Read")).toBeLessThan(text.indexOf("I need to compare"));
		expect(text.indexOf("I need to compare")).toBeLessThan(text.indexOf("Search"));
		expect(text).toContain("Explored");
	});

	test("hidden thinking stays compact and does not split the tool burst", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			thinkingItem("secret child reasoning"),
			toolItem("read", { path: "b.ts" }, { completed: true, toolCallId: "c2" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1", false);
		const text = stripAnsi(comp.render(80).join("\n"));
		expect(text).not.toContain("secret child reasoning");
		expect(text).toContain("Explored 2 files");
		expect((text.match(/Explored 2 files/g) ?? []).length).toBe(1);
		expect(text).toContain("Thinking");
	});

	test("adds a bottom rule when settled", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("read", { path: "a.ts" }, { completed: true })];
		const comp = new SubagentLiveOutputText(items, "", false, theme);
		const out = comp.render(40);
		// A single-tool burst now uses a unified work group (header + child), then the rule.
		expect(out.length).toBe(3);
		expect(stripAnsi(out[2])).toBe("\u2500".repeat(40));
	});

	test("running has no bottom rule", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("bash", { command: "ls" })];
		const comp = new SubagentLiveOutputText(items, "", true, theme);
		const out = comp.render(40);
		expect(out.some((line) => stripAnsi(line) === "\u2500".repeat(40))).toBe(false);
	});

	test("truncates long rows to available width", () => {
		const theme = makeTheme() as any;
		const items = [toolItem("bash", { command: "x".repeat(120) })];
		const comp = new SubagentLiveOutputText(items, "  │ ", true, theme);
		const out = comp.render(40);
		// Unified group header + child; each width-safe.
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

describe("subagent live work-burst boundary (empty text SSOT)", () => {
	test("is_live_text_boundary mirrors the main stream boundary rule", () => {
		// Canonical rule (resolve_assistant_stream_boundary_event): bare
		// text_start and empty/whitespace-only deltas are NOT boundaries;
		// only non-empty visible text is.
		expect(is_live_text_boundary("")).toBe(false);
		expect(is_live_text_boundary("   ")).toBe(false);
		expect(is_live_text_boundary("\n 	\n")).toBe(false);
		expect(is_live_text_boundary("ok")).toBe(true);
		expect(is_live_text_boundary("\nok")).toBe(true);
	});

	test("tool -> empty text_start -> tool stays ONE unified work group, no dead rows", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem(""), // bare text_start records an empty live text block
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, toolCallId: "c2", details: { diff: "+1\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// One unified work group: a single past-tense summary header plus the
		// current-wave child. NO duplicate header, NO dead pipe-only spacer
		// row, NO blank line — the exact row shape of the main message
		// surface (header + children contiguous).
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Edited 1 file, Explored 1 file*]",
			"   [dim:\u2514\u2500][muted:*Edit*][muted: b.ts][muted:  ][muted:+1]",
		]);
		expect(stripped.some((line) => line === "" || line.trim() === "[dim:\u2502]")).toBe(false);
	});

	test("whitespace-only text blocks never split a work burst", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem("  \n 	"),
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, toolCallId: "c2", details: { diff: "+1\n" } },
			),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Edited 1 file, Explored 1 file*]",
			"   [dim:\u2514\u2500][muted:*Edit*][muted: b.ts][muted:  ][muted:+1]",
		]);
	});

	test("real non-empty text remains a hard boundary between work bursts", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem("Let me check the popover."),
			toolItem(
				"edit",
				{ file_path: "b.ts", oldText: "x", newText: "y" },
				{ completed: true, toolCallId: "c2", details: { diff: "+1\n" } },
			),
		];
		const out = new SubagentLiveOutputText(items, "  ", true, theme).render(80);
		const text = stripAnsi(out.join("\n"));
		// Single-tool bursts stay separate bare rows (no unified header), and
		// the non-empty text splits them in order.
		expect(text.indexOf("Read")).toBeLessThan(text.indexOf("Let me check"));
		expect(text.indexOf("Let me check")).toBeLessThan(text.indexOf("Edit"));
		expect(out.map(stripAnsi).filter((line) => line === "  [dim:│]").length).toBe(1);
	});
});

describe("nested tray tree composition (regression)", () => {
	test("single-tool burst still uses the unified work group with tree prefix", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
		];
		// Single-mode outer prefix "  " (the agent tool-row column).
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// All tool bursts go through the unified work-group renderer; single
		// calls get a header + one child row so the outer tree branch is
		// continuous and no standalone `•` bullet appears.
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Explored 1 file*]",
			"   [dim:\u2514\u2500][muted:*Read*][muted: a.ts]",
		]);
	});

	test("hidden in-group Thinking keeps completed children pipe-connected", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem("read", { path: "b.ts" }, { completed: true, toolCallId: "c2" }),
		];
		const out = new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1", false).render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("[dim:│][muted:*Read*]");
		expect(text).toContain("[dim:└─]Thinking");
	});

	test("visible thinking is a Markdown sibling rather than a compact tool child", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true }),
			thinkingItem("## Reasoning\n\n**Compare** the call site."),
			toolItem("edit", { file_path: "b.ts", oldText: "x", newText: "y" }, { completed: true }),
		];
		const text = stripAnsi(new SubagentLiveOutputText(items, "  ", true, theme).render(80).join("\n"));
		// The reasoning sits between the two bare tool rows (no header).
		expect(text.indexOf("Read")).toBeLessThan(text.indexOf("Reasoning"));
		expect(text.indexOf("Reasoning")).toBeLessThan(text.indexOf("Edit"));
		expect(text).not.toContain("## Reasoning");
		expect(text).not.toContain("**Compare**");
		expect(text).not.toContain("Thinking");
	});

	test("visible empty thinking markers do not create a branch-only row", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true }),
			thinkingItem(""),
			toolItem("read", { path: "b.ts" }, { completed: true }),
		];
		const out = new SubagentLiveOutputText(items, "  │", true, theme, true, "call-1").render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("Explored 2 files");
		expect(text).not.toContain("Thinking");
		expect(out.map(stripAnsi).some((line) => /\[dim:[│└]\]$/.test(line))).toBe(false);
	});

	test("trailing agent text terminates the outer gutter without fake spacers", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			textItem("Let me check the launch window."),
		];
		const out = new SubagentLiveOutputText(items, "  ", true, theme).render(80);
		const text = stripAnsi(out.join("\n"));
		expect(text).toContain("[dim:└][text:Let me check the launch window.]");
		expect(out.map(stripAnsi)).not.toContain("  [dim:│]");
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
		// No thinking lane: active child rows use `├─` / `└─` (the
		// outer branch still terminates at the burst header).
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Exploring*]",
			"   [dim:\u251c\u2500]Reading[text: a.ts]",
			"   [dim:\u2514\u2500]Reading[text: b.ts]",
		]);
	});

	test("completed prior children use pipe-only prefix; terminal child keeps └─", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem("read", { path: "b.ts" }, { completed: true, toolCallId: "c2" }),
			toolItem("read", { path: "c.ts" }, { completed: true, toolCallId: "c3" }),
		];
		const comp = new SubagentLiveOutputText(items, "  ", true, theme);
		const out = comp.render(80);
		const stripped = out.map((l) => stripAnsi(l));
		// First two completed children: pipe-only `│` (no `├` tee).
		// Last child: terminal `└─`.
		expect(stripped).toEqual([
			"  [dim:\u2514][muted:*Explored 3 files*]",
			"   [dim:\u2502][muted:*Read*][muted: a.ts]",
			"   [dim:\u2502][muted:*Read*][muted: b.ts]",
			"   [dim:\u2514\u2500][muted:*Read*][muted: c.ts]",
		]);
	});

	test("hidden Thinking lane remains terminal after completed children", () => {
		const theme = makeTheme() as any;
		const items = [
			toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" }),
			toolItem("read", { path: "b.ts" }, { completed: true, toolCallId: "c2" }),
		];
		const text = stripAnsi(
			new SubagentLiveOutputText(items, "  ", true, theme, true, "call-1", false).render(80).join("\n"),
		);
		expect(text).toContain("[dim:│][muted:*Read*]");
		expect(text).toContain("[dim:└─]Thinking");
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

describe("per-agent block spacing", () => {
	test("string layout joins member blocks with exactly one blank row", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 0), makeResult("Scout B", 0)],
			theme,
		);
		const lines = out.split("\n");
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(lines[1]).toBe("");
		expect(stripAnsi(lines[2])).toContain("Scout B");
		// Exactly one blank row — no duplicate top/trailing padding inside the call.
		expect(lines.filter((line) => line === "").length).toBe(1);
		expect(out.endsWith("\n")).toBe(false);
	});

	test("component layout inserts one Spacer between member blocks and no top/trailing padding", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 0), makeResult("Scout B", 0)],
			theme,
		);
		// agent row, spacer, agent row — exactly one blank row between blocks.
		expect(component.children.length).toBe(3);
		expect(component.children[1] instanceof Spacer).toBe(true);
		const lines = renderComponent(component).split("\n");
		expect(lines.length).toBe(3);
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(lines[1]).toBe("");
		expect(stripAnsi(lines[2])).toContain("Scout B");
	});

	test("single call renders one block with no internal blank rows", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, [makeResult("Coder A", 0)], theme);
		expect(out.split("\n").filter((line) => line === "").length).toBe(0);
		expect(stripAnsi(out)).toContain("Coder A");
	});

	test("three parallel members render three blocks with two blank rows total", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{
				tasks: [
					{ agent: "Coder", task: "a" },
					{ agent: "Scout", task: "b" },
					{ agent: "Coder", task: "c" },
				],
			},
			[makeResult("Coder A", 0), makeResult("Scout B", 0), makeResult("Coder C", 0)],
			theme,
		);
		const lines = out.split("\n");
		expect(lines.filter((line) => line === "").length).toBe(2);
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("Scout B");
		expect(stripAnsi(lines[4])).toContain("Coder C");
	});

	test("chain started steps render as direct blocks with no header and pending steps hidden", () => {
		const theme = makeTheme() as any;
		const args = {
			chain: [
				{ agent: "Scout", task: "a" },
				{ agent: "Coder", task: "b" },
				{ agent: "Coder", task: "c" },
			],
		};
		const out = renderSubagentLayout(args, [makeResult("Scout A", 0), makeResult("Coder B", 0)], theme);
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).toContain("Coder B");
		expect(stripAnsi(out)).not.toContain("Coder C");
		const lines = out.split("\n");
		expect(lines.length).toBe(3);
		expect(lines[1]).toBe("");
	});

	test("chain running step renders its own block with live nested state", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] };
		const running = makeRunning("Scout A", { isThinking: true, reasoning: true });
		const out = renderSubagentLayout(args, [running], theme);
		const lines = out.split("\n");
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(lines[0])).toContain("Scout A");
		expect(stripAnsi(lines[1])).toContain("Thinking");
		expect(stripAnsi(out)).not.toContain("Coder");
	});

	test("chain pending steps stay hidden in the component builder", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] };
		const component = buildSubagentLayoutComponent(args, [makeResult("Scout A", 0)], theme);
		const out = renderComponent(component);
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).not.toContain("Coder");
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

	test("running placeholders render per-agent blocks without a Subagents header", () => {
		const theme = makeTheme() as any;
		const placeholders = [makeResult("Scout A", -1), makeResult("Scout B", -1)];
		expect(isSubagentDelegating(placeholders)).toBe(false);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Scout", task: "b" }] },
			placeholders,
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).toContain("Scout B");
		expect(stripAnsi(out)).toContain("\u2022");
	});

	test("single parallel member renders its own block without a header", () => {
		const theme = makeTheme() as any;
		const active = makeResult("Scout A", -1);
		expect(isSubagentDelegating([active])).toBe(false);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }] },
			[active],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
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
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [], theme, 146_000, true);
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

	test("parallel mode shows elapsed on each terminal member block, never on running blocks", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] },
			[makeRunning("Scout"), makeRunning("Coder")],
			theme,
			65_000,
		);
		expect(out).not.toContain("1m 5s");

		const done = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Coder", task: "b" }] },
			[makeResult("Scout", 0), makeResult("Coder", 0)],
			theme,
			65_000,
		);
		const doneLines = done.split("\n");
		expect(doneLines[0]).toContain("[dim: 1m 5s]");
		expect(doneLines[2]).toContain("[dim: 1m 5s]");
	});

	test("single delegating row never shows an elapsed timer", () => {
		const theme = makeTheme() as any;
		const out = renderDelegatingRow(theme);
		expect(stripAnsi(out)).toContain("Delegating");
		expect(out).not.toContain("[dim: 3s]");
	});

	test("consecutive single calls show per-call elapsed next to done agents only", () => {
		const theme = makeTheme() as any;
		const done = renderSubagentLayout(
			{ agent: "Coder", task: "a" },
			[makeResult("Coder A", 0)],
			theme,
			25_000,
		);
		expect(stripAnsi(done)).toContain("Coder A");
		expect(done).toContain("[dim: 25s]");

		const running = renderSubagentLayout(
			{ agent: "Coder", task: "b" },
			[makeRunning("Coder B")],
			theme,
			25_000,
		);
		expect(stripAnsi(running)).toContain("Coder B");
		expect(running).not.toMatch(/\[dim: \d/);
	});

	test("parallel component blocks show elapsed on the done member only", () => {
		const theme = makeTheme() as any;
		const comp = buildSubagentLayoutComponent(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Coder", task: "b" }] },
			[makeResult("Coder A", 0), makeRunning("Coder B")],
			theme,
			12_500,
		);
		const lines = renderComponent(comp).split("\n");
		expect(lines.find((l) => l.includes("Coder A"))).toContain("[dim: 12s]");
		expect(lines.find((l) => l.includes("Coder B"))).not.toMatch(/\[dim: \d/);
	});

	test("parallel members each freeze at their own completion with independent timers", () => {
		const theme = makeTheme() as any;
		const original_now = performance.now;
		let now = 1_000_000;
		performance.now = () => now;
		try {
			const firstId = make_subagent_member_tool_call_id("call-parallel", 0);
			const secondId = make_subagent_member_tool_call_id("call-parallel", 1);
			markSubagentRunning(firstId);
			markSubagentRunning(secondId);
			now += 3000; // first member finishes at 3s
			markSubagentTerminal(firstId);
			const firstDone = makeResult("Scout G", 0);
			firstDone.toolCallId = firstId;
			const secondRunning = makeRunning("Scout H", { isThinking: false });
			secondRunning.toolCallId = secondId;
			const args = { tasks: [{ agent: "Scout", task: "a" }, { agent: "Scout", task: "b" }] };
			const out = renderSubagentLayout(args, [firstDone, secondRunning], theme);
			const lines = out.split("\n");
			expect(stripAnsi(lines[0])).toContain("Scout G");
			expect(stripAnsi(lines[0])).toContain("[dim: 3s]");
			expect(stripAnsi(lines[2])).toContain("Scout H");
			expect(stripAnsi(lines[2])).not.toMatch(/\[dim: \d/);
			// Time keeps advancing for the still-running member only.
			now += 4000; // second member finishes at 7s
			markSubagentTerminal(secondId);
			const secondDone = makeResult("Scout H", 0);
			secondDone.toolCallId = secondId;
			const out2 = renderSubagentLayout(args, [firstDone, secondDone], theme);
			const lines2 = out2.split("\n");
			expect(stripAnsi(lines2[0])).toContain("Scout G");
			expect(stripAnsi(lines2[0])).toContain("[dim: 3s]");
			expect(stripAnsi(lines2[2])).toContain("Scout H");
			expect(stripAnsi(lines2[2])).toContain("[dim: 7s]");
		} finally {
			performance.now = original_now;
			clearSubagentTiming();
		}
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
			// Single-mode rows use the flush `  └` prefix (no trailing space),
			// so the Thinking lane renders `  └Thinking` with the dim elapsed
			// suffix from the armed SSOT thinking-pass timer.
			const out = renderSubagentThinkingRow(theme, "  \u2514", id);
			// The fake theme wraps the prefix in one tag: `[dim:  └]` followed
			// immediately by the gradient Thinking label proves the flush
			// single-mode prefix (no trailing space inside the tag).
			expect(stripAnsi(out)).toContain("[dim:  \u2514]Thinking");
			expect(stripAnsi(out)).not.toContain("[dim:  \u2514 ]Thinking");
			expect(stripAnsi(out)).toContain("Thinking");
			expect(out).toContain("[dim: 2s]");
		} finally {
			performance.now = original_now;
			clear_subagent_thinking_pass(id);
		}
	});

	test("hidden tray Thinking lane renders the armed SSOT thinking elapsed suffix", () => {
		const theme = makeTheme() as any;
		const id = "call-tray-thinking";
		const original_now = performance.now;
		let now = 1_000_000;
		performance.now = () => now;
		try {
			arm_subagent_thinking_pass(id);
			now += 1500;
			const items = [toolItem("read", { path: "a.ts" }, { completed: true, toolCallId: "c1" })];
			const out = new SubagentLiveOutputText(items, "  ", true, theme, true, id, false).render(80);
			expect(stripAnsi(out[out.length - 1])).toContain("Thinking");
			expect(out[out.length - 1]).toContain("[dim: 1s]");
		} finally {
			performance.now = original_now;
			clear_subagent_thinking_pass(id);
		}
	});

	test("consecutive single calls each render their own block with no shared header", () => {
		const theme = makeTheme() as any;
		const first = renderSubagentLayout({ agent: "Coder", task: "a" }, [makeRunning("Coder A")], theme);
		const second = renderSubagentLayout({ agent: "Coder", task: "b" }, [makeRunning("Coder B")], theme);
		const third = renderSubagentLayout({ agent: "Coder", task: "c" }, [makeRunning("Coder C")], theme);
		for (const out of [first, second, third]) {
			expect(stripAnsi(out)).not.toContain("Subagents");
			expect(stripAnsi(out)).not.toContain("Delegating");
		}
		expect(stripAnsi(first)).toContain("Coder A");
		expect(stripAnsi(second)).toContain("Coder B");
		expect(stripAnsi(third)).toContain("Coder C");
	});

	test("a single-mode call with no results yet shows one gradient Delegating row", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "a" }, [], theme);
		const output = stripAnsi(out);
		expect(output.split("Delegating").length - 1).toBe(1);
		expect(output).toContain("\u2022");
		expect(out).toContain("\u001b[38;2;");
	});

	test("unrecognized streaming args render Delegating, never bare subagent text", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({}, [], theme);
		const output = stripAnsi(out);
		expect(output.split("Delegating").length - 1).toBe(1);
		expect(output).not.toContain("subagent");
	});

	test("settled parallel members render static per-agent blocks (no gradient, no header)", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 0), makeResult("Scout B", 0)],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(out).not.toContain("\u001b[38;2;");
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout B");
	});

	test("completed parallel blocks carry success green bullets (no header)", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 0), makeResult("Scout B", 0)],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
		const lines = out.split("\n");
		expect(lines[0]).toContain("[success:\u2022 ]");
		expect(lines[0]).not.toContain("[muted:\u2022 ]");
		expect(lines[2]).toContain("[success:\u2022 ]");
	});

	test("failed parallel block carries the error red bullet, sibling stays success", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 1, true), makeResult("Scout B", 0)],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
		const lines = out.split("\n");
		expect(lines[0]).toContain("[error:\u2022 ]");
		expect(lines[0]).not.toContain("[muted:\u2022 ]");
		expect(lines[0]).not.toContain("[success:\u2022 ]");
		expect(lines[2]).toContain("[success:\u2022 ]");
	});

	test("running parallel block bullet stays muted while a sibling completed", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[makeResult("Coder A", 0), makeRunning("Scout B")],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
		const lines = out.split("\n");
		expect(lines[0]).toContain("[success:\u2022 ]");
		const runningLine = lines.find((l) => stripAnsi(l).includes("Scout B"));
		expect(runningLine).toContain("[muted:\u2022 ]");
		expect(runningLine).not.toContain("[success:\u2022 ]");
		expect(runningLine).not.toContain("[error:\u2022 ]");
	});

	test("tool-level failures keep each diagnostic on its own block", () => {
		const theme = makeTheme() as any;
		const a = renderSubagentLayout({ agent: "Coder", task: "a" }, [], theme, undefined, true, "401 Unauthorized");
		const b = renderSubagentLayout({ agent: "Coder", task: "b" }, [], theme, undefined, true, "503 Service Unavailable");
		expect(stripAnsi(a)).toContain("Coder");
		expect(stripAnsi(a)).toContain("401 Unauthorized");
		expect(stripAnsi(a)).not.toContain("503");
		expect(stripAnsi(b)).toContain("Coder");
		expect(stripAnsi(b)).toContain("503 Service Unavailable");
		expect(stripAnsi(b)).not.toContain("401");
	});

	test("parallel block for the running member shows Thinking after a sibling completes", () => {
		const theme = makeTheme() as any;
		const completed = makeResult("Coder A", 0);
		const thinking = makeRunning("Scout B", { isThinking: true, reasoning: true });
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[completed, thinking],
			theme,
		);
		const lines = out.split("\n");
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("Scout B");
		expect(stripAnsi(lines[3])).toContain("Thinking");
	});

	test("parallel running member shows its nested tool row", () => {
		const theme = makeTheme() as any;
		const completed = makeResult("Coder A", 0);
		const withTool = makeRunning("Scout B", { isThinking: false, reasoning: true });
		withTool.latestToolCall = { name: "read", args: { path: "src/foo.ts" } };
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] },
			[completed, withTool],
			theme,
		);
		expect(stripAnsi(out)).not.toContain("Subagents");
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

	test("single-mode tool row prefix is flush: `  └Read …` with no gap", () => {
		const theme = makeTheme() as any;
		const running = makeResult("Coder", -1);
		running.latestToolCall = { name: "read", args: { path: "a.ts" } };
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [running], theme);
		const toolLine = out.split("\n")[1];
		// Single-mode child rows use the flush `  └` prefix: the fake theme
		// wraps the whole prefix in one tag, so the └ is the last char inside
		// the tag (no trailing space) and the body sits flush against it.
		expect(stripAnsi(toolLine).startsWith("[dim:  \u2514]")).toBe(true);
		expect(stripAnsi(toolLine)).not.toContain("[dim:  \u2514 ]");
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

	test("completed single mode uses success green bullet and dim agent name", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 0)], theme);
		const line = stripAnsi(out);
		expect(line).toContain("Coder");
		expect(out).toContain("[dim:Coder]");
		// Completed single rows carry the canonical success bullet (SSOT
		// statusBulletColor) — green, not muted.
		expect(out).toContain("[success:\u2022 ]");
		expect(out).not.toContain("[muted:\u2022 ]");
		expect(line).toContain("\u2022");
		expect(line.indexOf("Coder")).toBeLessThan(line.indexOf("\u2713"));
		expect(line.trimStart().startsWith("\u2713")).toBe(false);
		expect(out).not.toContain("\u001b[38;2;");
	});

	test("failed single mode uses error red bullet and trailing x", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 1, true)], theme);
		const line = stripAnsi(out);
		expect(line).toContain("Coder");
		// Failed single rows carry the canonical error bullet (SSOT
		// statusBulletColor) — red, not muted.
		expect(out).toContain("[error:\u2022 ]");
		expect(out).not.toContain("[muted:\u2022 ]");
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

	test("compact row retains the parser-stream failure, clipped to the existing 60-char rule", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Scout A", 1, true);
		result.errorMessage = "Stream ended without finish_reason";
		const out = renderSubagentLayout({ agent: "Scout", task: "do stuff" }, [result], theme);
		const stripped = stripAnsi(out);
		// The exact parser failure is retained (never replaced by a generic
		// fallback), clipped with the ellipsis per the compact-row convention.
		expect(stripped).toContain("Stream ended without finish_reason");
		expect(stripped).toContain("...");
		expect(stripped).not.toContain("Subagent failed");
	});

	test("expanded view shows the full annotated parser-stream reason", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Scout A", 1, true);
		result.errorMessage = "Stream ended without finish_reason";
		result.messages = [
			{ role: "assistant", content: [{ type: "text", text: "..." }] },
		];
		const component = renderSubagentExpanded({ mode: "single", results: [result] }, theme);
		const stripped = stripAnsi(renderComponent(component!));
		// The expanded view keeps the FULL reason including the explicit
		// limitation note so the failure is diagnosable.
		expect(stripped).toContain("Stream ended without finish_reason");
		expect(stripped).toContain("no underlying error was reported");
		expect(stripped).toContain("check provider status");
	});

	test("tool-level failure is shown when no per-agent result was persisted", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout(
			{ agent: "Coder A", task: "do stuff" },
			[],
			theme,
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
		// Per-agent blocks have no header: the agent name and its nested └ both
		// start at column 2 (bullet-width indent). The TREE_* constants below
		// stay SSOT for the compact renderer's grouped trees and the subagent
		// live tray, which still branch at the deeper columns they encode.
		expect(TREE_BRANCH_TEE.length).toBe(2);
		expect(TREE_NESTED_PIPE.indexOf("\u2514")).toBe(3);
		expect(TREE_NESTED_LAST.indexOf("\u2514")).toBe(3);
		expect(BULLET.length).toBe(2);
		expect(TREE_SINGLE_TOOL.indexOf("\u2514")).toBe(2);
	});

	test("running parallel mode renders two direct agent blocks with nested tool rows", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const coderRunning = makeResult("Coder A", -1);
		coderRunning.latestToolCall = { name: "grep", args: { pattern: "auth", path: "." } };
		const scoutRunning = makeResult("Scout A", -1);
		scoutRunning.latestToolCall = { name: "read", args: { path: "README.md" } };
		const out = renderSubagentLayout(args, [coderRunning, scoutRunning], theme);
		const lines = out.split("\n");
		// block 1 (bullet + nested tool), blank, block 2 (bullet + nested tool)
		expect(lines.length).toBe(5);
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(lines[0])).toContain("\u2022");
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(stripAnsi(lines[1])).toContain("  \u2514");
		expect(stripAnsi(lines[1])).toContain("Search");
		expect(lines[2]).toBe("");
		expect(stripAnsi(lines[3])).toContain("\u2022");
		expect(stripAnsi(lines[3])).toContain("Scout A");
		expect(stripAnsi(lines[4])).toContain("  \u2514");
		expect(stripAnsi(lines[4])).toContain("Read");
	});

	test("parallel mode renders per-agent blocks with no group header", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const out = renderSubagentLayout(args, [makeRunning("Coder A"), makeRunning("Scout A")], theme);
		const lines = out.split("\n");
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(stripAnsi(lines[0])).toContain("\u2022");
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(stripAnsi(lines[1])).toContain("Thinking");
		expect(lines[2]).toBe("");
		expect(stripAnsi(lines[3])).toContain("\u2022");
		expect(stripAnsi(lines[3])).toContain("Scout A");
		expect(stripAnsi(lines[4])).toContain("Thinking");
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("parallel");
		expect(out).not.toContain("[user]");
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

	test("parallel blocks are transparent (no subagentBg, no header)", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeRunning("Coder A"), makeRunning("Scout A")],
			theme,
		);
		const out = renderComponent(component);
		const lines = out.split("\n");
		expect(stripAnsi(out)).not.toContain("Subagents");
		expect(lines[0]).not.toContain("[bg:subagentBg:");
		expect(lines[3]).not.toContain("[bg:subagentBg:");
	});

	test("mixed parallel: running and completed blocks are both transparent", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", -1), makeResult("Scout A", 0)],
			theme,
		);
		const out = renderComponent(component);
		const lines = out.split("\n");
		expect(stripAnsi(out)).not.toContain("Subagents");
		// Running block: muted bullet + text-color name (transparent).
		expect(stripAnsi(lines[0])).toContain("Coder A");
		expect(lines[0]).not.toContain("[bg:subagentBg:");
		expect(lines[0]).toContain("[text:Coder A]");
		expect(lines[0]).toContain("[muted:\u2022 ]");
		// One blank row between the two blocks.
		expect(lines[1]).toBe("");
		// Completed block: success bullet + dim name (transparent).
		const scoutLine = lines.find((l) => stripAnsi(l).includes("Scout A"));
		expect(scoutLine).toBeDefined();
		expect(scoutLine).not.toContain("[bg:subagentBg:");
		expect(scoutLine).toContain("[dim:Scout A]");
		expect(scoutLine).toContain("[success:\u2022 ]");
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

	test("visible child thinking mounts the tray without a tool", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [thinkingItem("No tool has run yet.")];
		result.latestToolCall = undefined;
		result.isThinking = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			undefined,
			undefined,
			true,
		);
		const text = stripAnsi(renderComponent(component));
		expect(text).toContain("No tool has run yet.");
		expect(text).not.toContain("Delegating");
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
			false,
			undefined,
			undefined,
			true,
		);
		const out = renderComponent(component);
		const text = stripAnsi(out);
		expect(text).toContain("Fixing the launch window.");
		// A single edit renders as the bare standalone row (no `Edited 1 file`
		// header) below the streamed message, with the accumulated diff stats.
		expect(text).toContain("Edit");
		expect(text).toContain("LaunchWindow.tsx");
		// (The fake theme's literal tags count toward truncateToWidth's width,
		// so the trailing +1 -1 stats truncate here — a test-only artifact;
		// the real ANSI theme fits the full row.)
		expect(text.indexOf("Fixing the launch window.")).toBeLessThan(text.indexOf("Edit"));
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
			false,
			undefined,
			undefined,
			false,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).not.toContain("secret.ts");
	});

	test("hidden child thinking keeps the compact Thinking lane inside its work group", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [
			textItem("hidden child narration"),
			toolItem("read", { path: "src/a.ts" }, { completed: true }),
			toolItem("read", { path: "src/b.ts" }, { completed: true }),
		];
		result.latestToolCall = undefined;
		result.isThinking = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			"hidden-thinking-call",
			undefined,
			false,
		);
		const text = stripAnsi(renderComponent(component));
		expect(text).toContain("Explored 2 files");
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).toContain("Thinking");
		expect(text).not.toContain("hidden child narration");
		// Completed rows are the shared bare-pipe style: their body starts
		// immediately after `│`, without the live connector-width pad.
		expect(text).toContain("[dim:\u2502][muted:*Read*]");
		expect(text).toContain("[dim:\u2514\u2500]Thinking");
	});

	test("hidden child narration still splits compact work bursts", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [
			toolItem("read", { path: "src/first.ts" }, { completed: true }),
			textItem("hidden boundary"),
			toolItem("read", { path: "src/second.ts" }, { completed: true }),
		];
		result.latestToolCall = undefined;
		result.isThinking = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			"hidden-thinking-boundary",
			undefined,
			false,
		);
		const text = stripAnsi(renderComponent(component));
		expect(text).not.toContain("hidden boundary");
		// Hidden narration splits the compact work burst, so each side becomes
		// its own unified work group.
		expect(text).toContain("first.ts");
		expect(text).toContain("second.ts");
		expect(text).toContain("Explored");
		expect(text).toContain("Thinking");
	});

	test("hidden finishing suppresses every retained child tray row", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [
			toolItem("read", { path: "src/a.ts" }, { completed: true }),
			thinkingItem("private child reasoning"),
			textItem("streamed child narration"),
		];
		result.latestToolCall = { name: "read", args: { path: "src/a.ts" } };
		result.isThinking = false;
		result.isFinishing = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			undefined,
			undefined,
			false,
		);
		const tray = renderComponent(component).split("\n").slice(1).map(stripAnsi);
		expect(tray).toEqual(["[dim:  ] [dim:└─]Finishing"]);
		expect(tray.join("\n")).not.toContain("src/a.ts");
		expect(tray.join("\n")).not.toContain("reasoning");
		expect(tray.join("\n")).not.toContain("narration");
	});

	test("hidden finishing mounts the nested tray without live items", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = undefined;
		result.latestToolCall = undefined;
		result.isThinking = false;
		result.isFinishing = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			undefined,
			undefined,
			false,
		);
		const text = stripAnsi(renderComponent(component));
		expect(text).toContain("Finishing");
		expect((text.match(/Finishing/g) ?? []).length).toBe(1);
	});

	test("visible parent thinking blocks never render Finishing", () => {
		const theme = makeTheme() as any;
		const result = makeRunning("Coder");
		result.liveItems = [toolItem("read", { path: "src/a.ts" }, { completed: true })];
		result.isThinking = false;
		result.isFinishing = true;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[result],
			theme,
			undefined,
			false,
			undefined,
			undefined,
			true,
		);
		const text = stripAnsi(renderComponent(component));
		expect(text).toContain("Read");
		expect(text).toContain("src/a.ts");
		expect(text).not.toContain("Finishing");
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
