import { describe, expect, mock, test } from "bun:test";
import { renderSubagentLayout, anySubagentRunning, SubagentCapLine } from "../render.ts";

function makeTheme() {
	const fg = mock((tag: string, text: string) => `[${tag}:${text}]`);
	return {
		fg,
		bold: mock((s: string) => `*${s}*`),
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

describe("SubagentCapLine", () => {
	test("renders exactly the current width and disappears when hidden", () => {
		let visible = true;
		const cap = new SubagentCapLine(() => visible, (_color, text) => text);

		expect(cap.render(37)).toEqual(["\u2500".repeat(37)]);
		expect(cap.render(241)).toEqual(["\u2500".repeat(241)]);

		visible = false;
		expect(cap.render(80)).toEqual([]);
	});
});

describe("renderSubagentLayout", () => {
	test("running single mode uses the Thinking gradient without a bullet", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "coder", task: "do stuff" }, [], theme);
		expect(stripAnsi(out)).toContain("coder");
		expect(out).toContain("\u001b[38;2;");
		expect(stripAnsi(out)).not.toContain("\u2022");
		expect(out).not.toContain("\u2713");
		expect(out).not.toContain("\u2717");
		expect(out).not.toContain("subagent");
		expect(out).not.toContain("[user]");
		expect(out).not.toContain("\u23f3");
	});

	test("completed single mode shows checkmark", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "coder", task: "do stuff" }, [makeResult("coder", 0)], theme);
		expect(stripAnsi(out)).toContain("coder");
		expect(stripAnsi(out)).toContain("\u2713");
		expect(stripAnsi(out)).not.toContain("\u2717");
		expect(out).not.toContain("\u001b[38;2;");
		expect(stripAnsi(out)).not.toContain("\u2022");
	});

	test("failed single mode shows X mark", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "coder", task: "do stuff" }, [makeResult("coder", 1, true)], theme);
		expect(stripAnsi(out)).toContain("coder");
		expect(stripAnsi(out)).toContain("\u2717");
		expect(stripAnsi(out)).not.toContain("\u2713");
		expect(out).not.toContain("\u001b[38;2;");
		expect(stripAnsi(out)).not.toContain("\u2022");
	});

	test("failed single mode includes inline error text", () => {
		const theme = makeTheme() as any;
		const result = makeResult("coder", 1, true);
		result.errorMessage = "timeout during read";
		const out = renderSubagentLayout({ agent: "coder", task: "do stuff" }, [result], theme);
		expect(stripAnsi(out)).toContain("timeout during read");
	});

	test("completed single mode does not include error text", () => {
		const theme = makeTheme() as any;
		const out = renderSubagentLayout({ agent: "coder", task: "do stuff" }, [makeResult("coder", 0)], theme);
		expect(stripAnsi(out)).not.toContain("error");
		expect(stripAnsi(out)).not.toContain("Error");
	});

	test("failed parallel mode shows inline error only on failed child", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "coder", task: "a" }, { agent: "scout", task: "b" }] };
		const failed = makeResult("coder", 1, true);
		failed.errorMessage = "could not read file";
		const out = renderSubagentLayout(args, [failed, makeResult("scout", 0)], theme);
		const output = stripAnsi(out);
		expect(output).toContain("coder");
		expect(output).toContain("scout");
		expect(output).toContain("could not read file");
		const matches = output.split("could not read file").length - 1;
		expect(matches).toBe(1);
	});

	test("parallel mode shows plain Subagents header with children", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "coder", task: "a" }, { agent: "scout", task: "b" }] };
		const out = renderSubagentLayout(args, [], theme);
		const lines = out.split("\n");
		const header = lines[0];
		expect(stripAnsi(header)).toContain("Subagents");
		expect(header).not.toContain("\u001b[38;2;");
		expect(stripAnsi(out)).toContain("coder");
		expect(stripAnsi(out)).toContain("scout");
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("parallel");
		expect(out).not.toContain("[user]");
		expect(stripAnsi(out)).not.toContain("\u2022");
	});

	test("chain mode only shows started steps", () => {
		const theme = makeTheme() as any;
		const args = { chain: [{ agent: "scout", task: "a" }, { agent: "coder", task: "b" }] };
		const out = renderSubagentLayout(args, [makeResult("scout", 0)], theme);
		expect(out).toContain("scout");
		expect(out).not.toContain("coder");
	});

	test("no hourglass glyphs anywhere", () => {
		const theme = makeTheme() as any;
		const args = { tasks: [{ agent: "coder", task: "a" }] };
		const out = renderSubagentLayout(args, [makeResult("coder", -1)], theme);
		expect(out).not.toContain("\u23f3");
		expect(out).not.toContain("\u25d0");
	});

	test("anySubagentRunning true when exitCode is -1", () => {
		const args = { tasks: [{ agent: "coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("coder", -1)])).toBe(true);
	});

	test("anySubagentRunning false when all done", () => {
		const args = { tasks: [{ agent: "coder", task: "a" }] };
		expect(anySubagentRunning(args, [makeResult("coder", 0)])).toBe(false);
	});
});
