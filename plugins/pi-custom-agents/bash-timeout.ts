import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default bash tool timeout in seconds (20 minutes). */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 1200;

/** Legacy model default that is too short for release builds / installers. */
export const LEGACY_BASH_TIMEOUT_SECONDS = 600;

export function resolve_bash_timeout_seconds(timeout: unknown): number {
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		return DEFAULT_BASH_TIMEOUT_SECONDS;
	}
	if (timeout === LEGACY_BASH_TIMEOUT_SECONDS) {
		return DEFAULT_BASH_TIMEOUT_SECONDS;
	}
	return timeout;
}

export function install_bash_timeout(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		event.input.timeout = resolve_bash_timeout_seconds(event.input.timeout);
	});
}
