import { describe, expect, test } from "bun:test";
import {
	resume_truncate_text,
} from "../model-picker.ts";
import { strip_think_tags } from "../mode-colors.ts";
import { format_image_styled_fallback_label } from "../../pi-ember-images/types.ts";
import {
	SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS,
} from "../../pi-custom-agents/subagent/extensions/runner.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

describe("resume menu layout and label formatting", () => {
	test("resume_truncate_text uses 75% of available width", () => {
		const longText = "A".repeat(200);
		// With contentWidth = 100, 75% = 75 cols
		const truncated100 = resume_truncate_text(longText, 100, 100, 200);
		expect(visibleWidth(truncated100)).toBe(75);

		// With contentWidth = 120, 75% = 90 cols
		const truncated120 = resume_truncate_text(longText, 120, 120, 200);
		expect(visibleWidth(truncated120)).toBe(90);
	});

	test("image fallback label does not leak background color escape codes", () => {
		const styled = format_image_styled_fallback_label(1, { widthPx: 465, heightPx: 120 });
		// Should NOT include the old MUTED_MESSAGE_BG code (38;38;38)
		expect(styled).not.toContain("48;2;38;38;38m");
		// Should restore default bg and fg at the end
		expect(styled).toContain("\x1b[39;49m");
	});

	test("resume_truncate_text handles ANSI-styled image labels without breaking sequences", () => {
		const imgLabel = format_image_styled_fallback_label(1, { widthPx: 465, heightPx: 120 });
		const fullPrompt = `${imgLabel} - lets make Links visual representation look cooler and fix the outline`;
		const truncated = resume_truncate_text(fullPrompt, 80, 80, 200);
		// 80 * 0.75 = 60 visible width
		expect(visibleWidth(truncated)).toBe(60);
		// Contains the full image label and text following it
		expect(truncated).toContain("465x120");
		expect(truncated).toContain("lets make Links");
	});
});

describe("strip_think_tags SSOT", () => {
	test("strips <think> and </think> tags", () => {
		expect(strip_think_tags("<think>reasoning steps</think>")).toBe("reasoning steps");
		expect(strip_think_tags("<think>\nline 1\nline 2\n</think>")).toBe("\nline 1\nline 2\n");
		expect(strip_think_tags("<think>start")).toBe("start");
		expect(strip_think_tags("end</think>")).toBe("end");
	});

	test("strips <thought> and <reasoning> tags", () => {
		expect(strip_think_tags("<thought>internal thoughts</thought>")).toBe("internal thoughts");
		expect(strip_think_tags("<reasoning>model reasoning</reasoning>")).toBe("model reasoning");
	});

	test("handles empty or tag-free strings", () => {
		expect(strip_think_tags("")).toBe("");
		expect(strip_think_tags("normal reasoning text")).toBe("normal reasoning text");
	});
});

describe("subagent retry backoff ladder", () => {
	test("backoff ladder is the canonical [2s, 5s, 10s, 30s, 60s] schedule", () => {
		expect(SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS[0]).toBe(2000);
		expect(SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS[1]).toBe(5000);
		expect(SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS[2]).toBe(10_000);
		expect(SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS[3]).toBe(30_000);
		expect(SUBAGENT_WEBSOCKET_RETRY_BACKOFF_MS[4]).toBe(60_000);
	});
});
