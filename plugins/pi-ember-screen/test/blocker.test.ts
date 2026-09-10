import { describe, expect, test } from "bun:test";
import { blocker_message } from "../platform/win32.ts";

/**
 * Why a background capture produced no pixels.
 *
 * Windows stops rendering covered windows while a fullscreen application owns
 * the display, so PrintWindow hands back an empty surface and a screen-region
 * copy would return the wrong window's pixels. The message must name the real
 * cause — a vague "failed" sends the model into retry loops and tells the
 * operator nothing.
 */

describe("background capture blocker messages", () => {
	test("a fullscreen owner is named, with the actions that actually help", () => {
		const message = blocker_message({
			process: "brave",
			handle: 131742,
			minimized: false,
			fullscreen: "cs2",
		});
		expect(message).toContain("brave");
		expect(message).toContain("131742");
		expect(message).toContain("cs2");
		expect(message).toContain("does not render covered windows");
		expect(message).toContain("windowed");
		// It must not send the caller into a pointless bring-to-front retry.
		expect(message).not.toContain("Bring it to the front");
	});

	test("a minimized window gets its own instruction", () => {
		const message = blocker_message({ process: "explorer", handle: 42, minimized: true, fullscreen: "" });
		expect(message).toContain("minimized");
		expect(message).toContain("Restore it");
	});

	test("a covering window is distinguished from the fullscreen case", () => {
		const message = blocker_message({ process: "ChatGPT", handle: 7, minimized: false, fullscreen: "" });
		expect(message).toContain("covering it");
		expect(message).toContain("Bring it to the front");
	});

	test("fullscreen wins over minimized, because it affects every window", () => {
		const message = blocker_message({ process: "ChatGPT", handle: 7, minimized: true, fullscreen: "cs2" });
		expect(message).toContain("cs2");
		expect(message).not.toContain("Restore it");
	});
});
