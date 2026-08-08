import { describe, expect, test, beforeEach } from "bun:test";
import {
	bash_execution_content_pad_cols,
	fit_terminal_content_line,
	format_ember_bash_transcript_lines,
	shell_aware_editor_border_hex,
	shell_aware_editor_inner_pad,
} from "../index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	MUTED_COLOR,
	PAGE_BG,
	TEXT_COLOR,
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

	test("format_ember_bash_transcript_lines indents content while running", () => {
		const width = 30;
		const raw = [ruleLine(28), "header", ruleLine(28), "output line"];
		const running = format_ember_bash_transcript_lines(raw, width, true)[1];
		const stripped = running.replace(/\x1b\[[0-9;]*m/g, "");

		expect(stripped.startsWith(" ".repeat(bash_execution_content_pad_cols() - 2))).toBe(true);
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
