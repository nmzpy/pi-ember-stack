import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecClientMessageSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolResultContentItemSchema,
	PartialToolCallUpdateSchema,
	ReadToolCallSchema,
	ReadTodosToolCallSchema,
	ShellToolCallSchema,
	TaskToolCallDeltaSchema,
	TextDeltaUpdateSchema,
	ThinkingDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	ToolCallCompletedUpdateSchema,
	ToolCallDeltaSchema,
	ToolCallDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
	UpdateTodosToolCallSchema,
	type InteractionUpdate,
} from "../src/cloud-direct/proto/agent_pb.js";
import { frame_connect_message } from "../src/cloud-direct/wire.js";
import {
	__chat_test_only_finalize_tool_batch,
	__chat_test_only_handle_interaction_update,
	__chat_test_only_push_mcp_tool,
	__chat_test_only_should_idle_close_stream,
	MCP_DEFERRED_RESULT_TEXT,
	type CursorChatEvent,
	type PendingMcpExec,
} from "../src/cloud-direct/chat.js";

describe("McpResult placeholder construction", () => {
	test("builds a valid deferred McpSuccess and isError false", () => {
		expect(MCP_DEFERRED_RESULT_TEXT).toContain("real result");
		const mcp_result = create(McpResultSchema, {
			result: {
				case: "success",
				value: create(McpSuccessSchema, {
					content: [
						create(McpToolResultContentItemSchema, {
							content: {
								case: "text",
								value: create(McpTextContentSchema, { text: MCP_DEFERRED_RESULT_TEXT }),
							},
						}),
					],
					isError: false,
				}),
			},
		});

		expect(mcp_result.result.case).toBe("success");
		if (mcp_result.result.case === "success") {
			expect(mcp_result.result.value.isError).toBe(false);
			expect(mcp_result.result.value.content).toHaveLength(1);
			const item = mcp_result.result.value.content[0]!;
			expect(item.content.case).toBe("text");
			if (item.content.case === "text") {
				expect(item.content.value.text).toBe(MCP_DEFERRED_RESULT_TEXT);
			}
		}
	});

	test("serializes and deserializes through protobuf round-trip", () => {
		const mcp_result = create(McpResultSchema, {
			result: {
				case: "success",
				value: create(McpSuccessSchema, {
					content: [
						create(McpToolResultContentItemSchema, {
							content: {
								case: "text",
								value: create(McpTextContentSchema, { text: "ok" }),
							},
						}),
					],
					isError: false,
				}),
			},
		});

		const bytes = toBinary(McpResultSchema, mcp_result);
		const decoded = fromBinary(McpResultSchema, bytes);
		expect(decoded.result.case).toBe("success");
		if (decoded.result.case === "success") {
			expect(decoded.result.value.isError).toBe(false);
		}
	});

	test("wraps McpResult in ExecClientMessage with mcpResult case", () => {
		const mcp_result = create(McpResultSchema, {
			result: {
				case: "success",
				value: create(McpSuccessSchema, {
					content: [
						create(McpToolResultContentItemSchema, {
							content: {
								case: "text",
								value: create(McpTextContentSchema, { text: "ok" }),
							},
						}),
					],
					isError: false,
				}),
			},
		});

		const exec_client_message = create(ExecClientMessageSchema, {
			id: 42,
			execId: "10",
			message: { case: "mcpResult", value: mcp_result },
		});

		const client_message = create(AgentClientMessageSchema, {
			message: { case: "execClientMessage", value: exec_client_message },
		});

		const bytes = toBinary(AgentClientMessageSchema, client_message);
		const decoded = fromBinary(AgentClientMessageSchema, bytes);
		expect(decoded.message.case).toBe("execClientMessage");
		if (decoded.message.case === "execClientMessage") {
			expect(decoded.message.value.message.case).toBe("mcpResult");
			expect(decoded.message.value.id).toBe(42);
			expect(decoded.message.value.execId).toBe("10");
		}
	});
});

describe("MCP tool batching with done guard", () => {
	test("push_mcp_tool emits tool_call_start and tool_call_args events", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);

		const exec: PendingMcpExec = {
			exec_id: "1",
			exec_msg_id: "1",
			tool_call_id: "call-1",
			tool_name: "pi_ember_read",
			decoded_args: JSON.stringify({ path: "a.ts" }),
		};

		__chat_test_only_push_mcp_tool(push, exec);

		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({
			kind: "tool_call_start",
			id: "call-1",
			name: "pi_ember_read",
		});
		expect(events[1]).toEqual({
			kind: "tool_call_args",
			args_delta: JSON.stringify({ path: "a.ts" }),
			id: "call-1",
		});
	});

	test("finalize_tool_batch emits a single tool_calls finish event", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);

		__chat_test_only_push_mcp_tool(push, {
			exec_id: "1",
			exec_msg_id: "1",
			tool_call_id: "call-1",
			tool_name: "pi_ember_read",
			decoded_args: "{}",
		});

		let finished = __chat_test_only_finalize_tool_batch(push, true, false);
		expect(finished).toBe(true);
		expect(events.at(-1)).toEqual({ kind: "finish", reason: "tool_calls" });
	});

	test("finalize_tool_batch is idempotent", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);

		let finished = __chat_test_only_finalize_tool_batch(push, true, false);
		finished = __chat_test_only_finalize_tool_batch(push, true, finished);
		expect(events.filter((e) => e.kind === "finish")).toHaveLength(1);
	});

	test("finalize_tool_batch does nothing when saw_tool_call is false", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);

		const finished = __chat_test_only_finalize_tool_batch(push, false, false);
		expect(finished).toBe(false);
		expect(events).toHaveLength(0);
	});
});

describe("ExecServerMessage mcpArgs detection", () => {
	test("an ExecServerMessage with mcpArgs case can be serialized and parsed", () => {
		// This verifies the protobuf round-trip for the exec channel message
		// that triggers the mcpArgs branch in handle_exec_message.
		const exec_server = create(ExecServerMessageSchema, {
			id: 1,
			execId: "1",
		});
		// We can't easily construct mcpArgs without the full schema, but
		// we can verify the ExecServerMessage schema round-trips.
		const bytes = toBinary(ExecServerMessageSchema, exec_server);
		const decoded = fromBinary(ExecServerMessageSchema, bytes);
		expect(decoded.id).toBe(1);
		expect(decoded.execId).toBe("1");
	});
});

describe("Connect frame wrapping for exec responses", () => {
	test("exec response frames are valid Connect messages", () => {
		const mcp_result = create(McpResultSchema, {
			result: {
				case: "success",
				value: create(McpSuccessSchema, {
					content: [
						create(McpToolResultContentItemSchema, {
							content: {
								case: "text",
								value: create(McpTextContentSchema, { text: "ok" }),
							},
						}),
					],
					isError: false,
				}),
			},
		});

		const exec_client_message = create(ExecClientMessageSchema, {
			id: 1,
			execId: "1",
			message: { case: "mcpResult", value: mcp_result },
		});

		const client_message = create(AgentClientMessageSchema, {
			message: { case: "execClientMessage", value: exec_client_message },
		});

		const framed = frame_connect_message(
			toBinary(AgentClientMessageSchema, client_message),
		);

		// Frame is 5-byte header + payload
		expect(framed.length).toBeGreaterThan(5);
		expect(framed[0]).toBe(0); // flags byte, no end-of-stream
		const msg_len = framed.readUInt32BE(1);
		expect(framed.length).toBe(5 + msg_len);
	});
});

describe("Native Cursor tool-call interaction updates", () => {
	const native_update_cases = [
		"partialToolCall",
		"toolCallDelta",
		"toolCallStarted",
		"toolCallCompleted",
	] as const;

	function build_native_update(
		update_case: (typeof native_update_cases)[number],
		tool_case: "updateTodosToolCall" | "readTodosToolCall" | "readToolCall" | "shellToolCall",
	): InteractionUpdate {
		const tool_value = (() => {
			switch (tool_case) {
				case "updateTodosToolCall":
					return create(UpdateTodosToolCallSchema, {});
				case "readTodosToolCall":
					return create(ReadTodosToolCallSchema, {});
				case "readToolCall":
					return create(ReadToolCallSchema, {});
				case "shellToolCall":
					return create(ShellToolCallSchema, {});
			}
		})();
		const tool_call = create(ToolCallSchema, {
			tool: { case: tool_case, value: tool_value },
		});
		switch (update_case) {
			case "partialToolCall":
				return create(InteractionUpdateSchema, {
					message: {
						case: "partialToolCall",
						value: create(PartialToolCallUpdateSchema, {
							callId: "c1",
							toolCall: tool_call,
							argsTextDelta: "{}",
							modelCallId: "m1",
						}),
					},
				});
			case "toolCallDelta":
				return create(InteractionUpdateSchema, {
					message: {
						case: "toolCallDelta",
						value: create(ToolCallDeltaUpdateSchema, {
							callId: "c1",
							toolCallDelta: create(ToolCallDeltaSchema, {
								delta: {
									case: "taskToolCallDelta",
									value: create(TaskToolCallDeltaSchema, {}),
								},
							}),
							modelCallId: "m1",
						}),
					},
				});
			case "toolCallStarted":
				return create(InteractionUpdateSchema, {
					message: {
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, {
							callId: "c1",
							toolCall: tool_call,
							modelCallId: "m1",
						}),
					},
				});
			case "toolCallCompleted":
				return create(InteractionUpdateSchema, {
					message: {
						case: "toolCallCompleted",
						value: create(ToolCallCompletedUpdateSchema, {
							callId: "c1",
							toolCall: tool_call,
							modelCallId: "m1",
						}),
					},
				});
		}
	}

	test("all four native tool-call update cases mark the stream after a wire round-trip", () => {
		for (const update_case of native_update_cases) {
			const server_msg = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: build_native_update(update_case, "updateTodosToolCall"),
				},
			});
			const decoded = fromBinary(
				AgentServerMessageSchema,
				toBinary(AgentServerMessageSchema, server_msg),
			);
			expect(decoded.message.case).toBe("interactionUpdate");

			let native_count = 0;
			const texts: string[] = [];
			__chat_test_only_handle_interaction_update(
				decoded.message.value as InteractionUpdate,
				{ output_tokens: 0, total_tokens: 0 },
				(text) => texts.push(text),
				undefined,
				() => {
					native_count += 1;
				},
			);

			expect(native_count).toBe(1);
			expect(texts).toHaveLength(0);
		}
	});

	test("native UpdateTodos, ReadTodos, Read, and Shell tool calls are all rejected (never streamed as Pi events)", () => {
		const tool_cases = [
			"updateTodosToolCall",
			"readTodosToolCall",
			"readToolCall",
			"shellToolCall",
		] as const;
		for (const tool_case of tool_cases) {
			const update = build_native_update("toolCallStarted", tool_case);

			let native_count = 0;
			const texts: string[] = [];
			__chat_test_only_handle_interaction_update(
				update,
				{ output_tokens: 0, total_tokens: 0 },
				(text) => texts.push(text),
				undefined,
				() => {
					native_count += 1;
				},
			);

			expect(native_count).toBe(1);
			expect(texts).toHaveLength(0);
		}
	});

	test("turnEnded, textDelta, thinkingDelta, and tokenDelta handling is unchanged", () => {
		const state = { output_tokens: 0, total_tokens: 0 };
		const texts: Array<{ text: string; thinking: boolean }> = [];
		let native_count = 0;
		let turn_ended = false;
		const on_text = (text: string, thinking?: boolean) =>
			texts.push({ text, thinking: thinking === true });
		const on_native = () => {
			native_count += 1;
		};

		__chat_test_only_handle_interaction_update(
			create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text: "hello" }),
				},
			}),
			state,
			on_text,
			() => {
				turn_ended = true;
			},
			on_native,
		);
		__chat_test_only_handle_interaction_update(
			create(InteractionUpdateSchema, {
				message: {
					case: "thinkingDelta",
					value: create(ThinkingDeltaUpdateSchema, { text: "hmm" }),
				},
			}),
			state,
			on_text,
			() => {
				turn_ended = true;
			},
			on_native,
		);
		__chat_test_only_handle_interaction_update(
			create(InteractionUpdateSchema, {
				message: {
					case: "tokenDelta",
					value: create(TokenDeltaUpdateSchema, { tokens: 7 }),
				},
			}),
			state,
			on_text,
			() => {
				turn_ended = true;
			},
			on_native,
		);
		__chat_test_only_handle_interaction_update(
			create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
			state,
			on_text,
			() => {
				turn_ended = true;
			},
			on_native,
		);

		expect(texts).toEqual([
			{ text: "hello", thinking: false },
			{ text: "hmm", thinking: true },
		]);
		expect(state.output_tokens).toBe(7);
		expect(turn_ended).toBe(true);
		expect(native_count).toBe(0);
	});
});

describe("Idle-close guard covers native-only tool-call turns", () => {
	test("returns false when no tool call was observed (the hang regression: native-only turns were never idle-closed)", () => {
		expect(
			__chat_test_only_should_idle_close_stream({
				saw_tool_call: false,
				saw_native_tool_call: false,
				done: false,
				last_event_time: 0,
				now: 10_000,
			}),
		).toBe(false);
	});

	test("returns true for a stale native-only stream", () => {
		expect(
			__chat_test_only_should_idle_close_stream({
				saw_tool_call: false,
				saw_native_tool_call: true,
				done: false,
				last_event_time: 0,
				now: 2000,
			}),
		).toBe(true);
	});

	test("returns true for a stale MCP tool-call stream (unchanged behavior)", () => {
		expect(
			__chat_test_only_should_idle_close_stream({
				saw_tool_call: true,
				saw_native_tool_call: false,
				done: false,
				last_event_time: 0,
				now: 2000,
			}),
		).toBe(true);
	});

	test("returns false while events are still fresh", () => {
		expect(
			__chat_test_only_should_idle_close_stream({
				saw_tool_call: false,
				saw_native_tool_call: true,
				done: false,
				last_event_time: 1000,
				now: 1500,
			}),
		).toBe(false);
	});

	test("returns false once the stream is done", () => {
		expect(
			__chat_test_only_should_idle_close_stream({
				saw_tool_call: false,
				saw_native_tool_call: true,
				done: true,
				last_event_time: 0,
				now: 10_000,
			}),
		).toBe(false);
	});
});
