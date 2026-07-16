import { describe, expect, test } from "bun:test";
import {
	clamp_lerp,
	compute_sweep_center,
	dispatch_gradient_tick,
	EDGE_PADDING,
	GRADIENT_DURATION_MS,
	GRADIENT_SIGMA,
	GRADIENT_TICK_MS,
	type GradientPreset,
	gaussian_intensity,
	get_gradient_phase,
	invalidate_gradient_cache,
	render_gradient,
	reset_gradient_colorizer,
	set_gradient_colorizer,
	set_gradient_render_request,
	shutdown_gradient_clock,
	activate_gradient,
	deactivate_gradient,
	subscribe_gradient_tick,
	unsubscribe_gradient_tick,
	type Rgb,
} from "../gradient.ts";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractRgbFromAnsi(s: string): Rgb | undefined {
	const m = s.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function forcedColorizer(rgb: Rgb, text: string): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

describe("gradient engine", () => {
	test("clamp_lerp clamps t to [0,1]", () => {
		const a: Rgb = [0, 0, 0];
		const b: Rgb = [100, 200, 50];
		expect(clamp_lerp(a, b, -1)).toEqual([0, 0, 0]);
		expect(clamp_lerp(a, b, 2)).toEqual([100, 200, 50]);
		expect(clamp_lerp(a, b, 0.5)).toEqual([50, 100, 25]);
	});

	test("gaussian_intensity peaks at 1.0 and falls off", () => {
		expect(gaussian_intensity(0, GRADIENT_SIGMA)).toBeCloseTo(1.0, 5);
		const far = gaussian_intensity(10, GRADIENT_SIGMA);
		expect(far).toBeLessThan(0.01);
		expect(far).toBeGreaterThan(0);
	});

	test("compute_sweep_center enters offscreen left at phase 0", () => {
		const len = 10;
		const center0 = compute_sweep_center(0, len, EDGE_PADDING);
		expect(center0).toBe(-EDGE_PADDING);
	});

	test("compute_sweep_center exits offscreen right at phase 1", () => {
		const len = 10;
		const center1 = compute_sweep_center(1, len, EDGE_PADDING);
		expect(center1).toBe(len - 1 + EDGE_PADDING);
	});

	test("render_gradient preserves visible text", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Thinking";
		const result = render_gradient(text, "thinking", 0.5);
		expect(stripAnsi(result)).toBe(text);
		reset_gradient_colorizer();
	});

	test("render_gradient handles empty string", () => {
		set_gradient_colorizer(forcedColorizer);
		expect(render_gradient("", "thinking", 0)).toBe("");
		reset_gradient_colorizer();
	});

	test("render_gradient handles single character", () => {
		set_gradient_colorizer(forcedColorizer);
		const result = render_gradient("X", "thinking", 0);
		expect(stripAnsi(result)).toBe("X");
		reset_gradient_colorizer();
	});

	test("render_gradient handles unicode (code points, not UTF-16)", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Thínkíng";
		const result = render_gradient(text, "thinking", 0.3);
		expect(stripAnsi(result)).toBe(text);
		expect([...stripAnsi(result)].length).toBe([...text].length);
		reset_gradient_colorizer();
	});

	test("no circular wrap: clean entrance (phase 0)", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Working";
		const chars = [...text];
		const result = render_gradient(text, "working", 0);
		const parts = chars.map((ch) => {
			const ansi = `\x1b[38;2;`;
			const idx = result.indexOf(ansi);
			expect(idx).toBeGreaterThanOrEqual(-1);
			return result;
		});
		expect(stripAnsi(result)).toBe(text);
		const firstCharRgb = extractRgbFromAnsi(result);
		expect(firstCharRgb).toBeDefined();
		const lastCharRgb = extractRgbFromAnsi(result.slice(result.lastIndexOf("\x1b[38;2;")));
		expect(lastCharRgb).toBeDefined();
		reset_gradient_colorizer();
	});

	test("Gaussian peak: center character has highest intensity at phase 0.5", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "abcdefghij";
		const len = [...text].length;
		const phase = 0.5;
		const center = compute_sweep_center(phase, len, EDGE_PADDING);
		const centerIdx = Math.round(center);
		const result = render_gradient(text, "thinking", phase);
		const chars = [...text];
		const rgbAt = (idx: number): Rgb | undefined => {
			const charIdx = result.indexOf(chars[idx]);
			if (charIdx < 0) return undefined;
			const ansiStart = result.lastIndexOf("\x1b[38;2;", charIdx);
			if (ansiStart < 0) return undefined;
			return extractRgbFromAnsi(result.slice(ansiStart));
		};
		const peakRgb = rgbAt(centerIdx);
		const farRgb = rgbAt(0);
		expect(peakRgb).toBeDefined();
		expect(farRgb).toBeDefined();
		if (peakRgb && farRgb) {
			const peakIntensity = gaussian_intensity(centerIdx - center, GRADIENT_SIGMA);
			const farIntensity = gaussian_intensity(0 - center, GRADIENT_SIGMA);
			expect(peakIntensity).toBeGreaterThan(farIntensity);
		}
		reset_gradient_colorizer();
	});

	test("all presets use the unified edge padding", () => {
		const len = 5;
		const thinkingCenter = compute_sweep_center(1, len, EDGE_PADDING);
		const subagentCenter = compute_sweep_center(1, len, EDGE_PADDING);
		expect(subagentCenter).toBe(thinkingCenter);
		expect(EDGE_PADDING).toBe(Math.ceil(3 * GRADIENT_SIGMA));
	});

	test("accent presets (thinking/working) produce identical output", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Test";
		const r1 = render_gradient(text, "thinking", 0.3);
		const r2 = render_gradient(text, "working", 0.3);
		expect(r1).toBe(r2);
		reset_gradient_colorizer();
	});

	test("muted-text presets (exploringGroup/actionGroup) produce identical output", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Exploring";
		const r1 = render_gradient(text, "exploringGroup", 0.4);
		const r2 = render_gradient(text, "actionGroup", 0.4);
		expect(r1).toBe(r2);
		reset_gradient_colorizer();
	});

	test("accent and muted-text presets produce different output", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "Test";
		const accentResult = render_gradient(text, "thinking", 0.5);
		const mutedResult = render_gradient(text, "exploringGroup", 0.5);
		expect(accentResult).not.toBe(mutedResult);
		reset_gradient_colorizer();
	});

	test("phase 0 and phase 1 produce different sweep positions", () => {
		set_gradient_colorizer(forcedColorizer);
		const text = "abcdefghij";
		const r0 = render_gradient(text, "thinking", 0);
		const r1 = render_gradient(text, "thinking", 0.5);
		expect(r0).not.toBe(r1);
		reset_gradient_colorizer();
	});

	test("color output uses truecolor ANSI in forced-color mode", () => {
		set_gradient_colorizer(forcedColorizer);
		const result = render_gradient("Test", "thinking", 0.5);
		expect(result).toContain("\x1b[38;2;");
		expect(result).toContain("\x1b[39m");
		reset_gradient_colorizer();
	});

	test("invalidate_gradient_cache does not throw", () => {
		expect(() => invalidate_gradient_cache()).not.toThrow();
	});

	test("constants are defined once with expected values", () => {
		expect(GRADIENT_TICK_MS).toBe(50);
		expect(GRADIENT_SIGMA).toBe(3.0);
		expect(EDGE_PADDING).toBe(Math.ceil(3 * GRADIENT_SIGMA));
		expect(GRADIENT_DURATION_MS).toBe(1600);
	});

	test("clock: activate/deactivate does not throw", () => {
		activate_gradient("test-reason");
		deactivate_gradient("test-reason");
	});

	test("clock: subscribe/unsubscribe does not throw", () => {
		const cb = () => {};
		subscribe_gradient_tick(cb);
		unsubscribe_gradient_tick(cb);
	});

	test("clock: shutdown clears all state", () => {
		activate_gradient("test-reason");
		const cb = () => {};
		subscribe_gradient_tick(cb);
		shutdown_gradient_clock();
		expect(get_gradient_phase()).toBe(0);
	});

	test("clock: get_gradient_phase returns 0 when clock is stopped", () => {
		shutdown_gradient_clock();
		expect(get_gradient_phase()).toBe(0);
	});

	test("GradientPreset type covers required semantic presets", () => {
		const presets: GradientPreset[] = [
			"thinking",
			"working",
			"exploringGroup",
			"actionGroup",
			"subagent",
		];
		expect(presets.length).toBe(5);
	});

	// -----------------------------------------------------------------------
	// Mutation-safety regression tests — dispatch_gradient_tick must use a
	// stable snapshot so callbacks that rebind/remove/add during dispatch
	// cannot create an unbounded same-tick loop.
	// -----------------------------------------------------------------------

	test("dispatch: callback that removes itself and adds a replacement does not trigger replacement in same tick", () => {
		shutdown_gradient_clock();
		let call_count = 0;
		const replacement = (): void => {
			call_count++;
		};
		const original = (): void => {
			call_count++;
			unsubscribe_gradient_tick(original);
			subscribe_gradient_tick(replacement);
		};
		subscribe_gradient_tick(original);
		dispatch_gradient_tick();
		expect(call_count).toBe(1);
		shutdown_gradient_clock();
	});

	test("dispatch: callback rebind cannot loop indefinitely", () => {
		shutdown_gradient_clock();
		let iterations = 0;
		const max_iterations = 100;
		let current_cb: (() => void) | undefined;
		const rebind = (): void => {
			iterations++;
			if (iterations >= max_iterations) return;
			if (current_cb) {
				unsubscribe_gradient_tick(current_cb);
			}
			const next = (): void => {
				iterations++;
				if (iterations >= max_iterations) return;
				unsubscribe_gradient_tick(next);
				subscribe_gradient_tick(rebind);
				current_cb = rebind;
			};
			subscribe_gradient_tick(next);
			current_cb = next;
		};
		current_cb = rebind;
		subscribe_gradient_tick(rebind);
		dispatch_gradient_tick();
		expect(iterations).toBeLessThan(max_iterations);
		expect(iterations).toBe(1);
		shutdown_gradient_clock();
	});

	test("dispatch: removed callback is not called even if in snapshot", () => {
		shutdown_gradient_clock();
		let called_a = false;
		let called_b = false;
		const cb_a = (): void => {
			called_a = true;
			unsubscribe_gradient_tick(cb_b);
		};
		const cb_b = (): void => {
			called_b = true;
		};
		subscribe_gradient_tick(cb_a);
		subscribe_gradient_tick(cb_b);
		dispatch_gradient_tick();
		expect(called_a).toBe(true);
		expect(called_b).toBe(false);
		shutdown_gradient_clock();
	});

	test("dispatch: newly added callback waits for next tick", () => {
		shutdown_gradient_clock();
		let first_tick_new_called = false;
		const new_cb = (): void => {
			first_tick_new_called = true;
		};
		const original = (): void => {
			subscribe_gradient_tick(new_cb);
		};
		subscribe_gradient_tick(original);
		dispatch_gradient_tick();
		expect(first_tick_new_called).toBe(false);
		dispatch_gradient_tick();
		expect(first_tick_new_called).toBe(true);
		shutdown_gradient_clock();
	});

	test("dispatch: render_request_fn is called once per tick", () => {
		shutdown_gradient_clock();
		let render_count = 0;
		set_gradient_render_request(() => {
			render_count++;
		});
		dispatch_gradient_tick();
		dispatch_gradient_tick();
		expect(render_count).toBe(2);
		set_gradient_render_request(undefined);
		shutdown_gradient_clock();
	});

	test("dispatch: errors in one callback do not prevent subsequent callbacks", () => {
		shutdown_gradient_clock();
		let called_after_error = false;
		const throwing_cb = (): void => {
			throw new Error("test error");
		};
		const safe_cb = (): void => {
			called_after_error = true;
		};
		subscribe_gradient_tick(throwing_cb);
		subscribe_gradient_tick(safe_cb);
		expect(() => dispatch_gradient_tick()).not.toThrow();
		expect(called_after_error).toBe(true);
		shutdown_gradient_clock();
	});
});
