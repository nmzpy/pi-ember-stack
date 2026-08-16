import { describe, expect, test, beforeEach } from "bun:test";
import {
	bash_execution_content_pad_cols,
	fit_terminal_content_line,
	format_ember_bash_transcript_lines,
	shell_aware_editor_border_hex,
	shell_aware_editor_inner_pad,
} from "../index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	MUTED_COLOR,
	PAGE_BG,
	TEXT_COLOR,
	buildThemeBgColors,
	buildThemeFgColors,
	isUserBashRunning,
	setUserBashRunning,
} from "../mode-colors.ts";

function ruleLine(width: number): string {
	return "\u2500".repeat(width);
}

describe("user bash integrated UI helpers", () => {
	beforeEach(() => {
		setUserBashRunning(false);
	});

	test("shell_aware_editor_inner_pad adds one column while bash runs", () => {
		expect(shell_aware_editor_inner_pad()).toBe(0);
		setUserBashRunning(true);
		expect(shell_aware_editor_inner_pad()).toBe(1);
	});

	test("shell_aware_editor_border_hex blends toward page bg while bash runs", () => {
		const idle = shell_aware_editor_border_hex();
		setUserBashRunning(true);
		const running = shell_aware_editor_border_hex();
		expect(running).not.toBe(idle);
		expect(running).not.toBe(TEXT_COLOR);
		expect(running).not.toBe(MUTED_COLOR);
		expect(running.toLowerCase()).toBe(running);
		expect(PAGE_BG.toLowerCase()).toBe(PAGE_BG);
	});

	test("bash_execution_content_pad_cols matches editor body offset while running", () => {
		setUserBashRunning(true);
		expect(bash_execution_content_pad_cols()).toBe(shell_aware_editor_inner_pad() + 2);
	});

	test("format_ember_bash_transcript_lines drops all horizontal rules and draws a pipe tree", () => {
		const width = 40;
		const raw = [ruleLine(38), "$ bash foo", ruleLine(38), "output"];
		const running = format_ember_bash_transcript_lines(raw, width, true);

		expect(running.filter((line) => line.includes("\u2500"))).toHaveLength(0);
		expect(running.some((line) => line.includes("$ bash foo"))).toBe(true);
		expect(running[running.length - 1]?.includes("\u2514")).toBe(true);
	});

	test("format_ember_bash_transcript_lines places the branch pipe at column 2", () => {
		const width = 30;
		const raw = [ruleLine(28), "header", ruleLine(28), "output one", "output two"];
		const rows = format_ember_bash_transcript_lines(raw, width, true);
		const pipe = rows[1]?.replace(/\x1b\[[0-9;]*m/g, "");
		const last = rows[2]?.replace(/\x1b\[[0-9;]*m/g, "");

		// `• ` occupies columns 0-1, so the `│`/`└` sits below the `R` of `Ran`.
		expect(pipe?.indexOf("\u2502")).toBe(2);
		expect(last?.indexOf("\u2514")).toBe(2);
	});

	test("format_ember_bash_transcript_lines skips the stock Spacer and keeps the header flush", () => {
		const width = 40;
		const raw = ["", ruleLine(38), " • Ran foo", ruleLine(38), "output"];
		const rows = format_ember_bash_transcript_lines(raw, width, false);
		const header = rows[0]?.replace(/\x1b\[[0-9;]*m/g, "");

		// The leading Spacer row is dropped, so the header is the first row,
		// the stock Text paddingX=1 margin is stripped, and it carries no branch.
		expect(header).toBe("• Ran foo");
		expect(rows[1]?.includes("\u2514")).toBe(true);
	});

	test("format_ember_bash_transcript_lines wraps rows in userMessageBg when a theme is supplied", () => {
		const width = 40;
		const theme = new Theme(
			buildThemeFgColors(MUTED_COLOR),
			buildThemeBgColors(MUTED_COLOR),
			"truecolor",
			{ name: "test" },
		);
		const raw = ["", ruleLine(38), " • Ran foo", ruleLine(38), "output"];
		const rows = format_ember_bash_transcript_lines(raw, width, false, theme);

		expect(rows.length).toBe(4);
		for (const row of rows) {
			// One blank bg row above and below, content rows padded to full width.
			expect(visibleWidth(row)).toBe(width);
			expect(row.startsWith("\x1b[48;2;")).toBe(true);
			expect(row.endsWith("\x1b[49m")).toBe(true);
		}
	});

	test("isUserBashRunning tracks lifecycle flag", () => {
		expect(isUserBashRunning()).toBe(false);
		setUserBashRunning(true);
		expect(isUserBashRunning()).toBe(true);
		setUserBashRunning(false);
		expect(isUserBashRunning()).toBe(false);
	});

	test("fit_terminal_content_line does not pad short rows", () => {
		const line = fit_terminal_content_line("hello", 80);
		expect(visibleWidth(line)).toBe(5);
	});

	test("format_ember_bash_transcript_lines does not pad content to full width", () => {
		const width = 80;
		const raw = [ruleLine(78), "header", ruleLine(78), "short output"];
		const row = format_ember_bash_transcript_lines(raw, width, false)[1];
		expect(visibleWidth(row)).toBeLessThan(width);
	});
});
