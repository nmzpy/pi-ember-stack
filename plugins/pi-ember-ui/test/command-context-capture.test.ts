import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
	get_new_session_fn,
	get_switch_session_fn,
	install_command_context_capture,
	refresh_switch_session_capture_from_runner,
	reset_command_context_capture_for_tests,
	resolve_switch_session_fn,
} from "../command-context-capture.ts";

describe("command-context-capture", () => {
	test("bindCommandContext captures switchSession and newSession", async () => {
		reset_command_context_capture_for_tests();
		install_command_context_capture();

		const mockSwitchSession = async (path: string) => {
			void path;
			return { cancelled: false };
		};
		const mockNewSession = async () => ({ cancelled: false });

		const runner = {
			bindCommandContext(_actions?: {
				switchSession?: typeof mockSwitchSession;
				newSession?: typeof mockNewSession;
			}) {
				return undefined;
			},
		};

		ExtensionRunner.prototype.bindCommandContext.call(runner, {
			switchSession: mockSwitchSession,
			newSession: mockNewSession,
		});

		expect(typeof get_switch_session_fn()).toBe("function");
		expect(typeof get_new_session_fn()).toBe("function");
		await expect(get_switch_session_fn()?.("/tmp/session.jsonl")).resolves.toEqual({
			cancelled: false,
		});
	});

	test("unbind does not clear previously captured handlers (sticky)", async () => {
		reset_command_context_capture_for_tests();
		install_command_context_capture();

		const mockSwitchSession = async () => ({ cancelled: false });
		const runner = {
			bindCommandContext() {
				return undefined;
			},
		};

		ExtensionRunner.prototype.bindCommandContext.call(runner, {
			switchSession: mockSwitchSession,
		});
		expect(typeof get_switch_session_fn()).toBe("function");

		ExtensionRunner.prototype.bindCommandContext.call(runner, undefined);
		expect(typeof get_switch_session_fn()).toBe("function");
	});

	test("resolve_switch_session_fn prefers live runner createCommandContext", async () => {
		reset_command_context_capture_for_tests();
		install_command_context_capture();

		let live_called = false;
		const runner = {
			createCommandContext() {
				return {
					switchSession: async (path: string) => {
						live_called = true;
						return { cancelled: false, path };
					},
				};
			},
		} as unknown as ExtensionRunner;

		refresh_switch_session_capture_from_runner(runner);

		const fn = resolve_switch_session_fn();
		expect(typeof fn).toBe("function");
		await fn?.("/live/session.jsonl");
		expect(live_called).toBe(true);
	});

	test("install is idempotent", () => {
		reset_command_context_capture_for_tests();
		install_command_context_capture();
		install_command_context_capture();
		expect(typeof ExtensionRunner.prototype.bindCommandContext).toBe("function");
	});
});
