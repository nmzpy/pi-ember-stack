import { describe, expect, test } from "bun:test";
import {
	cursor_status_is_authenticated,
	parse_cursor_models_output,
	resolve_cursor_agent_executable,
} from "../src/cli.ts";

describe("Cursor CLI integration", () => {
	test("parses model output with selection markers and ANSI", () => {
		const models = parse_cursor_models_output(
			"\u001b[32m* auto - Auto (default)\u001b[0m\n  - composer-2 - Composer 2\n✓ sonnet-4.6-thinking - Claude Sonnet 4.6 Thinking (current)\n",
		);
		expect(models).toEqual([
			{ id: "auto", name: "Auto" },
			{ id: "composer-2", name: "Composer 2" },
			{ id: "sonnet-4.6-thinking", name: "Claude Sonnet 4.6 Thinking" },
		]);
	});

	test("discovers no models when CLI output is empty", () => {
		expect(parse_cursor_models_output("")).toEqual([]);
	});

	test("deduplicates discovered model ids", () => {
		expect(parse_cursor_models_output("auto - Auto\nauto - Auto duplicate")).toEqual([
			{ id: "auto", name: "Auto" },
		]);
	});

	test("never falls back to the ambiguous agent command", () => {
		const executable = resolve_cursor_agent_executable({}, "linux", () => false, "/home/test");
		expect(executable).toBe("cursor-agent");
	});

	test("resolves the known Windows Cursor shim", () => {
		const expected = "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.cmd";
		const executable = resolve_cursor_agent_executable(
			{ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
			"win32",
			(path) => path === expected,
			"C:\\Users\\test",
		);
		expect(executable).toBe(expected);
	});

	test("recognizes authenticated and unauthenticated status text", () => {
		expect(cursor_status_is_authenticated("Authenticated as user@example.com")).toBe(true);
		expect(cursor_status_is_authenticated("You are not authenticated.")).toBe(false);
	});
});
