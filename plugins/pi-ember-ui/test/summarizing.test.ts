import { describe, expect, test } from "bun:test";
import {
	get_gradient_phase,
	set_gradient_colorizer,
	reset_gradient_colorizer,
	activate_gradient,
	deactivate_gradient,
	shutdown_gradient_clock,
	type Rgb,
} from "../gradient.ts";
import { renderLiveGradient } from "../index.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function forcedColorizer(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

describe("summarizing label", () => {
	test("renderLiveGradient preserves 'Summarizing' text with thinking preset", () => {
		set_gradient_colorizer(forcedColorizer);
		const result = renderLiveGradient("Summarizing", "thinking");
		expect(stripAnsi(result)).toBe("Summarizing");
		reset_gradient_colorizer();
	});

	test("activating/deactivating 'summarizing' keeps gradient phase alive", () => {
		set_gradient_colorizer(forcedColorizer);
		activate_gradient("summarizing");
		const phase1 = get_gradient_phase();
		// phase is a normalized 0..1 value; it should be defined after activation
		expect(typeof phase1).toBe("number");
		expect(phase1).toBeGreaterThanOrEqual(0);
		expect(phase1).toBeLessThanOrEqual(1);
		deactivate_gradient("summarizing");
		reset_gradient_colorizer();
	});

	test("shutdown clears gradient reasons", () => {
		set_gradient_colorizer(forcedColorizer);
		activate_gradient("summarizing");
		shutdown_gradient_clock();
		// After shutdown the clock and active reasons are cleared.
		// Re-activating should restart cleanly.
		activate_gradient("summarizing");
		expect(typeof get_gradient_phase()).toBe("number");
		deactivate_gradient("summarizing");
		reset_gradient_colorizer();
	});
});
