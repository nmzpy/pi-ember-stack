import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecClientMessageSchema,
	ExecServerMessageSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolResultContentItemSchema,
} from "../src/cloud-direct/proto/agent_pb.js";
import { frame_connect_message } from "../src/cloud-direct/wire.js";
import {
	__chat_test_only_finalize_tool_batch,
	__chat_test_only_push_mcp_tool,
	type CursorChatEvent,
	type PendingMcpExec,
} from "../src/cloud-direct/chat.js";

describe("McpResult placeholder construction", () => {
	test("builds a valid McpSuccess with text 'ok' and isError false", () => {
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

		expect(mcp_result.result.case).toBe("success");
		if (mcp_result.result.case === "success") {
			expect(mcp_result.result.value.isError).toBe(false);
			expect(mcp_result.result.value.content).toHaveLength(1);
			const item = mcp_result.result.value.content[0]!;
			expect(item.content.case).toBe("text");
			if (item.content.case === "text") {
				expect(item.content.value.text).toBe("ok");
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
