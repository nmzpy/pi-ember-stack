import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	CURSOR_AGENT_INSTALL_TIMEOUT_MS,
	CURSOR_AGENT_INSTALL_URL,
	CURSOR_AGENT_WINDOWS_INSTALL_URL,
} from "./constants.js";

const exec_file = promisify(execFile);

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

type ExistsCheck = (path: string) => boolean;

let install_in_flight: Promise<string> | null = null;

function append_capped(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

export function strip_ansi(value: string): string {
	return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function find_on_path(
	name: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	check_exists: ExistsCheck,
): string | undefined {
	const path_value = env.PATH || env.Path || "";
	const sep = platform === "win32" ? ";" : ":";
	const extensions = platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
	for (const dir of path_value.split(sep)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate =
				platform === "win32" ? win32.join(dir, `${name}${ext}`) : posix.join(dir, `${name}${ext}`);
			if (check_exists(candidate)) return candidate;
		}
	}
	return undefined;
}

function is_path_like(executable: string): boolean {
	return executable.includes("/") || executable.includes("\\");
}

function absolutize_if_bare(
	executable: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	check_exists: ExistsCheck,
): string {
	if (is_path_like(executable)) return executable;
	const bare = executable.replace(/\.(cmd|exe|ps1)$/i, "");
	return (
		find_on_path(bare, env, platform, check_exists) ||
		find_on_path(executable, env, platform, check_exists) ||
		executable
	);
}

export function cursor_agent_is_available(
	executable: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	check_exists: ExistsCheck = existsSync,
): boolean {
	if (is_path_like(executable)) return check_exists(executable);
	return absolutize_if_bare(executable, env, platform, check_exists) !== executable;
}

export function resolve_cursor_agent_executable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	check_exists: ExistsCheck = existsSync,
	home: string = homedir(),
): string {
	const override = env.CURSOR_AGENT_EXECUTABLE?.trim();
	if (override) return override;

	if (platform === "win32") {
		const local_app_data = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
		const known_paths = [
			win32.join(local_app_data, "cursor-agent", "cursor-agent.cmd"),
			win32.join(local_app_data, "cursor-agent", "cursor-agent.exe"),
		];
		const known = known_paths.find(check_exists);
		if (known) return known;
		return find_on_path("cursor-agent", env, platform, check_exists) || "cursor-agent.cmd";
	}

	// Official install: ~/.local/bin/cursor-agent. Also cover legacy,
	// Homebrew, and /usr/local paths. Never fall back to bare `agent`.
	// Use posix.join so non-win32 paths use forward slashes even when the
	// host is Windows (tests mock platform="linux" with POSIX home paths).
	const known_paths = [
		posix.join(home, ".local", "bin", "cursor-agent"),
		posix.join(home, ".cursor-agent", "cursor-agent"),
		"/opt/homebrew/bin/cursor-agent",
		"/usr/local/bin/cursor-agent",
	];
	const known = known_paths.find(check_exists);
	if (known) return known;
	return find_on_path("cursor-agent", env, platform, check_exists) || "cursor-agent";
}

/** Pure install command used by ensure — kept testable without network. */
export function cursor_agent_install_command(
	platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
	if (platform === "win32") {
		return {
			file: "powershell.exe",
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`irm '${CURSOR_AGENT_WINDOWS_INSTALL_URL}' | iex`,
			],
		};
	}
	return {
		file: "bash",
		args: ["-lc", `curl -fsSL ${CURSOR_AGENT_INSTALL_URL} | bash`],
	};
}

function mac_cursor_launcher(check_exists: ExistsCheck = existsSync): string | undefined {
	const app_bin = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
	return check_exists(app_bin) ? app_bin : undefined;
}

export async function install_cursor_agent(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	check_exists: ExistsCheck = existsSync,
): Promise<void> {
	// Prefer Cursor.app's own installer path on macOS — same behavior as
	// `cursor agent …` when the CLI is missing. The launcher installs to
	// ~/.local/bin/cursor-agent even when the subsequent status call fails.
	if (platform === "darwin") {
		const launcher = mac_cursor_launcher(check_exists);
		if (launcher) {
			try {
				await exec_file(launcher, ["agent", "status"], {
					timeout: CURSOR_AGENT_INSTALL_TIMEOUT_MS,
					env,
					encoding: "utf8",
				});
			} catch {
				// Install may have completed even when status fails.
			}
			if (check_exists(join(homedir(), ".local", "bin", "cursor-agent"))) {
				return;
			}
		}
	}

	const { file, args } = cursor_agent_install_command(platform);
	try {
		await exec_file(file, args, {
			timeout: CURSOR_AGENT_INSTALL_TIMEOUT_MS,
			env,
			encoding: "utf8",
			windowsHide: platform === "win32",
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to install cursor-agent. Run: curl -fsSL ${CURSOR_AGENT_INSTALL_URL} | bash\n${detail}`,
		);
	}
}

/**
 * Resolve an absolute cursor-agent path, installing the official CLI when
 * missing. Concurrent callers share one in-flight install.
 */
export async function ensure_cursor_agent_executable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	check_exists: ExistsCheck = existsSync,
	home: string = homedir(),
	install: typeof install_cursor_agent = install_cursor_agent,
): Promise<string> {
	const resolved = resolve_cursor_agent_executable(env, platform, check_exists, home);
	if (cursor_agent_is_available(resolved, env, platform, check_exists)) {
		return absolutize_if_bare(resolved, env, platform, check_exists);
	}

	if (!install_in_flight) {
		install_in_flight = (async () => {
			await install(platform, env, check_exists);
			const after = resolve_cursor_agent_executable(env, platform, check_exists, home);
			if (!cursor_agent_is_available(after, env, platform, check_exists)) {
				throw new Error(
					`cursor-agent not found after install. Expected ~/.local/bin/cursor-agent (or set CURSOR_AGENT_EXECUTABLE).`,
				);
			}
			return absolutize_if_bare(after, env, platform, check_exists);
		})().finally(() => {
			install_in_flight = null;
		});
	}
	return install_in_flight;
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
	options: { cwd?: string; env?: NodeJS.ProcessEnv; executable?: string } = {},
): ChildProcessWithoutNullStreams {
	const executable = options.executable ?? resolve_cursor_agent_executable(options.env);
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
	options: { timeout_ms?: number; allow_nonzero?: boolean; ensure?: boolean } = {},
): Promise<CursorCommandResult> {
	const executable =
		options.ensure === false
			? resolve_cursor_agent_executable()
			: await ensure_cursor_agent_executable();
	const child = spawn_cursor_agent(args, { executable });
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
		child.once("error", (error: NodeJS.ErrnoException) => {
			reject(cursor_agent_spawn_error(error));
		});
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

export function cursor_agent_spawn_error(error: NodeJS.ErrnoException): Error {
	if (error.code === "ENOENT") {
		return new Error(
			"cursor-agent not found. Install the Cursor Agent CLI (https://cursor.com/install) or set CURSOR_AGENT_EXECUTABLE.",
		);
	}
	return error;
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

export async function discover_cursor_models(
	options: { ensure?: boolean } = {},
): Promise<DiscoveredCursorModel[]> {
	const result = await run_cursor_command(["models"], { ensure: options.ensure ?? true });
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
	callbacks.onProgress?.("Ensuring Cursor Agent CLI is installed...");
	const executable = await ensure_cursor_agent_executable();
	callbacks.onProgress?.("Starting Cursor browser authentication...");
	const child = spawn_cursor_agent(["login"], { executable });
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
		child.once("error", (error: NodeJS.ErrnoException) => {
			reject(cursor_agent_spawn_error(error));
		});
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
