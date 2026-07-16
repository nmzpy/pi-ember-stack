import { describe, expect, mock, test } from "bun:test";
import {
	renderSubagentLayout,
	buildSubagentLayoutComponent,
	anySubagentRunning,
	isSubagentDelegating,
	renderDelegatingRow,
	SubagentToolText,
	renderSubagentExpanded,
} from "../render.ts";
import {
	BULLET,
	TREE_BRANCH_LAST,
	TREE_BRANCH_TEE,
	TREE_NESTED_LAST,
	TREE_NESTED_PIPE,
	TREE_SINGLE_TOOL,
} from "../../../../pi-compact-tools/renderer.ts";
import { set_gradient_colorizer, reset_gradient_colorizer, type Rgb } from "../../../../pi-ember-ui/gradient.ts";

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

function makeRunning(agent: string): any {
	const r = makeResult(agent, -1);
	r.messages = [{ role: "assistant", content: [{ type: "text", text: "..." }] }];
	return r;
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

	test("running placeholders without activity stay on Delegating", () => {
		const theme = makeTheme() as any;
		const placeholders = [makeResult("Scout A", -1), makeResult("Scout B", -1)];
		expect(isSubagentDelegating(placeholders)).toBe(true);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }, { agent: "Scout", task: "b" }] },
			placeholders,
			theme,
		);
		expect(stripAnsi(out)).toContain("Delegating");
		expect(stripAnsi(out)).toContain("\u2022");
		expect(out).toContain("\u001b[38;2;");
	});

	test("first subagent tool call leaves delegating for the agent tree", () => {
		const theme = makeTheme() as any;
		const active = makeResult("Scout A", -1);
		active.latestToolCall = { name: "read", args: { path: "README.md" } };
		expect(isSubagentDelegating([active])).toBe(false);
		const out = renderSubagentLayout(
			{ tasks: [{ agent: "Scout", task: "a" }] },
			[active],
			theme,
		);
		expect(stripAnsi(out)).toContain("Subagents");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(stripAnsi(out)).toContain("Read");
	});
});

describe("renderSubagentLayout (string)", () => {
	test("running single mode uses compact bullet plus muted group gradient", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeRunning("Coder")], theme);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).toContain("\u001b[38;2;");
		expect(stripAnsi(out)).toContain("\u2022");
		expect(out).not.toContain("\u2713");
		expect(out).not.toContain("\u2717");
		expect(out).not.toContain("subagent");
		expect(out).not.toContain("[user]");
		expect(out).not.toContain("\u23f3");
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
		expect(stripAnsi(lines[1])).toContain("  \u2514");
		expect(stripAnsi(lines[1])).toContain("Read");
		expect(stripAnsi(lines[1])).toContain("plugins/render.ts");
	});

	test("completed single mode uses muted bullet and trailing checkmark", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "Coder", task: "do stuff" }, [makeResult("Coder", 0)], theme);
		const line = stripAnsi(out);
		expect(line).toContain("Coder");
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
		// Agent names start at column 4; nested └ must land there too.
		expect(TREE_BRANCH_TEE.length).toBe(4);
		expect(TREE_NESTED_PIPE.indexOf("\u2514")).toBe(4);
		expect(TREE_NESTED_LAST.indexOf("\u2514")).toBe(4);
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
		expect(stripAnsi(lines[1])).toContain("  \u251c ");
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("  \u2502 \u2514");
		expect(stripAnsi(lines[2])).toContain("Search");
		expect(stripAnsi(lines[3])).toContain("  \u2514 ");
		expect(stripAnsi(lines[3])).toContain("Scout A");
		expect(stripAnsi(lines[4])).toContain("    \u2514");
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
		expect(stripAnsi(lines[1])).toContain("  \u251c ");
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(stripAnsi(lines[2])).toContain("  \u2514 ");
		expect(stripAnsi(lines[2])).toContain("Scout A");
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

	test("anySubagentRunning true when exitCode is -1", () => {
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("Coder A", -1)])).toBe(true);
	});

	test("anySubagentRunning false when all done", () => {
		const args = { tasks: [{ agent: "Coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("Coder A", 0)])).toBe(false);
	});
});

describe("buildSubagentLayoutComponent (per-row backgrounds)", () => {
	test("running single mode has no subagentBg background", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent({ agent: "Coder", task: "do stuff" }, [makeRunning("Coder")], theme);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).not.toContain("[bg:subagentBg:");
	});

	test("completed single mode gets a subagentBg Box", () => {
		const theme = makeTheme() as any;
		const component = buildSubagentLayoutComponent(
			{ agent: "Coder", task: "do stuff" },
			[makeResult("Coder", 0)],
			theme,
		);
		const out = renderComponent(component);
		expect(stripAnsi(out)).toContain("Coder");
		expect(out).toContain("[bg:subagentBg:");
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

	test("mixed parallel: running row transparent, completed row has subagentBg", () => {
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
		// Line 1: Coder A running (transparent, gradient)
		// Line 2+: Scout A completed (subagentBg)
		expect(stripAnsi(lines[1])).toContain("Coder A");
		expect(lines[1]).not.toContain("[bg:subagentBg:");
		expect(lines[1]).toContain("\u001b[38;2;");
		// Scout A completed row should have subagentBg
		const scoutLine = lines.find((l) => stripAnsi(l).includes("Scout A"));
		expect(scoutLine).toBeDefined();
		expect(scoutLine).toContain("[bg:subagentBg:");
	});

	test("all completed parallel: each row gets its own subagentBg", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "Coder", task: "a" }, { agent: "Scout", task: "b" }] };
		const component = buildSubagentLayoutComponent(
			args,
			[makeResult("Coder A", 0), makeResult("Scout A", 0)],
			theme,
		);
		const out = renderComponent(component);
		// Both completed rows should have subagentBg backgrounds.
		expect(out).toContain("[bg:subagentBg:");
		// Verify both agent names are present
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout A");
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

	test("chain mode: only started steps appear, completed gets subagentBg", () => {
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
		expect(out).toContain("[bg:subagentBg:");
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
	test("single mode wraps in one subagentBg Box", () => {
		const theme = makeTheme() as any;
		const result = makeResult("Coder", 0);
		result.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
		const component = renderSubagentExpanded(
			{ mode: "single", results: [result] },
			theme,
		);
		expect(component).toBeDefined();
		const out = renderComponent(component!);
		expect(out).toContain("[bg:subagentBg:");
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

	test("parallel mode: each agent section gets its own subagentBg Box (no aggregate outer box)", () => {
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
		// Both agent names should appear within subagentBg-tinted sections.
		expect(stripAnsi(out)).toContain("Coder A");
		expect(stripAnsi(out)).toContain("Scout A");
		expect(out).toContain("[bg:subagentBg:");
		// Verify both agents' content is present
		expect(stripAnsi(out)).toContain("result1");
		expect(stripAnsi(out)).toContain("result2");
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
		// Only the completed Scout section should be tinted, not the failed Coder.
		expect(out).toContain("[bg:subagentBg:");
		const scoutLine = out.split("\n").find((l) => stripAnsi(l).includes("Scout A"));
		expect(scoutLine).toBeDefined();
		expect(scoutLine).toContain("[bg:subagentBg:");
		const coderLine = out.split("\n").find((l) => stripAnsi(l).includes("Coder A"));
		expect(coderLine).toBeDefined();
		expect(coderLine).not.toContain("[bg:subagentBg:");
	});
});
