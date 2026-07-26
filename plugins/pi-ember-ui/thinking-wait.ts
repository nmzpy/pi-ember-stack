/**
 * SSOT for arming the gradient Thinking row during agent wait states.
 */

import { is_agent_thinking_wait } from "./mode-colors.ts";

let arm_pre_token_fn: (() => void) | undefined;
let refresh_fn: (() => void) | undefined;
let get_thinking_active: () => boolean = () => false;

/** Wire lifecycle callbacks from pi-ember-ui/index.ts (avoids circular imports). */
export function bind_thinking_wait_handlers(handlers: {
	armPreTokenThinkingStatus: () => void;
	refreshThinkingStatus: () => void;
	getThinkingActive: () => boolean;
}): void {
	arm_pre_token_fn = handlers.armPreTokenThinkingStatus;
	refresh_fn = handlers.refreshThinkingStatus;
	get_thinking_active = handlers.getThinkingActive;
}

/** Whether `text_delta` looks like planning/header narration, not final answer text. */
export function is_planning_style_text_delta(delta: string): boolean {
	const trimmed = delta.trim();
	if (!trimmed) return false;
	if (/^#{1,6}\s+\S/.test(trimmed)) return true;
	if (/^[A-Z][A-Za-z0-9 /_-]{0,48}:\s*\S/.test(trimmed)) return true;
	return false;
}

/**
 * Arm external Thinking UI (widget / in-message) when the SSOT wait predicate
 * passes. In-group `└ Thinking` is entered only on a real thinking stream
 * (`apply_assistant_stream_boundary` → `noteThinking()`), not on inter-run gaps.
 */
export function sync_thinking_wait_ui(): void {
	const thinkingActive = get_thinking_active();
	if (!is_agent_thinking_wait(thinkingActive)) {
		refresh_fn?.();
		return;
	}
	arm_pre_token_fn?.();
	refresh_fn?.();
}
