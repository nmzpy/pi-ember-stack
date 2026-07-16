// gradient.ts — Canonical terminal gradient engine + unified animation clock.
//
// Single source of truth for every terminal Gaussian gradient: Thinking,
// Working, compact group headers, running subagent labels, and the startup
// logo highlight. One elapsed-time phase, one Gaussian helper, one RGB
// interpolation, one Chalk colorizer, one 20 FPS clock.

import chalk from "chalk";
import {
	getActiveModeColor,
	hexToRgbTriplet,
	MUTED_COLOR,
	PAGE_BG,
	TEXT_COLOR,
} from "./mode-colors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Rgb = [number, number, number];

/** Semantic gradient preset. Each maps to a shared base palette. */
export type GradientPreset = "thinking" | "working" | "exploringGroup" | "actionGroup" | "subagent";

/** Muted→text sweep for compact group headers and running subagent labels. */
export const MUTED_GROUP_GRADIENT_PRESET: GradientPreset = "exploringGroup";

type GradientStop = {
	rgb: Rgb;
	position: number;
};

type GradientPalette = {
	stops: GradientStop[];
};

// ---------------------------------------------------------------------------
// Constants — defined once, shared by all consumers
// ---------------------------------------------------------------------------

/** Tick interval: 20 FPS (50 ms). */
export const GRADIENT_TICK_MS = 50;

/** Sweep cycle duration: 1.6 s (faster sweep feels more responsive). */
export const GRADIENT_DURATION_MS = 1600;

/** Logo sweep round-trip duration: 3.2 s (1.6 s right, 1.6 s left). */
export const LOGO_DURATION_MS = 3200;

/** Gaussian sigma in character-cell units. Wider bright region for smoother sweep. */
export const GRADIENT_SIGMA = 3.0;

/** Edge padding in character cells — the sweep enters/exits offscreen.
 *  9 = ceil(3 * GRADIENT_SIGMA) ensures the Gaussian fully exits the text
 *  before the phase wraps from 1→0, preventing a visible snap-restart on
 *  all presets (thinking, working, subagent, group headers). */
export const EDGE_PADDING = Math.ceil(3 * GRADIENT_SIGMA);

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

/** Clamped linear interpolation between two RGB triplets. */
export function clamp_lerp(a: Rgb, b: Rgb, t: number): Rgb {
	const clamped = Math.max(0, Math.min(1, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * clamped),
		Math.round(a[1] + (b[1] - a[1]) * clamped),
		Math.round(a[2] + (b[2] - a[2]) * clamped),
	];
}

/** Gaussian intensity: exp(-d² / (2σ²)). Peak 1.0 at d=0, falls off smoothly. */
export function gaussian_intensity(dist: number, sigma: number): number {
	return Math.exp(-(dist * dist) / (2 * sigma * sigma));
}

/**
 * Offscreen-to-offscreen sweep center. At phase 0 the center is
 * -EDGE_PADDING (offscreen left); at phase 1 it is (len-1)+EDGE_PADDING
 * (offscreen right). The Gaussian enters and exits cleanly — no circular
 * wrap.
 */
export function compute_sweep_center(phase: number, len: number, edge_padding: number): number {
	const span = Math.max(0, len - 1) + 2 * edge_padding;
	return -edge_padding + phase * span;
}

/** Piecewise linear interpolation through gradient stops. */
function sample_palette(palette: GradientPalette, t: number): Rgb {
	const stops = palette.stops;
	if (stops.length === 0) return [128, 128, 128];
	if (stops.length === 1) return stops[0].rgb;
	const clamped = Math.max(0, Math.min(1, t));
	for (let i = 0; i < stops.length - 1; i++) {
		const a = stops[i];
		const b = stops[i + 1];
		if (clamped >= a.position && clamped <= b.position) {
			const range = b.position - a.position;
			const local_t = range > 0 ? (clamped - a.position) / range : 0;
			return clamp_lerp(a.rgb, b.rgb, local_t);
		}
	}
	return stops[stops.length - 1].rgb;
}

// ---------------------------------------------------------------------------
// Palette definitions — derived from mode-colors SSOT, cached per generation
// ---------------------------------------------------------------------------

let cached_accent_palette: GradientPalette | undefined;
let cached_muted_text_palette: GradientPalette | undefined;

/** Clear cached palettes — call when the live theme/accent changes. */
export function invalidate_gradient_cache(): void {
	cached_accent_palette = undefined;
	cached_muted_text_palette = undefined;
}

/**
 * Accent palette: 3-stop RGB-space blend.
 *   muted 10% tail (position 0) → dim 40% (position 0.5) → accent peak (position 1)
 * Used by: thinking, working, subagent.
 */
function get_accent_palette(): GradientPalette {
	if (!cached_accent_palette) {
		const accent_rgb = hexToRgbTriplet(getActiveModeColor());
		const bg_rgb = hexToRgbTriplet(PAGE_BG);
		cached_accent_palette = {
			stops: [
				{ rgb: clamp_lerp(bg_rgb, accent_rgb, 0.1), position: 0 },
				{ rgb: clamp_lerp(bg_rgb, accent_rgb, 0.4), position: 0.5 },
				{ rgb: accent_rgb, position: 1 },
			],
		};
	}
	return cached_accent_palette;
}

/**
 * Muted→text palette: 2-stop blend, no accent color.
 *   muted (position 0) → text (position 1)
 * Used by: exploringGroup, actionGroup.
 */
function get_muted_text_palette(): GradientPalette {
	if (!cached_muted_text_palette) {
		cached_muted_text_palette = {
			stops: [
				{ rgb: hexToRgbTriplet(MUTED_COLOR), position: 0 },
				{ rgb: hexToRgbTriplet(TEXT_COLOR), position: 1 },
			],
		};
	}
	return cached_muted_text_palette;
}

/** Map a semantic preset to its canonical palette. */
function get_preset_palette(preset: GradientPreset): GradientPalette {
	switch (preset) {
		case "thinking":
		case "working":
		case "subagent":
			return get_accent_palette();
		case "exploringGroup":
		case "actionGroup":
			return get_muted_text_palette();
	}
}

// ---------------------------------------------------------------------------
// Colorization — Chalk in production, injectable for tests
// ---------------------------------------------------------------------------

export type Colorizer = (rgb: Rgb, text: string) => string;

const default_colorizer: Colorizer = (rgb, text) => chalk.rgb(rgb[0], rgb[1], rgb[2])(text);

let colorize_fn: Colorizer = default_colorizer;

/** Inject a deterministic colorizer for tests. */
export function set_gradient_colorizer(fn: Colorizer): void {
	colorize_fn = fn;
}

/** Restore the default Chalk colorizer. */
export function reset_gradient_colorizer(): void {
	colorize_fn = default_colorizer;
}

// ---------------------------------------------------------------------------
// Gradient rendering
// ---------------------------------------------------------------------------

/**
 * Render a Gaussian gradient sweep across `text` at the given `phase`.
 * Uses code-point iteration ([...text]) for correct Unicode handling.
 * Empty/short labels are safe (no division by zero).
 */
export function render_gradient(text: string, preset: GradientPreset, phase: number): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return "";
	const palette = get_preset_palette(preset);
	const center = compute_sweep_center(phase, len, EDGE_PADDING);
	const result: string[] = [];
	for (let i = 0; i < len; i++) {
		const dist = i - center;
		const intensity = gaussian_intensity(dist, GRADIENT_SIGMA);
		const rgb = sample_palette(palette, intensity);
		result.push(colorize_fn(rgb, chars[i]));
	}
	return result.join("");
}

// ---------------------------------------------------------------------------
// Unified animation clock — one 20 FPS timer for all gradient consumers
// ---------------------------------------------------------------------------

const active_reasons = new Set<string>();
const tick_subscribers = new Set<() => void>();
let gradient_timer: ReturnType<typeof setInterval> | undefined;
let clock_start = 0;
let render_request_fn: (() => void) | undefined;

/** Set the render-request callback (called once per tick). */
export function set_gradient_render_request(fn: (() => void) | undefined): void {
	render_request_fn = fn;
}

/** Current sweep phase in [0, 1), computed from elapsed monotonic time. */
export function get_gradient_phase(): number {
	if (clock_start === 0) return 0;
	const elapsed = performance.now() - clock_start;
	return (elapsed % GRADIENT_DURATION_MS) / GRADIENT_DURATION_MS;
}

/** Sweep phase with a per-subagent offset in ms, so parallel subagents
 *  animate with staggered phases instead of in perfect sync. */
export function get_gradient_phase_with_offset(offsetMs: number): number {
	if (clock_start === 0) return 0;
	const elapsed = performance.now() - clock_start + offsetMs;
	return (elapsed % GRADIENT_DURATION_MS) / GRADIENT_DURATION_MS;
}

/** Logo phase: ping-pong triangle wave over LOGO_DURATION_MS.
 *  0 → 1 (sweep right) → 0 (sweep left) → repeat. No snap-back. */
export function get_logo_phase(): number {
	if (clock_start === 0) return 0;
	const elapsed = performance.now() - clock_start;
	const t = (elapsed % LOGO_DURATION_MS) / LOGO_DURATION_MS;
	return t < 0.5 ? t * 2 : 2 - t * 2;
}

/**
 * Dispatch one tick to all current subscribers. Exposed for deterministic
 * mutation-safety tests — production dispatch goes through the interval
 * timer which calls this.
 *
 * A stable snapshot of subscribers is captured at the start of each
 * dispatch. Callbacks that unsubscribe themselves, remove other
 * callbacks, or add/rebind replacements during dispatch are safe:
 * newly-added callbacks are NOT visited in the current dispatch (they
 * wait for the next tick) and removed callbacks are skipped (they are
 * absent from the live set). This prevents the JavaScript Set
 * live-iteration hazard where a callback rebinds its own invalidate
 * during the same iteration, causing the newly-added callback to be
 * visited again indefinitely.
 */
export function dispatch_gradient_tick(): void {
	render_request_fn?.();
	const snapshot = [...tick_subscribers];
	for (const cb of snapshot) {
		if (!tick_subscribers.has(cb)) continue;
		try {
			cb();
		} catch {
			/* best effort — same contract as before */
		}
	}
}

function maybe_start_clock(): void {
	if (gradient_timer) return;
	if (active_reasons.size === 0 && tick_subscribers.size === 0) return;
	clock_start = performance.now();
	gradient_timer = setInterval(dispatch_gradient_tick, GRADIENT_TICK_MS);
}

function maybe_stop_clock(): void {
	if (!gradient_timer) return;
	if (active_reasons.size > 0 || tick_subscribers.size > 0) return;
	clearInterval(gradient_timer);
	gradient_timer = undefined;
	clock_start = 0;
}

/** Mark a reason (e.g. "thinking", "working", "logo") as active. */
export function activate_gradient(reason: string): void {
	active_reasons.add(reason);
	maybe_start_clock();
}

/** Mark a reason as inactive. Clock stops when no reasons/subscribers remain. */
export function deactivate_gradient(reason: string): void {
	active_reasons.delete(reason);
	maybe_stop_clock();
}

/** Subscribe to gradient tick events. Keeps the clock alive while subscribed. */
export function subscribe_gradient_tick(cb: () => void): void {
	tick_subscribers.add(cb);
	maybe_start_clock();
}

/** Unsubscribe from gradient tick events. */
export function unsubscribe_gradient_tick(cb: () => void): void {
	tick_subscribers.delete(cb);
	maybe_stop_clock();
}

/** Full reset for session replacement/shutdown. */
export function shutdown_gradient_clock(): void {
	active_reasons.clear();
	tick_subscribers.clear();
	if (gradient_timer) {
		clearInterval(gradient_timer);
		gradient_timer = undefined;
	}
	clock_start = 0;
	render_request_fn = undefined;
	invalidate_gradient_cache();
}
