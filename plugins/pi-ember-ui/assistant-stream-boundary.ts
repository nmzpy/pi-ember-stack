import type { CompactRenderer } from "../pi-compact-tools/renderer.ts";
import { isInterRunGap, isThinkingBlocksHidden, is_work_group_boundary_suppressed } from "./mode-colors.ts";
import { is_planning_style_text_delta } from "./thinking-wait.ts";

/** Classify assistant stream events that affect compact group boundaries. */
export function resolve_assistant_stream_boundary_event(ev: {
	type: string;
	delta?: unknown;
}): "visible_text" | "thinking" | null {
	if (ev.type === "text_delta") {
		const delta = ev.delta;
		return typeof delta === "string" && delta.trim().length > 0 ? "visible_text" : null;
	}
	if (ev.type === "thinking_start" || ev.type === "thinking_delta") return "thinking";
	return null;
}

/**
 * Apply compact-group stream boundaries — SSOT for message_update and tests.
 * Returns `"planning_text"` when inter-run planning narration should arm Thinking
 * without folding child rows (caller runs `reconcile_thinking_wait_ui()`).
 */
export function apply_assistant_stream_boundary(
	renderer: CompactRenderer,
	ev: { type: string; delta?: unknown },
): "planning_text" | void {
	if (is_work_group_boundary_suppressed()) return;

	const boundary = resolve_assistant_stream_boundary_event(ev);
	if (!boundary) return;

	if (boundary === "thinking") {
		// Inter-run reasoning (Devin/Cognition between tool batches) is
		// planning, not a final answer. Soft-settle so the unified work
		// group stays reopenable for the next tool wave, regardless of
		// whether thinking blocks are visible or hidden. Visible blocks
		// still render in the transcript via Pi's assistant message path;
		// the compact group header simply persists across the gap.
		if (isInterRunGap()) {
			if (isThinkingBlocksHidden()) {
				renderer.noteHiddenThinking();
			} else {
				renderer.noteThinking();
			}
			return;
		}
		if (isThinkingBlocksHidden()) {
			// Hidden thinking is a real transcript block between tool waves;
			// render the in-group Thinking row but close the group so the next
			// tool wave starts a fresh work group below the hidden reasoning.
			renderer.noteHiddenThinking();
		} else {
			renderer.noteVisibleThinking();
		}
		return;
	}

	const delta = typeof ev.delta === "string" ? ev.delta : "";
	if (isInterRunGap()) {
		if (isThinkingBlocksHidden() && is_planning_style_text_delta(delta)) {
			return "planning_text";
		}
		renderer.noteVisibleText();
		return;
	}
	renderer.noteVisibleText();
}
