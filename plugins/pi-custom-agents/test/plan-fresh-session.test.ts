import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	get_new_session_fn,
	install_new_session_capture,
	reset_new_session_capture_for_tests,
} from "../plan-fresh-session.ts";

describe("plan-fresh-session", () => {
	test("bindCommandContext capture exposes newSession to event handlers", async () => {
		reset_new_session_capture_for_tests();
		install_new_session_capture();

		const mockNewSession = async () => ({ cancelled: false });
		const runner = {
			bindCommandContext(_actions?: { newSession?: typeof mockNewSession }) {
				return undefined;
			},
		};

		ExtensionRunner.prototype.bindCommandContext.call(runner, {
			newSession: mockNewSession,
		});

		const captured = get_new_session_fn();
		expect(typeof captured).toBe("function");
		await expect(captured?.({})).resolves.toEqual({ cancelled: false });
	});
});
