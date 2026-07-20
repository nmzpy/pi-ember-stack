import { describe, expect, test } from "bun:test";
import {
	cursor_agent_install_command,
	cursor_agent_is_available,
	cursor_status_is_authenticated,
	ensure_cursor_agent_executable,
	parse_cursor_models_output,
	resolve_cursor_agent_executable,
} from "../src/cli.ts";
import {
	CURSOR_AGENT_INSTALL_URL,
	CURSOR_AGENT_WINDOWS_INSTALL_URL,
} from "../src/constants.ts";

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

	test("resolves the official ~/.local/bin install path", () => {
		const expected = "/home/test/.local/bin/cursor-agent";
		const executable = resolve_cursor_agent_executable(
			{},
			"linux",
			(path) => path === expected,
			"/home/test",
		);
		expect(executable).toBe(expected);
	});

	test("resolves cursor-agent from PATH when known paths are absent", () => {
		const on_path = "/custom/bin/cursor-agent";
		const executable = resolve_cursor_agent_executable(
			{ PATH: "/custom/bin:/usr/bin" },
			"linux",
			(path) => path === on_path,
			"/home/test",
		);
		expect(executable).toBe(on_path);
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

	test("builds the official install commands", () => {
		expect(cursor_agent_install_command("linux")).toEqual({
			file: "bash",
			args: ["-lc", `curl -fsSL ${CURSOR_AGENT_INSTALL_URL} | bash`],
		});
		expect(cursor_agent_install_command("win32")).toEqual({
			file: "powershell.exe",
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`irm '${CURSOR_AGENT_WINDOWS_INSTALL_URL}' | iex`,
			],
		});
	});

	test("ensure installs when cursor-agent is missing then returns the path", async () => {
		const installed = "/home/test/.local/bin/cursor-agent";
		let exists = false;
		let installed_once = false;
		const executable = await ensure_cursor_agent_executable(
			{},
			"linux",
			(path) => path === installed && exists,
			"/home/test",
			async () => {
				installed_once = true;
				exists = true;
			},
		);
		expect(installed_once).toBe(true);
		expect(executable).toBe(installed);
		expect(cursor_agent_is_available(installed, {}, "linux", (path) => path === installed)).toBe(
			true,
		);
	});

	test("ensure reuses an existing install without calling the installer", async () => {
		const installed = "/home/test/.local/bin/cursor-agent";
		let install_calls = 0;
		const executable = await ensure_cursor_agent_executable(
			{},
			"linux",
			(path) => path === installed,
			"/home/test",
			async () => {
				install_calls += 1;
			},
		);
		expect(install_calls).toBe(0);
		expect(executable).toBe(installed);
	});

	test("recognizes authenticated and unauthenticated status text", () => {
		expect(cursor_status_is_authenticated("Authenticated as user@example.com")).toBe(true);
		expect(cursor_status_is_authenticated("You are not authenticated.")).toBe(false);
	});
});
