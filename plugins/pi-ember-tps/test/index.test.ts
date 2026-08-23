import { describe, expect, test } from "bun:test";
import { format_live_tps, getLiveTpsOpacity } from "../index.ts";

describe("TPS meter", () => {
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
});
