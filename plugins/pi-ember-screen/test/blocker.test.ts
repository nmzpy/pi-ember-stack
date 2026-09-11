import { describe, expect, test } from "bun:test";
import { blocker_message } from "../platform/win32.ts";

/**
 * Why a window produced no pixels.
 *
 * The ladder is PrintWindow -> compositor (WGC) -> screen copy, so the message
 * describes the state that survived all three: a fullscreen owner, a minimized
 * window, an app that stopped answering, or another window simply on top. The
 * compositor's own reason is appended when there is one, so a failure that is
 * not about z-order is never mislabeled as a covering window.
 */

const base = { process: "", handle: 0, minimized: false, hung: false, fullscreen: "", compositor_reason: "" };

describe("background capture blocker messages", () => {
	test("a fullscreen owner is named, with the actions that actually help", () => {
		const message = blocker_message({
			...base,
			process: "brave",
			handle: 131742,
			fullscreen: "cs2",
		});
		expect(message).toContain("brave");
		expect(message).toContain("131742");
		expect(message).toContain("cs2");
		expect(message).toContain("stops compositing every other window");
		expect(message).toContain("windowed");
		// It must not send the caller into a pointless bring-to-front retry.
		expect(message).not.toContain("Bring it to the front");
	});

	test("a minimized window gets its own instruction", () => {
		const message = blocker_message({ ...base, process: "explorer", handle: 42, minimized: true });
		expect(message).toContain("minimized");
		expect(message).toContain("Restore it");
	});

	test("an app that stopped answering is not told to bring itself forward", () => {
		const message = blocker_message({ ...base, process: "python", handle: 77, hung: true });
		expect(message).toContain("python");
		expect(message).toContain("not responding");
		expect(message).toContain("recover");
		expect(message).not.toContain("Bring it to the front");
	});

	test("a covering window is distinguished from the fullscreen case", () => {
		const message = blocker_message({ ...base, process: "ChatGPT", handle: 7 });
		expect(message).toContain("covering it");
		expect(message).toContain("Bring it to the front");
	});

	test("fullscreen wins over minimized, because it affects every window", () => {
		const message = blocker_message({ ...base, process: "ChatGPT", handle: 7, minimized: true, fullscreen: "cs2" });
		expect(message).toContain("cs2");
		expect(message).not.toContain("Restore it");
	});

	test("the compositor's reason is carried through when there is one", () => {
		const withReason = blocker_message({
			...base,
			process: "python",
			handle: 26368,
			compositor_reason: "The compositor produced no frame for window 26368 within 1500 ms.",
		});
		expect(withReason).toContain("Compositor capture failed too");
		expect(withReason).toContain("within 1500 ms");

		const withoutReason = blocker_message({ ...base, process: "python", handle: 26368 });
		expect(withoutReason).not.toContain("Compositor capture failed too");
	});
});
