import {
	type GradientPreset,
	get_gradient_phase,
	render_gradient,
} from "./gradient.ts";


/** SSOT label for the gradient Thinking status row. */
export const THINKING_STATUS_LABEL = "Thinking";

/** SSOT: Thinking status uses the live `thinking` preset (dim→text glow). */
export const THINKING_GRADIENT_PRESET: GradientPreset = "thinking";

/** Shared monotonic seed for per-Thinking-row stagger. Incremented per render. */
let thinking_stagger_seed = 0;

/** Stagger step in ms between multiple Thinking rows on screen. */
const THINKING_STAGGER_MS = 50;

/** Live gradient `Thinking` label at the current sweep phase. */
export function render_thinking_gradient_label(phaseOffsetMs: number = 0): string {
	return render_gradient(THINKING_STATUS_LABEL, THINKING_GRADIENT_PRESET, get_gradient_phase() + phaseOffsetMs);
}

/** Render an in-group `└ Thinking` body with a per-call stagger offset.
 *  The seed is advanced for every row so multiple simultaneous Thinking
 *  rows (subagents, group children, in-message headers) animate out of phase
 *  while still sharing one batched 20 FPS gradient clock. */
export function format_in_group_thinking_row(elapsed_suffix = ""): string {
	const offsetMs = thinking_stagger_seed * THINKING_STAGGER_MS;
	thinking_stagger_seed = (thinking_stagger_seed + 1) % 32;
	return render_thinking_gradient_label(offsetMs) + elapsed_suffix;
}
