/**
 * Ember TPS Meter — minimal tokens-per-second tracker
 *
 * Tracks output plus thinking token rate during streaming and exposes the live
 * value via getLiveTps() for the custom footer to render.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subscribe_gradient_tick, unsubscribe_gradient_tick } from "../pi-ember-ui/gradient.ts";

const STREAM_INTERVAL_MS = 500;

/** Keep the completed TPS meter fully visible before beginning its fade. */
export const TPS_IDLE_FADE_DELAY_MS = 5000;
/** Fade duration after the idle delay; color alpha reaches PAGE_BG at the end. */
export const TPS_FADE_DURATION_MS = 250;

let streamStartMs = 0;
let firstTokenMs = 0;
let streamChars = 0;
let streamThinkingChars = 0;
let streamTokens = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let streaming = false;
let liveTps = 0;
let renderTrigger: (() => void) | undefined;
let lastActivityMs = 0;
let fade_tick_subscribed = false;

function now(): number {
	return performance.now();
}

function tokEst(ch: number): number {
	return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

/** In-out sine alpha curve shared by the completed TPS meter fade. */
export function calculate_tps_fade_opacity(inactivity_ms: number): number {
	if (inactivity_ms <= TPS_IDLE_FADE_DELAY_MS) return 1;
	if (inactivity_ms >= TPS_IDLE_FADE_DELAY_MS + TPS_FADE_DURATION_MS) return 0;
	const progress = (inactivity_ms - TPS_IDLE_FADE_DELAY_MS) / TPS_FADE_DURATION_MS;
	const eased = (1 - Math.cos(Math.PI * progress)) / 2;
	return 1 - eased;
}

export function getLiveTpsOpacity(at_ms = now()): number {
	if (liveTps <= 0 || lastActivityMs <= 0) return 0;
	if (streaming) return 1;
	return calculate_tps_fade_opacity(at_ms - lastActivityMs);
}

export function format_live_tps(tps: number): string {
	return tps < 10 ? tps.toFixed(1) : tps < 100 ? tps.toFixed(0) : `${Math.round(tps)}`;
}

function computeTps(): number {
	const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
	const elapsed = (now() - ref) / 1000;
	return elapsed > 0.3 ? streamTokens / elapsed : 0;
}

function startTick(): void {
	if (tickTimer) return;
	tickTimer = setInterval(() => {
		if (!streaming) {
			stopTick();
			return;
		}
		liveTps = computeTps();
		renderTrigger?.();
	}, STREAM_INTERVAL_MS);
}

function stopTick(): void {
	if (tickTimer) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
}

function stop_fade_tick(): void {
	if (!fade_tick_subscribed) return;
	unsubscribe_gradient_tick(dispatch_fade_tick);
	fade_tick_subscribed = false;
}

function dispatch_fade_tick(): void {
	const opacity = getLiveTpsOpacity();
	if (opacity <= 0) {
		stop_fade_tick();
		liveTps = 0;
	}
	renderTrigger?.();
}

function start_fade_tick(): void {
	if (fade_tick_subscribed || !renderTrigger) return;
	fade_tick_subscribed = true;
	subscribe_gradient_tick(dispatch_fade_tick);
}

export function getLiveTps(): number {
	return liveTps;
}

export default function piEmberTps(pi: ExtensionAPI): void {
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		stop_fade_tick();
		streamStartMs = now();
		firstTokenMs = 0;
		streamChars = 0;
		streamThinkingChars = 0;
		streamTokens = 0;
		liveTps = 0;
		lastActivityMs = streamStartMs;
		streaming = true;
		if (ctx.mode === "tui") {
			renderTrigger = () => ctx.ui.setStatus("tps", undefined);
		}
		startTick();
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		if (!event.assistantMessageEvent) return;
		const evt = event.assistantMessageEvent;
		if (evt.type === "text_delta" || evt.type === "thinking_delta") {
			const d = evt.delta as string;
			if (!d) return;
			const activity_ms = now();
			lastActivityMs = activity_ms;
			if (firstTokenMs === 0) firstTokenMs = activity_ms;
			streamChars += d.length;
			if (evt.type === "thinking_delta") streamThinkingChars += d.length;
			streamTokens = tokEst(streamChars);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		streaming = false;
		stopTick();

		const usage = event.message?.usage;
		const realOut = usage?.output;
		// Some providers report output tokens without their thinking tokens.
		// Keep the streamed combined estimate in that case; providers that
		// expose `reasoning` already include it in `usage.output`.
		const tokens =
			typeof realOut === "number" && realOut > 0
				? streamThinkingChars > 0 && usage?.reasoning === undefined
					? Math.max(realOut, streamTokens)
					: realOut
				: streamTokens;

		const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
		const elapsed = (now() - ref) / 1000;
		if (elapsed < 0.1 || tokens === 0) {
			liveTps = 0;
			lastActivityMs = 0;
			stop_fade_tick();
			renderTrigger?.();
			return;
		}

		liveTps = tokens / elapsed;
		lastActivityMs = now();
		start_fade_tick();
		renderTrigger?.();
	});

	pi.on("agent_end", async () => {
		streaming = false;
		stopTick();
		if (liveTps > 0) {
			if (lastActivityMs === 0) lastActivityMs = now();
			start_fade_tick();
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		streaming = false;
		stopTick();
		stop_fade_tick();
		streamStartMs = 0;
		firstTokenMs = 0;
		streamChars = 0;
		streamThinkingChars = 0;
		streamTokens = 0;
		liveTps = 0;
		lastActivityMs = 0;
		renderTrigger = undefined;
		ctx.ui.setStatus("tps", undefined);
	});

	// Clear the tick interval and stale render trigger on shutdown so a
	// subsequent /resume does not keep a setInterval alive against the dead
	// session's ctx.ui. Without this, the 500ms tick keeps firing and
	// calls the old renderTrigger long after the session is gone.
	pi.on("session_shutdown", async () => {
		streaming = false;
		stopTick();
		stop_fade_tick();
		renderTrigger = undefined;
		liveTps = 0;
		lastActivityMs = 0;
	});
}
