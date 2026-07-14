/**
 * Ember TPS Meter — minimal tokens-per-second tracker
 *
 * Tracks output token rate during streaming and exposes the live value
 * via getLiveTps() for the custom footer to render.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STREAM_INTERVAL_MS = 500;

let streamStartMs = 0;
let firstTokenMs = 0;
let streamChars = 0;
let streamTokens = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let streaming = false;
let liveTps = 0;
let renderTrigger: (() => void) | undefined;

function now(): number {
	return performance.now();
}

function tokEst(ch: number): number {
	return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
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

export function getLiveTps(): number {
	return liveTps;
}

export default function piEmberTps(pi: ExtensionAPI): void {
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		streamStartMs = now();
		firstTokenMs = 0;
		streamChars = 0;
		streamTokens = 0;
		liveTps = 0;
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
			if (firstTokenMs === 0) firstTokenMs = now();
			streamChars += d.length;
			streamTokens = tokEst(streamChars);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		streaming = false;
		stopTick();

		const realOut = event.message?.usage?.output;
		const tokens =
			typeof realOut === "number" && realOut > 0 ? realOut : streamTokens;

		const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
		const elapsed = (now() - ref) / 1000;
		if (elapsed < 0.1 || tokens === 0) {
			liveTps = 0;
			return;
		}

		liveTps = tokens / elapsed;
		renderTrigger?.();
	});

	pi.on("agent_end", async () => {
		streaming = false;
		stopTick();
	});

	pi.on("session_start", async (_event, ctx) => {
		streaming = false;
		stopTick();
		streamStartMs = 0;
		firstTokenMs = 0;
		streamChars = 0;
		streamTokens = 0;
		liveTps = 0;
		renderTrigger = undefined;
		ctx.ui.setStatus("tps", undefined);
	});
}
