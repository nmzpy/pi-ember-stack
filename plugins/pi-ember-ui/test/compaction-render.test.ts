import { describe, expect, test } from "bun:test";
import {
	COMPACTION_GRADIENT_PRESET,
	bind_compaction_status_indicator,
	format_compacted_row,
	format_compacting_row,
	render_compacting_gradient_label,
	unbind_compaction_status_indicator,
} from "../compaction-render.ts";
import {
	activate_gradient,
	deactivate_gradient,
	dispatch_gradient_tick,
	get_gradient_phase,
	render_gradient,
	reset_gradient_colorizer,
	set_gradient_colorizer,
	set_gradient_render_request,
	shutdown_gradient_clock,
} from "../gradient.ts";

const theme = {
	fg: (_tag: string, text: string) => text,
	bold: (text: string) => text,
};

describe("compaction render rows", () => {
	test("running row uses Compacting label with bullet prefix and a leading pad row", () => {
		const [pad, line] = format_compacting_row(theme, 80);
		expect(pad).toBe("");
		expect(line).toContain("Compacting");
		expect(line.startsWith("•")).toBe(true);
	});

	test("compacting gradient uses thinking preset sweep", () => {
		expect(COMPACTION_GRADIENT_PRESET).toBe("thinking");
		activate_gradient("compaction");
		const colors: string[] = [];
		set_gradient_colorizer((rgb, text) => {
			colors.push(`${rgb.join(",")}:${text}`);
			return text;
		});
		const label = render_compacting_gradient_label();
		const expected = render_gradient("Compacting", "thinking", get_gradient_phase());
		expect(label).toBe(expected);
		expect(colors.length).toBeGreaterThan(0);
		reset_gradient_colorizer();
		deactivate_gradient("compaction");
	});

	test("compaction status indicator invalidates and the gradient clock requests one native render per tick", () => {
		shutdown_gradient_clock();
		let invalidations = 0;
		let render_requests = 0;
		set_gradient_render_request(() => {
			render_requests += 1;
		});
		bind_compaction_status_indicator({
			invalidate: () => {
				invalidations += 1;
			},
		});
		activate_gradient("compaction");
		dispatch_gradient_tick();
		// The tick stages the row; the clock owns the single native render.
		expect(invalidations).toBe(1);
		expect(render_requests).toBe(1);
		unbind_compaction_status_indicator();
		deactivate_gradient("compaction");
		dispatch_gradient_tick();
		expect(invalidations).toBe(1);
		expect(render_requests).toBe(1);
		set_gradient_render_request(undefined);
		shutdown_gradient_clock();
	});

	test("completed row uses Compacted stats line", () => {
		const line = format_compacted_row(theme, 337_510, 3044);
		expect(line).toContain("Compacted");
		expect(line).toContain("337,510");
		expect(line).toContain("~761.");
		expect(line).not.toContain("Summarized");
	});
});
