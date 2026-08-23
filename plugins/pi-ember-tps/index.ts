/**
 * Ember TPS Meter — minimal tokens-per-second tracker
 *
 * Tracks output plus thinking token rate during streaming and exposes the live
 * value via getLiveTps() for the custom footer to render. The footer pulls the
 * value on every natural Pi render (message_update / message_end / footer
 * stats recompute); this plugin NEVER requests renders itself and NEVER
 * subscribes a periodic timer. While the agent is settled the meter is inert
 * — zero periodic renders, zero gradient-clock subscriptions — so terminal
 * scrollback and text selection stay untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let streamStartMs = 0;
let firstTokenMs = 0;
let streamChars = 0;
let streamThinkingChars = 0;
let streamTokens = 0;
let streaming = false;
let liveTps = 0;
let lastActivityMs = 0;

function now(): number {
	return performance.now();
}

function tokEst(ch: number): number {
	return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

/** TPS meter opacity: fully visible while streaming, hidden when idle.
 *  No fade animation — a fade would require a periodic render clock that
 *  fights terminal scrollback. The footer pulls this on natural renders. */
export function getLiveTpsOpacity(_at_ms = now()): number {
	if (liveTps <= 0 || lastActivityMs <= 0) return 0;
	if (streaming) return 1;
	return 0;
}

export function format_live_tps(tps: number): string {
	return tps < 10 ? tps.toFixed(1) : tps < 100 ? tps.toFixed(0) : `${Math.round(tps)}`;
}

function computeTps(): number {
	const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
	const elapsed = (now() - ref) / 1000;
	return elapsed > 0.3 ? streamTokens / elapsed : 0;
}

export function getLiveTps(): number {
	return liveTps;
}

export default function piEmberTps(pi: ExtensionAPI): void {
	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		streamStartMs = now();
		firstTokenMs = 0;
		streamChars = 0;
		streamThinkingChars = 0;
		streamTokens = 0;
		liveTps = 0;
		lastActivityMs = streamStartMs;
		streaming = true;
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
			// Live TPS is read by the footer on the natural render Pi issues
			// for each message_update; recompute it here so the value is fresh.
			liveTps = computeTps();
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		streaming = false;

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
			return;
		}

		liveTps = tokens / elapsed;
		lastActivityMs = now();
		// The final TPS value is pulled by the footer on the natural render
		// Pi issues for message_end (footer stats recompute). Once streaming
		// is false, getLiveTpsOpacity() returns 0 and the meter hides on the
		// next render — no fade, no periodic render clock.
	});

	pi.on("agent_end", async () => {
		streaming = false;
	});

	pi.on("session_start", async () => {
		streaming = false;
		streamStartMs = 0;
		firstTokenMs = 0;
		streamChars = 0;
		streamThinkingChars = 0;
		streamTokens = 0;
		liveTps = 0;
		lastActivityMs = 0;
	});

	pi.on("session_shutdown", async () => {
		streaming = false;
		streamStartMs = 0;
		firstTokenMs = 0;
		streamChars = 0;
		streamThinkingChars = 0;
		streamTokens = 0;
		liveTps = 0;
		lastActivityMs = 0;
	});
}
