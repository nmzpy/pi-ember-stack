import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	get_fresh_context_mode,
	get_new_session_fn,
	install_new_session_capture,
	reset_new_session_capture_for_tests,
	seed_fresh_context_mode,
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

	test("persists and restores the selected fresh-context mode", () => {
		const entries: unknown[] = [];
		seed_fresh_context_mode(
			{
				appendCustomEntry(customType, data) {
					entries.push({ type: "custom", customType, data });
					return "entry-id";
				},
			},
			"orchestrate",
		);

		expect(
			get_fresh_context_mode(
				{ sessionManager: { getEntries: () => entries } },
				["code", "orchestrate"],
			),
		).toBe("orchestrate");
	});

	test("ignores invalid fresh-context mode markers", () => {
		expect(
			get_fresh_context_mode(
				{
					sessionManager: {
						getEntries: () => [
								{
									type: "custom",
									customType: "pi-agents-fresh-context-mode",
									data: { mode: "plan" },
								},
							],
					},
				},
				["code", "orchestrate"],
			),
		).toBeUndefined();
	});

	test("does not override a later explicit mode entry", () => {
		const entries: unknown[] = [];
		seed_fresh_context_mode(
			{
				appendCustomEntry(customType, data) {
					entries.push({ type: "custom", customType, data });
					return "entry-id";
				},
			},
			"code",
		);
		entries.push({
			type: "custom_message",
			customType: "pi-agents-enter-plan",
		});
		expect(
			get_fresh_context_mode({ sessionManager: { getEntries: () => entries } }, ["code"]),
		).toBeUndefined();
	});
});
