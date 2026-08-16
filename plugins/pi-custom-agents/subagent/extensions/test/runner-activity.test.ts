import { describe, expect, test } from "bun:test";
import { apply_subagent_stream_event, type SubAgentResult } from "../runner.ts";

function make_running_result(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
	return {
		agent: "Coder A",
		task: "do stuff",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		reasoning: true,
		isThinking: false,
		...overrides,
	};
}

describe("apply_subagent_stream_event", () => {
	test("turn_start arms Thinking when no tool is active", () => {
		const result = make_running_result();
		let notify_count = 0;
		apply_subagent_stream_event(result, { type: "turn_start" }, () => {
			notify_count += 1;
		});
		expect(result.isThinking).toBe(true);
		expect(result.latestToolCall).toBeUndefined();
		expect(notify_count).toBe(1);
	});

	test("agent_end enters the transient finishing state", () => {
		const result = make_running_result();
		let notify_count = 0;
		apply_subagent_stream_event(result, { type: "agent_end", willRetry: true }, () => {
			notify_count += 1;
		});
		expect(result.isFinishing).toBe(true);
		expect(notify_count).toBe(1);
	});

	test("agent_start and turn_start clear finishing for another child run", () => {
		for (const type of ["agent_start", "turn_start"]) {
			const result = make_running_result({ isFinishing: true, isThinking: false });
			let notify_count = 0;
			apply_subagent_stream_event(result, { type }, () => {
				notify_count += 1;
			});
			expect(result.isFinishing).toBe(false);
			expect(notify_count).toBe(1);
		}
	});

	test("agent_settled clears finishing without dropping retained thinking", () => {
		const result = make_running_result({
			isFinishing: true,
			liveItems: [{ kind: "thinking", text: "final checks" }],
		});
		let notify_count = 0;
		apply_subagent_stream_event(result, { type: "agent_settled" }, () => {
			notify_count += 1;
		});
		expect(result.isFinishing).toBe(false);
		expect(result.liveItems).toEqual([{ kind: "thinking", text: "final checks" }]);
		expect(notify_count).toBe(1);
	});

	test("tool_execution_start captures latest tool and clears thinking", () => {
		const result = make_running_result({ isThinking: true });
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } },
			() => {},
		);
		expect(result.isThinking).toBe(false);
		expect(result.latestToolCall).toEqual({ name: "read", args: { path: "src/a.ts" } });
	});

	test("tool_execution_update refreshes args without clearing the preview row", () => {
		const result = make_running_result({
			latestToolCall: { name: "edit", args: { path: "a.ts", oldText: "a" } },
		});
		apply_subagent_stream_event(
			result,
			{
				type: "tool_execution_update",
				toolName: "edit",
				args: { path: "a.ts", oldText: "alpha", newText: "beta" },
			},
			() => {},
		);
		expect(result.latestToolCall?.args).toEqual({
			path: "a.ts",
			oldText: "alpha",
			newText: "beta",
		});
	});

	test("tool_execution_end keeps latestToolCall visible until the next activity", () => {
		const result = make_running_result({
			latestToolCall: { name: "grep", args: { pattern: "auth", path: "." } },
		});
		apply_subagent_stream_event(result, { type: "tool_execution_end" }, () => {});
		expect(result.latestToolCall).toEqual({ name: "grep", args: { pattern: "auth", path: "." } });
	});

	test("thinking_start clears stale tool preview and arms Thinking", () => {
		const result = make_running_result({
			latestToolCall: { name: "read", args: { path: "a.ts" } },
		});
		let notify_count = 0;
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			() => {
				notify_count += 1;
			},
		);
		expect(result.latestToolCall).toBeUndefined();
		expect(result.isThinking).toBe(true);
		expect(notify_count).toBe(1);
	});

	test("thinking deltas accumulate and publish while the state stays active", () => {
		const result = make_running_result();
		let notify_count = 0;
		const notify = (): void => {
			notify_count += 1;
		};
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			notify,
		);
		apply_subagent_stream_event(
			result,
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "Inspect " },
			},
			notify,
		);
		apply_subagent_stream_event(
			result,
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "the current flow." },
			},
			notify,
		);
		expect(result.isThinking).toBe(true);
		expect(result.liveItems).toEqual([{ kind: "thinking", text: "Inspect the current flow." }]);
		expect(notify_count).toBe(3);

		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
			notify,
		);
		expect(result.isThinking).toBe(false);
		expect(result.liveItems).toEqual([{ kind: "thinking", text: "Inspect the current flow." }]);
		expect(notify_count).toBe(4);
	});

	test("text_delta clears thinking without removing the lingering tool preview", () => {
		const result = make_running_result({
			isThinking: true,
			latestToolCall: { name: "bash", args: { command: "ls" } },
		});
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta" } },
			() => {},
		);
		expect(result.isThinking).toBe(false);
		expect(result.latestToolCall).toEqual({ name: "bash", args: { command: "ls" } });
	});
});

describe("apply_subagent_stream_event live items", () => {
	test("tool_execution_start appends a running row", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
			() => {},
		);
		expect(result.liveItems?.length).toBe(1);
		expect(result.liveItems?.[0]).toEqual({
			kind: "tool",
			row: {
				toolCallId: undefined,
				name: "read",
				args: { path: "a.ts" },
				completed: false,
				error: false,
			},
		});
	});

	test("tool_execution_update updates args of the running row", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: { path: "a.ts" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_update", toolCallId: "c1", toolName: "edit", args: { path: "a.ts", oldText: "x" } },
			() => {},
		);
		expect(result.liveItems?.length).toBe(1);
		const row = result.liveItems?.[0];
		expect(row?.kind).toBe("tool");
		if (row?.kind === "tool") {
			expect(row.row.args).toEqual({ path: "a.ts", oldText: "x" });
			expect(row.row.completed).toBe(false);
		}
	});

	test("tool_execution_end marks the row completed", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "bash",
				result: { isError: true, details: { diff: "..." } },
			},
			() => {},
		);
		expect(result.liveItems?.length).toBe(1);
		const row = result.liveItems?.[0];
		expect(row?.kind).toBe("tool");
		if (row?.kind === "tool") {
			expect(row.row.completed).toBe(true);
			expect(row.row.error).toBe(true);
			expect(row.row.details).toEqual({ diff: "..." });
		}
	});

	test("parallel batch completes each row in place by toolCallId (no duplicates)", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolCallId: "c2", toolName: "grep", args: { pattern: "x" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {} },
			() => {},
		);
		expect(result.liveItems?.length).toBe(2);
		const first = result.liveItems?.[0];
		const second = result.liveItems?.[1];
		expect(first?.kind).toBe("tool");
		expect(second?.kind).toBe("tool");
		if (first?.kind === "tool" && second?.kind === "tool") {
			expect(first.row.toolCallId).toBe("c1");
			expect(first.row.completed).toBe(true);
			expect(first.row.args).toEqual({ path: "a.ts" });
			expect(second.row.toolCallId).toBe("c2");
			expect(second.row.completed).toBe(false);
		}
	});

	test("text_start opens a live text block; deltas append to it", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me " } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "check." } },
			() => {},
		);
		expect(result.liveItems?.length).toBe(1);
		expect(result.liveItems?.[0]).toEqual({ kind: "text", text: "Let me check." });
		expect(result.isThinking).toBe(false);
	});

	test("a later message text block never appends to an earlier block", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second" } },
			() => {},
		);
		expect(result.liveItems?.length).toBe(3);
		expect(result.liveItems?.[0]).toEqual({ kind: "text", text: "first" });
		expect(result.liveItems?.[2]).toEqual({ kind: "text", text: "second" });
		const tool = result.liveItems?.[1];
		expect(tool?.kind).toBe("tool");
		if (tool?.kind === "tool") expect(tool.row.name).toBe("read");
	});

	test("thinking stays in one burst between tool calls", () => {
		const result = make_running_result();
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning" },
			},
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
			() => {},
		);
		apply_subagent_stream_event(
			result,
			{ type: "tool_execution_start", toolName: "grep", args: { pattern: "flow" } },
			() => {},
		);
		expect(result.liveItems?.map((item) => item.kind)).toEqual([
			"tool",
			"thinking",
			"tool",
		]);
	});

	test("liveItems trims to last 15 items", () => {
		const result = make_running_result();
		for (let i = 0; i < 20; i++) {
			apply_subagent_stream_event(
				result,
				{ type: "tool_execution_start", toolName: "read", args: { path: `f${i}.ts` } },
				() => {},
			);
			apply_subagent_stream_event(
				result,
				{ type: "tool_execution_end", toolName: "read", result: {} },
				() => {},
			);
		}
		expect(result.liveItems?.length).toBe(15);
		const first = result.liveItems?.[0];
		const last = result.liveItems?.[14];
		expect(first?.kind).toBe("tool");
		expect(last?.kind).toBe("tool");
		if (first?.kind === "tool") expect(first.row.args).toEqual({ path: "f5.ts" });
		if (last?.kind === "tool") expect(last.row.args).toEqual({ path: "f19.ts" });
	});
});
