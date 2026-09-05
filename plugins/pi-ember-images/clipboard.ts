import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolve_coding_agent_dist_dir } from "../pi-ember-ui/select-list-theme.ts";
import { detectImageMimeType, dimensionsForImage } from "./image-utils.ts";
import { MAX_IMAGE_BYTES, type LoadedImage } from "./types.ts";

export type ClipboardImageResult =
	| { ok: true; image: LoadedImage }
	| {
			ok: false;
			reason:
				| "empty"
				| "unsupported-platform"
				| "too-large"
				| "unsupported"
				| "read-error"
				| "timed-out";
	  };

/**
 * The native clipboard module from the running pi runtime
 * (`@mariozechner/clipboard`, clipboard-rs). It reads images in-process with
 * zero subprocess spawns, so it can never hang, time out, or block the TUI.
 * Resolved once through the shared pi dist-dir resolver (SSOT) and cached.
 */
type NativeClipboard = {
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

let native_clipboard: NativeClipboard | null | undefined;

function resolve_native_clipboard(): NativeClipboard | null {
	if (native_clipboard !== undefined) return native_clipboard;
	native_clipboard = null;
	try {
		const dist_dir = resolve_coding_agent_dist_dir();
		if (!dist_dir) return null;
		const req = createRequire(import.meta.url);
		const mod = req(join(dist_dir, "utils/clipboard-native.js")) as {
			clipboard?: NativeClipboard | null;
		};
		native_clipboard = mod.clipboard ?? null;
	} catch {
		native_clipboard = null;
	}
	return native_clipboard;
}

async function readNativeClipboardImage(
	clipboard: NativeClipboard,
	maxBytes: number,
): Promise<ClipboardImageResult | null> {
	try {
		if (!clipboard.hasImage()) return { ok: false, reason: "empty" };
		const data = await clipboard.getImageBinary();
		if (!data || data.length === 0) return { ok: false, reason: "empty" };
		const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
		if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
		const mimeType = detectImageMimeType(bytes);
		if (!mimeType) return { ok: false, reason: "unsupported" };
		const encoded = Buffer.from(bytes).toString("base64");
		return {
			ok: true,
			image: {
				originalPath: "clipboard.png",
				mimeType,
				data: encoded,
				dimensions: dimensionsForImage(encoded, mimeType),
			},
		};
	} catch {
		// Fall through to the platform-specific reader.
		return null;
	}
}

/**
 * Fallback subprocess read timeout. Only reached when the native clipboard
 * module is unavailable (e.g. WSL/headless) — the child is killed on expiry.
 */
const CLIPBOARD_READ_TIMEOUT_MS = 8000;

/**
 * Reads an image from the system clipboard. Prefers the pi runtime's native
 * clipboard module (in-process, instant, no subprocess); falls back to an
 * async PowerShell/osascript read with a hard timeout and process-tree kill
 * so a hung clipboard owner can never freeze the terminal.
 */
export async function readClipboardImage(
	maxBytes = MAX_IMAGE_BYTES,
): Promise<ClipboardImageResult> {
	const native = resolve_native_clipboard();
	if (native) {
		const result = await readNativeClipboardImage(native, maxBytes);
		if (result) return result;
	}
	if (process.platform === "win32") return readWindowsClipboardImage(maxBytes);
	if (process.platform === "darwin") return readMacOSClipboardImage(maxBytes);
	if (process.platform === "linux" && isWsl()) return readWindowsClipboardImage(maxBytes);
	return { ok: false, reason: "unsupported-platform" };
}

interface CapturedRun {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * Runs a child process asynchronously and captures its output. Never blocks
 * the caller. On timeout the whole process tree is killed (taskkill /T on
 * Windows) so a hung PowerShell/conhost or osascript can never leave a zombie
 * holding the stdout pipe open — the historical infinite-stall cause.
 * Exported for regression tests.
 */
export function runCaptured(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<CapturedRun> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			killProcessTree(child.pid);
			resolve({ status: null, stdout: "", stderr: "", timedOut: true });
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ status: null, stdout, stderr: stderr || error.message, timedOut: false });
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ status: code, stdout, stderr, timedOut: false });
		});
	});
}

function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} else {
			process.kill(pid, "SIGKILL");
		}
	} catch {
		// Best-effort cleanup.
	}
}

function isWsl(): boolean {
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

function powershellExecutable(): string {
	if (process.platform === "win32") return "powershell.exe";
	const candidates = [
		"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		"/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe",
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? "powershell.exe";
}

async function readWindowsClipboardImage(maxBytes: number): Promise<ClipboardImageResult> {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms | Out-Null",
		"Add-Type -AssemblyName System.Drawing | Out-Null",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $img) { exit 2 }",
		"$ms = New-Object System.IO.MemoryStream",
		"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
		"[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
	].join("; ");

	const run = await runCaptured(
		powershellExecutable(),
		["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
		CLIPBOARD_READ_TIMEOUT_MS,
	);
	if (run.timedOut) return { ok: false, reason: "timed-out" };
	if (run.status === 2) return { ok: false, reason: "empty" };
	if (run.status !== 0) return { ok: false, reason: "read-error" };
	const data = run.stdout.trim();
	if (!data) return { ok: false, reason: "empty" };
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0) return { ok: false, reason: "empty" };
	if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
	const mimeType = detectImageMimeType(bytes);
	if (!mimeType) return { ok: false, reason: "unsupported" };
	return {
		ok: true,
		image: {
			originalPath: "clipboard.png",
			mimeType,
			data,
			dimensions: dimensionsForImage(data, mimeType),
		},
	};
}

async function readMacOSClipboardImage(maxBytes: number): Promise<ClipboardImageResult> {
	for (const attempt of [
		{ clipboardClass: "PNGf", extension: "png" },
		{ clipboardClass: "JPEG", extension: "jpg" },
	]) {
		const outputPath = join(
			tmpdir(),
			`pi-ember-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${attempt.extension}`,
		);
		try {
			const run = await runCaptured(
				"osascript",
				[
					"-e",
					`set imageData to the clipboard as «class ${attempt.clipboardClass}»`,
					"-e",
					`set outputFile to open for access POSIX file ${JSON.stringify(outputPath)} with write permission`,
					"-e",
					"set eof of outputFile to 0",
					"-e",
					"write imageData to outputFile",
					"-e",
					"close access outputFile",
				],
				3000,
			);
			if (run.timedOut || run.status !== 0) continue;
			const bytes = readFileSync(outputPath);
			if (bytes.length === 0) continue;
			if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
			const mimeType = detectImageMimeType(bytes);
			if (!mimeType) continue;
			const data = bytes.toString("base64");
			return {
				ok: true,
				image: {
					originalPath: `clipboard.${attempt.extension}`,
					mimeType,
					data,
					dimensions: dimensionsForImage(data, mimeType),
				},
			};
		} catch {
			return { ok: false, reason: "read-error" };
		} finally {
			try {
				unlinkSync(outputPath);
			} catch {
				// Best-effort cleanup.
			}
		}
	}
	return { ok: false, reason: "empty" };
}
