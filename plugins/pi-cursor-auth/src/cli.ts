import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const COMMAND_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_CHARS = 64 * 1024;

export interface CursorCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface DiscoveredCursorModel {
	id: string;
	name: string;
}

function append_capped(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

export function strip_ansi(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function resolve_cursor_agent_executable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	check_exists: (path: string) => boolean = existsSync,
	home: string = homedir(),
): string {
	const override = env.CURSOR_AGENT_EXECUTABLE?.trim();
	if (override) return override;

	if (platform === "win32") {
		const local_app_data = env.LOCALAPPDATA || join(home, "AppData", "Local");
		const known_path = join(local_app_data, "cursor-agent", "cursor-agent.cmd");
		return check_exists(known_path) ? known_path : "cursor-agent.cmd";
	}

	const known_paths = [join(home, ".cursor-agent", "cursor-agent"), "/usr/local/bin/cursor-agent"];
	return known_paths.find(check_exists) || "cursor-agent";
}

export function terminate_cursor_process(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.killed) return;
	if (process.platform === "win32" && child.pid) {
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.unref();
		return;
	}
	child.kill("SIGTERM");
}

export function spawn_cursor_agent(
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
	const executable = resolve_cursor_agent_executable(options.env);
	return spawn(executable, [...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		// Cursor's Windows installation is a .cmd shim. All dynamic arguments are
		// validated before this function is called.
		shell: process.platform === "win32",
	});
}

export async function run_cursor_command(
	args: readonly string[],
	options: { timeout_ms?: number; allow_nonzero?: boolean } = {},
): Promise<CursorCommandResult> {
	const child = spawn_cursor_agent(args);
	child.stdin.end();

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout = append_capped(stdout, chunk.toString("utf8"));
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = append_capped(stderr, chunk.toString("utf8"));
	});

	const timeout_ms = options.timeout_ms ?? COMMAND_TIMEOUT_MS;
	let timed_out = false;
	const timeout = setTimeout(() => {
		timed_out = true;
		terminate_cursor_process(child);
	}, timeout_ms);
	timeout.unref?.();

	const exit_code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	}).finally(() => clearTimeout(timeout));

	if (timed_out) {
		throw new Error(`cursor-agent ${args[0] || "command"} timed out after ${timeout_ms}ms.`);
	}
	if (exit_code !== 0 && !options.allow_nonzero) {
		const detail = strip_ansi(stderr || stdout).trim();
		throw new Error(detail || `cursor-agent exited with code ${exit_code}.`);
	}

	return { stdout, stderr, exitCode: exit_code };
}

export function parse_cursor_models_output(output: string): DiscoveredCursorModel[] {
	const models: DiscoveredCursorModel[] = [];
	const seen = new Set<string>();

	for (const raw_line of strip_ansi(output).split(/\r?\n/)) {
		const line = raw_line.trim().replace(/^(?:[*✓•>]\s*|[-+]\s+)/, "");
		const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+)$/.exec(line);
		if (!match) continue;

		const id = match[1];
		if (seen.has(id)) continue;
		const name = match[2].replace(/\s+\((?:current|default)\)\s*$/i, "").trim();
		if (!name) continue;

		seen.add(id);
		models.push({ id, name });
	}

	return models;
}

export async function discover_cursor_models(): Promise<DiscoveredCursorModel[]> {
	const result = await run_cursor_command(["models"]);
	const models = parse_cursor_models_output(`${result.stdout}\n${result.stderr}`);
	if (models.length === 0) {
		throw new Error("cursor-agent returned no parseable models. Authenticate with /login cursor.");
	}
	return models;
}

export function cursor_status_is_authenticated(output: string): boolean {
	const normalized = strip_ansi(output).toLowerCase();
	if (/not\s+(?:authenticated|logged\s+in)|unauthenticated/.test(normalized)) return false;
	return /authenticated|logged\s+in|email|account/.test(normalized);
}

export async function get_cursor_status(): Promise<{ authenticated: boolean; detail: string }> {
	const result = await run_cursor_command(["status"], { allow_nonzero: true });
	const detail = strip_ansi(result.stdout || result.stderr).trim();
	return {
		authenticated: result.exitCode === 0 && cursor_status_is_authenticated(detail),
		detail: detail || `cursor-agent status exited with code ${result.exitCode}.`,
	};
}

export async function login_cursor(callbacks: OAuthLoginCallbacks): Promise<void> {
	callbacks.onProgress?.("Starting Cursor browser authentication...");
	const child = spawn_cursor_agent(["login"]);
	child.stdin.end();

	let output = "";
	let reported_url = false;
	const capture = (chunk: Buffer): void => {
		output = append_capped(output, chunk.toString("utf8"));
		if (reported_url) return;
		const url = strip_ansi(output)
			.match(/https:\/\/[^\s<>"']+/)?.[0]
			?.replace(/[),.;]+$/, "");
		if (!url) return;
		reported_url = true;
		callbacks.onAuth({ url });
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);

	let timed_out = false;
	const timeout = setTimeout(() => {
		timed_out = true;
		terminate_cursor_process(child);
	}, LOGIN_TIMEOUT_MS);
	timeout.unref?.();

	const exit_code = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	}).finally(() => clearTimeout(timeout));

	if (timed_out) throw new Error("Cursor login timed out after 5 minutes.");
	if (exit_code !== 0) {
		throw new Error(
			strip_ansi(output).trim() || `cursor-agent login exited with code ${exit_code}.`,
		);
	}

	const status = await get_cursor_status();
	if (!status.authenticated) {
		throw new Error(
			`Cursor login completed but authentication was not confirmed: ${status.detail}`,
		);
	}
}

export async function logout_cursor(): Promise<void> {
	await run_cursor_command(["logout"]);
}
