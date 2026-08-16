import type { CompactRenderer } from "../pi-compact-tools/renderer.ts";
import {
	is_non_conventional_thinking_header,
	isThinkingBlocksHidden,
	is_work_group_boundary_suppressed,
} from "./mode-colors.ts";

/** Classify assistant stream events that affect compact group boundaries. */
export function resolve_assistant_stream_boundary_event(ev: {
	type: string;
	delta?: unknown;
}): "visible_text" | "thinking" | null {
	if (ev.type === "text_delta") {
		const delta = ev.delta;
		return typeof delta === "string" && delta.trim().length > 0 ? "visible_text" : null;
	}
	if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
		// Non-conventional thinking headers (e.g. **Thinking**, Thinking:)
		// are a continuation of the current thinking pass, not a new boundary.
		// They still classify as "thinking" so the pass timer keeps running.
		const delta = ev.delta;
		if (typeof delta === "string" && is_non_conventional_thinking_header(delta)) {
			return "thinking";
		}
		return "thinking";
	}
	return null;
}

/**
 * Apply compact-group stream boundaries — SSOT for message_update and tests.
 */
export function apply_assistant_stream_boundary(
	renderer: CompactRenderer,
	ev: { type: string; delta?: unknown },
): void {
	if (is_work_group_boundary_suppressed()) return;

	const boundary = resolve_assistant_stream_boundary_event(ev);
	if (!boundary) return;

	if (boundary === "thinking") {
		if (isThinkingBlocksHidden()) {
			// Hidden reasoning occupies the in-group Thinking lane.
			renderer.noteHiddenThinking();
		} else {
			// A visible reasoning block is a chronological transcript boundary.
			// It must hard-exit even during an inter-run gap, otherwise the next
			// tool wave mutates a header above the visible reasoning block.
			renderer.noteVisibleThinking();
		}
		return;
	}

	// visible_text — any non-reasoning, non-tool assistant text hard-splits the
	// work group. Emitted text must never appear below an ongoing work group.
	renderer.noteVisibleText();
}
