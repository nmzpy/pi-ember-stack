import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CompactGroupText } from "../../pi-compact-tools/renderer.ts";
import { DEFAULT_FORMAT } from "../encode.ts";
import {
	format_unavailable_row,
	format_window_list_row,
	format_window_screenshot_row,
	render_screen_details,
	render_screen_row,
	type ScreenTheme,
	type WindowEntry,
	window_list_detail_lines,
	window_screenshot_detail_lines,
} from "../render.ts";

/**
 * Compact row contract for the screen tools.
 *
 * Both tools render one bullet-led, ANSI-truncated row through the shared
 * pi-compact-tools primitives (BULLET, statusBulletColor, CompactGroupText).
 * These tests pin the properties the transcript depends on:
 *
 * 1. The row is a single line that never exceeds the width Pi supplies, so a
 *    long window path or failure message can never wrap or crash the TUI.
 * 2. The bullet is the only state indicator: muted while running, success when
 *    done, error on failure — and no tool background is requested.
 * 3. The row is updated in place, so a call never grows a second row.
 */

/** Fake theme: tags every color so assertions can see which token was used. */
const theme: ScreenTheme = {
	fg: (key, text) => `<${key}>${text}</${key}>`,
	bold: (text) => text,
};

function bullet_color(themeLike: ScreenTheme, key: string): string {
	return `${themeLike.fg(key as never, "• ")}`;
}

function entry(overrides: Partial<WindowEntry> = {}): WindowEntry {
	return {
		handle: 131742,
		pid: 15520,
		process: "brave",
		title: "Ember - End-To-End Production - Brave",
		left: 915,
		top: 60,
		width: 2520,
		height: 2041,
		visible: true,
		minimized: false,
		...overrides,
	};
}

describe("window_list compact row", () => {
	test("running row shows the present-tense verb and the filter hints", () => {
		const row = format_window_list_row(theme, { filter: "brave", limit: 10, include_minimized: true }, false, false);
		expect(row).toContain("Listing");
		expect(row).toContain('"brave"');
		expect(row).toContain("limit 10");
		expect(row).toContain("incl. minimized");
		expect(row.startsWith(bullet_color(theme, "muted"))).toBe(true);
	});

	test("completed row reports the count and the not-responding total", () => {
		const row = format_window_list_row(theme, {}, true, false, "", 18, 2);
		expect(row).toContain("Listed");
		expect(row).toContain("18 windows");
		expect(row).toContain("2 not responding");
		expect(row.startsWith(bullet_color(theme, "success"))).toBe(true);
	});

	test("completed row uses the singular form for one window", () => {
		expect(format_window_list_row(theme, {}, true, false, "", 1, 0)).toContain("1 window</text>");
	});

	test("error row carries the failure reason and the error bullet", () => {
		const row = format_window_list_row(theme, {}, true, true, "window helper did not finish within 25s");
		expect(row).toContain("window helper did not finish within 25s");
		expect(row.startsWith(bullet_color(theme, "error"))).toBe(true);
	});

	test("error row collapses a multi-line message onto one row", () => {
		const row = format_window_list_row(theme, {}, true, true, "line one\nline two\tline three");
		expect(row).toContain("line one line two line three");
		expect(row).not.toContain("\n");
	});
});

describe("window_screenshot compact row", () => {
	test("running row names the capture target", () => {
		expect(format_window_screenshot_row(theme, { window: "brave" }, false, false)).toContain('<dim> "brave"</dim>');
		expect(format_window_screenshot_row(theme, { handle: 131742 }, false, false)).toContain("hwnd 131742");
		expect(format_window_screenshot_row(theme, {}, false, false)).toContain("foreground");
	});

	test("completed row reports the process and the captured size", () => {
		const row = format_window_screenshot_row(theme, { window: "brave" }, true, false, "", {
			process: "brave",
			width: 400,
			height: 225,
			method: "printwindow",
		});
		expect(row).toContain("Captured");
		expect(row).toContain("brave 400x225");
		expect(row).not.toContain("screen-copy");
		expect(row.startsWith(bullet_color(theme, "success"))).toBe(true);
	});

	test("row marks an encoding override but stays quiet about the default", () => {
		const override = format_window_screenshot_row(theme, {}, true, false, "", {
			process: "brave",
			width: 700,
			height: 567,
			method: "printwindow",
			format: "png",
		});
		expect(override).toContain("png");
		const standard = format_window_screenshot_row(theme, {}, true, false, "", {
			process: "brave",
			width: 700,
			height: 567,
			method: "printwindow",
			format: DEFAULT_FORMAT,
		});
		expect(standard).not.toContain(DEFAULT_FORMAT);
	});

	test("completed row flags the screen-copy fallback", () => {
		const row = format_window_screenshot_row(theme, { window: "brave" }, true, false, "", {
			process: "brave",
			width: 400,
			height: 225,
			method: "screen-copy",
		});
		expect(row).toContain("screen-copy");
	});

	test("error row reports a not-responding window instead of hanging", () => {
		const row = format_window_screenshot_row(
			theme,
			{ handle: 1772200 },
			true,
			true,
			"Window 'powershell' (handle 1772200) is not responding to Windows messages, so it cannot be captured.",
		);
		expect(row).toContain("not responding to Windows messages");
		expect(row.startsWith(bullet_color(theme, "error"))).toBe(true);
	});
});

describe("screen row component", () => {
	test("reuses one component across renders and starts in column 0", () => {
		const context = { state: {} as Record<string, unknown>, args: {} };
		const first = render_screen_row(context, "one");
		const second = render_screen_row(context, "two");
		expect(second).toBe(first);
		expect(context.state.callText).toBeInstanceOf(CompactGroupText);
		// The row component is returned directly — no wrapping shell — so the
		// row is not padded with a leading (or trailing) column.
		expect(second.render(60)).toEqual(["two"]);
	});

	test("the bullet starts in column 0, with no padding before it", () => {
		const context = { state: {} as Record<string, unknown>, args: {} };
		const row = render_screen_row(context, format_window_list_row(theme, {}, true, false, "", 13));
		const lines = row.render(90);
		expect(lines.length).toBe(1);
		expect(lines[0].startsWith(bullet_color(theme, "success"))).toBe(true);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(90);
	});

	test("truncates to the width Pi supplies", () => {
		const context = { state: {} as Record<string, unknown>, args: {} };
		const row = render_screen_row(
			context,
			format_window_list_row(theme, { filter: "x".repeat(200) }, false, false),
		);
		for (const line of row.render(40)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	test("a long failure message still renders one in-width row", () => {
		const context = { state: {} as Record<string, unknown>, args: {} };
		const row = render_screen_row(context, format_window_list_row(theme, {}, true, true, "boom ".repeat(200)));
		const lines = row.render(80);
		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(80);
	});
});

describe("expanded detail rows", () => {
	test("an empty detail list renders nothing", () => {
		const details = render_screen_details([]);
		expect(details.render(80)).toEqual([]);
	});

	test("window_list details mark not-responding windows", () => {
		const lines = window_list_detail_lines(theme, [
			entry(),
			entry({ process: "Resolve", title: "DaVinci Resolve Studio", width: 3862, height: 2182, hung: true }),
		]);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("brave");
		expect(lines[0]).toContain("2520x2041");
		expect(lines[0]).toContain("hwnd 131742");
		expect(lines[0]).not.toContain("not responding");
		expect(lines[1]).toContain("not responding");
	});

	test("window_list details truncate instead of wrapping", () => {
		const details = render_screen_details(window_list_detail_lines(theme, [entry({ title: "t".repeat(300) })]));
		for (const line of details.render(50)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		}
	});

	test("window_screenshot details describe the saved file", () => {
		const lines = window_screenshot_detail_lines(theme, {
			path: "C:/tmp/pi-ember-screen-brave.png",
			title: "Ember - End-To-End Production - Brave",
			selection: "match=brave",
			method: "printwindow",
			source_width: 2520,
			source_height: 2041,
		});
		expect(lines.join("\n")).toContain("C:/tmp/pi-ember-screen-brave.png");
		expect(lines.join("\n")).toContain("2520x2041");
		expect(lines.join("\n")).toContain("match=brave");
	});
});

describe("unavailable row", () => {
	test("stays muted and never claims success", () => {
		const row = format_unavailable_row(theme, "List Windows", "Windows only");
		expect(row).toContain("List Windows");
		expect(row).toContain("Windows only");
		expect(row).not.toContain("<success>");
		expect(row).not.toContain("<error>");
	});
});
