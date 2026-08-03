/**
 * Capture Pi's newSession from bindCommandContext.
 *
 * Event handlers (e.g. agent_settled) receive ExtensionContext without
 * session-control methods. Command handlers get ExtensionCommandContext.
 * Plan Review's "Implement with fresh context" runs from agent_settled, so
 * we bind newSession the same way pi-ember-ui captures switchSession.
 */
import {
	get_new_session_fn as get_shared_new_session_fn,
	install_command_context_capture,
	reset_command_context_capture_for_tests,
	type NewSessionFn,
} from "../pi-ember-ui/command-context-capture.ts";

export type { NewSessionFn };

/** Session-only marker used to select the implementation mode after replacement. */
export const FRESH_CONTEXT_MODE_ENTRY = "pi-agents-fresh-context-mode";

type SessionEntryReader = {
	getEntries: () => readonly unknown[];
};

type SessionEntryWriter = {
	appendCustomEntry: (customType: string, data?: unknown) => unknown;
};

export function seed_fresh_context_mode(
	session_manager: SessionEntryWriter,
	mode: string,
): void {
	session_manager.appendCustomEntry(FRESH_CONTEXT_MODE_ENTRY, { mode });
}

export function get_fresh_context_mode(
	ctx: { sessionManager: SessionEntryReader },
	valid_modes: readonly string[],
): string | undefined {
	const valid_mode_set = new Set(valid_modes);
	const entries = ctx.sessionManager.getEntries();
	let marker_index = -1;
	let marker_mode: string | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
		};
		if (candidate.type !== "custom" || candidate.customType !== FRESH_CONTEXT_MODE_ENTRY) {
			continue;
		}
		if (!candidate.data || typeof candidate.data !== "object") continue;
		const mode = (candidate.data as { mode?: unknown }).mode;
		if (typeof mode === "string" && valid_mode_set.has(mode)) {
			marker_index = index;
			marker_mode = mode;
			break;
		}
	}
	if (marker_index < 0 || !marker_mode) return undefined;

	// A normal mode-entry message written after the marker means the fresh
	// startup handoff has completed. Do not let the marker override a later
	// explicit mode change when this session is resumed.
	for (let index = marker_index + 1; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown };
		if (
			candidate.type === "custom_message" &&
			(typeof candidate.customType === "string" &&
				(candidate.customType.startsWith("pi-agents-enter-") ||
					candidate.customType === "pi-agents-exit"))
		) {
			return undefined;
		}
	}
	return marker_mode;
}

export function get_new_session_fn(): NewSessionFn | undefined {
	return get_shared_new_session_fn();
}

/** Test-only reset — not used in production. */
export function reset_new_session_capture_for_tests(): void {
	reset_command_context_capture_for_tests();
}

/** Idempotent — delegates to pi-ember-ui command-context-capture SSOT. */
export function install_new_session_capture(): void {
	install_command_context_capture();
}
