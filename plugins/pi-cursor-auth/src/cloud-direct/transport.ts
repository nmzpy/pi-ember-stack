/**
 * HTTP/2 transport via Node child-process bridge (Windows-safe).
 * Adapted from ephraimduncan/opencode-cursor h2-bridge.mjs (BSD-3-Clause).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lp_encode } from "./wire.js";
import { CURSOR_API_HOST } from "./metadata.js";

const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "h2-bridge.mjs");

function swallow_stdin_error(): void {
	// EPIPE / ECONNRESET when the bridge child exits before stdin.end() completes.
}

export interface BridgeCloseInfo {
	exit_code: number;
	stderr: string;
}

export interface CursorBridge {
	proc: ChildProcess;
	write: (data: Uint8Array) => void;
	end: () => void;
	on_data: (cb: (chunk: Buffer) => void) => void;
	on_close: (cb: (info: BridgeCloseInfo) => void) => void;
	get alive(): boolean;
}

export interface SpawnBridgeOptions {
	access_token: string;
	rpc_path: string;
	url?: string;
	unary?: boolean;
}

export function spawn_bridge(options: SpawnBridgeOptions): CursorBridge {
	const proc = spawn("node", [BRIDGE_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	const config = JSON.stringify({
		accessToken: options.access_token,
		url: options.url ?? CURSOR_API_HOST,
		path: options.rpc_path,
		unary: options.unary ?? false,
	});
	proc.stdin?.write(lp_encode(new TextEncoder().encode(config)));

	const stdout = proc.stdout;
	if (!stdout || !proc.stdin) {
		throw new Error("Failed to open h2-bridge stdio pipes");
	}
	proc.stdin.on("error", swallow_stdin_error);

	const cbs = {
		data: null as ((chunk: Buffer) => void) | null,
		close: null as ((info: BridgeCloseInfo) => void) | null,
	};

	let exited = false;
	let ended = false;
	let exit_code = 1;
	let stderr_text = "";

	proc.stderr?.on("data", (chunk: Buffer | string) => {
		stderr_text += chunk.toString();
		if (stderr_text.length > 8192) {
			stderr_text = stderr_text.slice(-8192);
		}
	});

	let pending = Buffer.alloc(0);
	stdout.on("data", (chunk: Buffer) => {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const len = pending.readUInt32BE(0);
			if (pending.length < 4 + len) break;
			const payload = pending.subarray(4, 4 + len);
			pending = pending.subarray(4 + len);
			cbs.data?.(Buffer.from(payload));
		}
	});

	const emit_close = (): void => {
		cbs.close?.({ exit_code, stderr: stderr_text.trim() });
	};

	proc.on("close", (code) => {
		exited = true;
		exit_code = code ?? 1;
		emit_close();
	});

	proc.on("error", () => {
		exited = true;
		exit_code = 1;
		emit_close();
	});

	return {
		proc,
		get alive() {
			return !exited;
		},
		write(data) {
			if (exited || ended) return;
			try {
				proc.stdin?.write(lp_encode(data));
			} catch {
				// Bridge already closed.
			}
		},
		end() {
			if (ended || exited) return;
			ended = true;
			const stdin = proc.stdin;
			if (!stdin || stdin.destroyed) return;
			try {
				stdin.write(lp_encode(new Uint8Array(0)));
				stdin.end();
			} catch {
				// Bridge already closed.
			}
		},
		on_data(cb) {
			cbs.data = cb;
		},
		on_close(cb) {
			if (exited) queueMicrotask(() => cb({ exit_code, stderr: stderr_text.trim() }));
			else cbs.close = cb;
		},
	};
}

export interface CursorUnaryRpcOptions {
	access_token: string;
	rpc_path: string;
	request_body: Uint8Array;
	url?: string;
	timeout_ms?: number;
}

export async function call_cursor_unary_rpc(
	options: CursorUnaryRpcOptions,
): Promise<{ body: Uint8Array; exit_code: number; timed_out: boolean }> {
	const bridge = spawn_bridge({
		access_token: options.access_token,
		rpc_path: options.rpc_path,
		url: options.url,
		unary: true,
	});

	const chunks: Buffer[] = [];
	let resolve_close: (value: {
		body: Uint8Array;
		exit_code: number;
		timed_out: boolean;
	}) => void = () => {};
	const promise = new Promise<{
		body: Uint8Array;
		exit_code: number;
		timed_out: boolean;
	}>((resolve) => {
		resolve_close = resolve;
	});

	let timed_out = false;
	const timeout_ms = options.timeout_ms ?? 15_000;
	const timeout =
		timeout_ms > 0
			? setTimeout(() => {
					timed_out = true;
					try {
						bridge.proc.kill();
					} catch {
						// ignore
					}
				}, timeout_ms)
			: undefined;

	bridge.on_data((chunk) => {
		chunks.push(Buffer.from(chunk));
	});
	bridge.on_close((info) => {
		if (timeout) clearTimeout(timeout);
		resolve_close({
			body: Buffer.concat(chunks),
			exit_code: info.exit_code,
			timed_out,
		});
	});

	bridge.write(options.request_body);
	bridge.end();

	return promise;
}

/** Test hook: verify bridge.end() is safe when the child already exited. */
export function __transport_test_only_end_after_exit(bridge: CursorBridge): void {
	bridge.end();
	bridge.end();
}
