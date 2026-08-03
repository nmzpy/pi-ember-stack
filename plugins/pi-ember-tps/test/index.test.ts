import { describe, expect, test } from "bun:test";
import {
	calculate_tps_fade_opacity,
	format_live_tps,
	TPS_FADE_DURATION_MS,
	TPS_IDLE_FADE_DELAY_MS,
} from "../index.ts";

describe("TPS fade", () => {
	test("stays opaque through the idle delay and fades to zero", () => {
		expect(TPS_FADE_DURATION_MS).toBe(250);
		expect(calculate_tps_fade_opacity(0)).toBe(1);
		expect(calculate_tps_fade_opacity(TPS_IDLE_FADE_DELAY_MS)).toBe(1);
		expect(
			calculate_tps_fade_opacity(
				TPS_IDLE_FADE_DELAY_MS + TPS_FADE_DURATION_MS / 4,
			),
		).toBeCloseTo(0.8535533906, 8);
		expect(
			calculate_tps_fade_opacity(
				TPS_IDLE_FADE_DELAY_MS + TPS_FADE_DURATION_MS / 2,
			),
		).toBe(0.5);
		expect(
			calculate_tps_fade_opacity(TPS_IDLE_FADE_DELAY_MS + TPS_FADE_DURATION_MS),
		).toBe(0);
	});

	test("formats the displayed TPS value", () => {
		expect(format_live_tps(4.25)).toBe("4.3");
		expect(format_live_tps(42.4)).toBe("42");
		expect(format_live_tps(142.4)).toBe("142");
	});
});
