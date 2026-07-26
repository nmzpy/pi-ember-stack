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
