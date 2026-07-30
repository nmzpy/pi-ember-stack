import {
	type GradientPreset,
	get_gradient_phase,
	render_gradient,
} from "./gradient.ts";


/** SSOT label for the gradient Thinking status row. */
export const THINKING_STATUS_LABEL = "Thinking";

/** SSOT: Thinking status uses the live `thinking` preset (dim→text glow). */
export const THINKING_GRADIENT_PRESET: GradientPreset = "thinking";

/** Shared visibility threshold for the elapsed Thinking suffix. */
export const THINKING_ELAPSED_MIN_MS = 1000;

/** Live gradient `Thinking` label at the current sweep phase. */
export function render_thinking_gradient_label(): string {
	return render_gradient(THINKING_STATUS_LABEL, THINKING_GRADIENT_PRESET, get_gradient_phase());
}

/** Render an in-group `└ Thinking` body using the exact same clock phase and
 *  duration as the external Thinking header. This must stay render-pure:
 *  changing an offset on every render would make Pi's normal invalidation
 *  frequency change the animation speed. */
export function format_in_group_thinking_row(elapsed_suffix = ""): string {
	return render_thinking_gradient_label() + elapsed_suffix;
}
