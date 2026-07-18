/**
 * Focused pipeline + strategy tests for pi-ember-dcp.
 * Run with: bun test plugins/pi-ember-dcp/test/pipeline.test.ts
 *
 * Excluded from package tsc via tsconfig exclude of plugins/**/test/**.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type DcpConfig } from "../lib/config.ts";
import {
	type AnyMessage,
	type AssistantMessage,
	type ToolResultMessage,
	canonical_json,
	tool_call_key,
} from "../lib/messages.ts";
import { run_pipeline } from "../lib/pipeline.ts";
import { create_session_state } from "../lib/state.ts";
import type { Logger } from "../lib/logger.ts";

const silent_logger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as Logger;

function lenient_config(): DcpConfig {
	const cfg = structuredClone(DEFAULT_CONFIG) as DcpConfig;
	cfg.turnProtection.enabled = false;
	cfg.compress.mode = "message";
	cfg.compress.modelMinLimits = undefined;
	cfg.compress.modelMaxLimits = undefined;
	cfg.compress.nudgeFrequency = 1;
	cfg.compress.iterationNudgeThreshold = 0;
	cfg.compress.nudgeForce = "soft";
	cfg.strategies.purgeErrors.turns = 4;
	return cfg;
}

function mk_assistant_with_call(
	id: string,
	name: string,
	args: Record<string, unknown>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "" },
			{ type: "toolCall", id, name, arguments: args },
		],
		timestamp: 0,
	};
}

function mk_tool_result(
	id: string,
	name: string,
	text: string,
	is_error = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: is_error,
		timestamp: 0,
	};
}

describe("pi-ember-dcp pipeline", () => {
	test("canonical_json sorts nested keys", () => {
		const a = { x: { b: 2, a: 1 }, y: [1, 2] };
		const b = { y: [1, 2], x: { a: 1, b: 2 } };
		expect(canonical_json(a)).toBe(canonical_json(b));
	});

	test("canonical_json handles cycles", () => {
		const a: Record<string, unknown> = { x: 1 };
		a.self = a;
		expect(() => canonical_json(a)).not.toThrow();
	});

	test("tool_call_key is stable regardless of key order", () => {
		const k1 = tool_call_key({
			name: "grep",
			arguments: { pattern: "foo", path: "src" },
		});
		const k2 = tool_call_key({
			name: "grep",
			arguments: { path: "src", pattern: "foo" },
		});
		expect(k1).toBe(k2);
	});

	test("dedup replaces older duplicates and keeps newest", () => {
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("c1", "grep", { pattern: "foo" }),
			mk_tool_result("c1", "grep", "match line 1"),
			mk_assistant_with_call("c2", "grep", { pattern: "foo" }),
			mk_tool_result("c2", "grep", "match line 1"),
		];
		const state = create_session_state();
		const r = run_pipeline(msgs, lenient_config(), state, silent_logger);
		expect(r.dedupPruned).toBe(1);
		const first = r.messages[1] as ToolResultMessage;
		const second = r.messages[3] as ToolResultMessage;
		expect((first.content[0] as { text: string }).text.startsWith("[pruned by pi-dcp")).toBe(
			true,
		);
		expect((second.content[0] as { text: string }).text).toBe("match line 1");
	});

	test("dedup never touches protected tools (write)", () => {
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("c1", "write", { path: "a.ts", content: "x" }),
			mk_tool_result("c1", "write", "ok"),
			mk_assistant_with_call("c2", "write", { path: "a.ts", content: "x" }),
			mk_tool_result("c2", "write", "ok"),
		];
		const state = create_session_state();
		const r = run_pipeline(msgs, lenient_config(), state, silent_logger);
		expect(r.dedupPruned).toBe(0);
	});

	test("pipeline does not mutate input message objects", () => {
		const original_text = "huge grep output ".repeat(20);
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("c1", "grep", { pattern: "foo" }),
			mk_tool_result("c1", "grep", original_text),
			mk_assistant_with_call("c2", "grep", { pattern: "foo" }),
			mk_tool_result("c2", "grep", original_text),
		];
		const before = JSON.stringify(msgs);
		const state = create_session_state();
		run_pipeline(msgs, lenient_config(), state, silent_logger);
		expect(JSON.stringify(msgs)).toBe(before);
	});

	test("pipeline is idempotent on repeated runs", () => {
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("c1", "grep", { pattern: "foo" }),
			mk_tool_result("c1", "grep", "first"),
			mk_assistant_with_call("c2", "grep", { pattern: "foo" }),
			mk_tool_result("c2", "grep", "second"),
		];
		const state = create_session_state();
		const cfg = lenient_config();
		const r1 = run_pipeline(msgs, cfg, state, silent_logger);
		const r2 = run_pipeline(msgs, cfg, state, silent_logger);
		expect(r1.dedupPruned).toBe(1);
		expect(r2.dedupPruned).toBe(0);
		expect((r1.messages[1] as ToolResultMessage).content[0]).toEqual(
			(r2.messages[1] as ToolResultMessage).content[0],
		);
	});

	test("purgeErrors strips old errored tool arguments after turn threshold", () => {
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("e1", "bash", {
				command: "cat very-long-failing-payload",
			}),
			mk_tool_result("e1", "bash", "exit 1: boom", true),
		];
		const state = create_session_state();
		state.turnIndex = 0;
		const cfg = lenient_config();
		cfg.strategies.purgeErrors.turns = 2;

		// First observation — too young to purge.
		run_pipeline(msgs, cfg, state, silent_logger);
		expect(state.erroredAt.get("e1")).toBe(0);

		state.turnIndex = 2;
		const r = run_pipeline(msgs, cfg, state, silent_logger);
		expect(r.errorInputsPurged).toBe(1);
		const assistant = r.messages[0] as AssistantMessage;
		const call = assistant.content.find((c) => c.type === "toolCall");
		expect(call && "arguments" in call ? call.arguments : null).toEqual({
			__purged: "[args purged by pi-dcp]",
		});
		// Original inputs untouched.
		const original_call = (msgs[0] as AssistantMessage).content.find(
			(c) => c.type === "toolCall",
		);
		expect(
			original_call && "arguments" in original_call
				? original_call.arguments
				: null,
		).toEqual({ command: "cat very-long-failing-payload" });
	});

	test("stored compressions replace tool results with placeholders", () => {
		const msgs: AnyMessage[] = [
			mk_assistant_with_call("c1", "read", { path: "a.ts" }),
			mk_tool_result("c1", "read", "file contents here"),
		];
		const state = create_session_state();
		state.compressions.set(1, {
			id: 1,
			createdAt: Date.now(),
			toolCallIds: ["c1"],
			summary: "read a.ts",
			topic: "scan",
			tokensSaved: 10,
			suspended: false,
		});
		const r = run_pipeline(msgs, lenient_config(), state, silent_logger);
		expect(r.compressionsApplied).toBe(1);
		const text = (r.messages[1] as ToolResultMessage).content[0] as {
			text: string;
		};
		expect(text.text.startsWith("[pi-dcp compression #1:")).toBe(true);
	});
});
