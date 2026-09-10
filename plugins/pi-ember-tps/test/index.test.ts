import { afterEach, describe, expect, test } from "bun:test";
import {
	begin_aux_stream,
	end_aux_stream,
	format_live_tps,
	getLiveTps,
	getLiveTpsOpacity,
	note_aux_delta,
} from "../index.ts";

describe("TPS meter", () => {
	afterEach(() => {
		end_aux_stream();
	});

	test("opacity is fully visible while streaming and hidden when idle", () => {
		// The meter is read-only by the footer on natural Pi renders. There is
		// no fade animation and no periodic render clock — a fade would
		// require a 50ms timer that fights terminal scrollback/selection.
		// While idle the opacity is 0 so the footer omits the segment.
		expect(getLiveTpsOpacity()).toBe(0);
	});

	test("formats the displayed TPS value", () => {
		expect(format_live_tps(4.25)).toBe("4.3");
		expect(format_live_tps(42.4)).toBe("42");
		expect(format_live_tps(142.4)).toBe("142");
	});

	test("aux stream (compaction summarizer) drives a visible meter", async () => {
		// `begin_aux_stream` + `note_aux_delta` are the manual driver for
		// streams that emit no transcript `message_*` events (compaction
		// summarization). The footer reads the same shared state on the 20 FPS
		// renders the `• Compacting` row already issues.
		begin_aux_stream();
		note_aux_delta("a".repeat(400), false);
		// Cross the 300 ms warm-up so a rate exists.
		await new Promise((resolve) => setTimeout(resolve, 350));
		note_aux_delta("b".repeat(400), true);
		expect(getLiveTps()).toBeGreaterThan(0);
		expect(getLiveTpsOpacity()).toBe(1);
		// The span ends with the summarization; the segment hides again.
		end_aux_stream();
		expect(getLiveTpsOpacity()).toBe(0);
	});
});
