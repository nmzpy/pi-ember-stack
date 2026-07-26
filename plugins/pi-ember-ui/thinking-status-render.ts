import {
	type GradientPreset,
	get_gradient_phase,
	render_gradient,
} from "./gradient.ts";

/** SSOT label for the gradient Thinking status row. */
export const THINKING_STATUS_LABEL = "Thinking";

/** Same dim→text sweep as compaction — one shared 20 FPS clock. */
export const THINKING_GRADIENT_PRESET: GradientPreset = "thinking";

/** Live gradient `Thinking` label at the current sweep phase. */
export function render_thinking_gradient_label(): string {
	return render_gradient(THINKING_STATUS_LABEL, THINKING_GRADIENT_PRESET, get_gradient_phase());
}

/** In-group `└ Thinking` body — SSOT for compact work groups and subagent rows. */
export function format_in_group_thinking_row(elapsed_suffix = ""): string {
	return render_thinking_gradient_label() + elapsed_suffix;
}
