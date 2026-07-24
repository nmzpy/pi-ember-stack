import { describe, expect, test } from "bun:test";
import {
	frame_connect_message,
	parse_connect_frames,
	parse_connect_trailer_error,
	format_bridge_stderr,
	decode_connect_unary_body,
	is_conversation_recovery_error,
	CONNECT_END_STREAM_FLAG,
} from "../src/cloud-direct/wire.ts";
import {
	__chat_test_only_finalize_tool_batch,
	__chat_test_only_push_mcp_tool,
	type CursorChatEvent,
} from "../src/cloud-direct/chat.ts";
import { map_context_to_cursor, cursor_context_has_content } from "../src/context-map.ts";
import { reset_cursor_session, set_cursor_pi_mode, set_cursor_session_key, get_cursor_session_key, __test_only } from "../src/stream.ts";
import { derive_conversation_key, deterministic_conversation_id } from "../src/cloud-direct/request.ts";
import { __catalog_test_only } from "../src/cloud-direct/catalog.ts";

describe("Connect wire framing", () => {
	test("frames and parses a single Connect message", () => {
		const body = Buffer.from("hello");
		const framed = frame_connect_message(body);
		const frames = parse_connect_frames(framed);
		expect(frames).toHaveLength(1);
		expect(frames[0].payload.toString()).toBe("hello");
		expect(frames[0].eos).toBe(false);
	});

	test("detects end-of-stream trailer frames", () => {
		const framed = frame_connect_message(Buffer.from("{}"), CONNECT_END_STREAM_FLAG);
		const frames = parse_connect_frames(framed);
		expect(frames[0].eos).toBe(true);
	});

	test("decodes unary response body from connect envelope", () => {
		const inner = Buffer.from("payload");
		const framed = frame_connect_message(inner);
		const decoded = decode_connect_unary_body(framed);
		expect(Buffer.from(decoded!).toString()).toBe("payload");
	});

	test("ignores successful empty Connect trailers", () => {
		expect(parse_connect_trailer_error(Buffer.from("{}"))).toBeNull();
		expect(parse_connect_trailer_error(Buffer.from(""))).toBeNull();
	});

	test("formats generic Connect internal errors without raw trailer dumps", () => {
		const trailer = Buffer.from(JSON.stringify({ error: { code: "internal", message: "Error" } }));
		const parsed = parse_connect_trailer_error(trailer);
		expect(parsed?.code).toBe("internal");
		expect(parsed?.display_message).toBe("Connect error internal");
		expect(parsed?.display_message).not.toContain("trailer:");
	});

	test("formats aiserver ErrorDetails as title and detail", () => {
		const error_details = {
			type: "aiserver.v1.ErrorDetails",
			debug: {
				error: "ERROR_CUSTOM_MESSAGE",
				details: {
					title: "Conversation data missing",
					detail:
						"This conversation's data is missing and can't be restored. Start a new chat to continue. (missing blob 0a7f0a7d0a55)",
					isRetryable: false,
				},
			},
		};
		const trailer = Buffer.from(
			JSON.stringify({
				error: {
					code: "internal",
					message: JSON.stringify(error_details),
				},
			}),
		);
		const parsed = parse_connect_trailer_error(trailer);
		expect(parsed?.display_message).toBe(
			"Conversation data missing: This conversation's data is missing and can't be restored. Start a new chat to continue. (missing blob 0a7f0a7d0a55)",
		);
		expect(parsed?.display_message).not.toContain("Connect error");
		expect(parsed?.display_message).not.toContain("trailer:");
	});

	test("detects conversation recovery errors", () => {
		expect(
			is_conversation_recovery_error(
				"Conversation data missing: missing blob 0a7f0a7d0a55",
			),
		).toBe(true);
		expect(is_conversation_recovery_error("model unavailable")).toBe(false);
	});

	test("surfaces google.rpc ErrorInfo details", () => {
		const trailer = Buffer.from(
			JSON.stringify({
				error: {
					code: "permission_denied",
					message: "Error",
					details: [
						{
							"@type": "type.googleapis.com/google.rpc.ErrorInfo",
							reason: "MODEL_NOT_AVAILABLE",
							domain: "cursor.sh",
							metadata: { modelId: "grok-4.5" },
						},
					],
				},
			}),
		);
		const parsed = parse_connect_trailer_error(trailer);
		expect(parsed?.display_message).toContain("MODEL_NOT_AVAILABLE");
		expect(parsed?.display_message).toContain("grok-4.5");
	});

	test("formats bridge stderr diagnostics", () => {
		const stderr = [
			JSON.stringify({ kind: "grpc_trailers", grpcStatus: "13", grpcMessage: "model unavailable" }),
			JSON.stringify({ kind: "http_status", status: "401" }),
		].join("\n");
		expect(format_bridge_stderr(stderr)).toBe("gRPC 13: model unavailable; HTTP 401");
	});
});

describe("MCP tool batching", () => {
	test("collects multiple MCP tools before a single tool_calls finish", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);

		__chat_test_only_push_mcp_tool(push, {
			exec_id: "1",
			exec_msg_id: "1",
			tool_call_id: "call-read",
			tool_name: "Read",
			decoded_args: JSON.stringify({ file_path: "a.ts" }),
		});
		__chat_test_only_push_mcp_tool(push, {
			exec_id: "2",
			exec_msg_id: "2",
			tool_call_id: "call-edit",
			tool_name: "Edit",
			decoded_args: JSON.stringify({ file_path: "b.ts" }),
		});

		let finished = false;
		finished = __chat_test_only_finalize_tool_batch(push, true, finished);
		expect(finished).toBe(true);
		expect(events).toHaveLength(5);
		expect(events.filter((e) => e.kind === "tool_call_start")).toHaveLength(2);
		expect(events.at(-1)).toEqual({ kind: "finish", reason: "tool_calls" });
	});

	test("finalize is idempotent when already finished", () => {
		const events: CursorChatEvent[] = [];
		const push = (event: CursorChatEvent) => events.push(event);
		__chat_test_only_push_mcp_tool(push, {
			exec_id: "1",
			exec_msg_id: "1",
			tool_call_id: "call-1",
			tool_name: "Read",
			decoded_args: "{}",
		});
		let finished = __chat_test_only_finalize_tool_batch(push, true, false);
		finished = __chat_test_only_finalize_tool_batch(push, true, finished);
		expect(events.filter((e) => e.kind === "finish")).toHaveLength(1);
	});
});

describe("Pi context mapping", () => {
	test("maps user/assistant/toolResult messages into Cursor turns", () => {
		const mapped = map_context_to_cursor({
			systemPrompt: "Base system",
			messages: [
				{ role: "user", content: "first ask" },
				{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
				{ role: "user", content: "second ask" },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
				},
				{ role: "toolResult", toolCallId: "c1", content: "a.ts", isError: false },
			],
			tools: [],
		});

		expect(mapped.system_prompt).toBe("Base system");
		expect(mapped.turns).toEqual([
			{ user_text: "first ask", assistant_text: "first answer", tool_calls: [], embedded_tool_results: [] },
			{
				user_text: "second ask",
				assistant_text: "",
				tool_calls: [{ id: "c1", name: "bash", arguments: { command: "ls" } }],
				embedded_tool_results: [],
			},
		]);
		expect(mapped.user_text).toBe("");
		expect(mapped.tool_results).toEqual([{ tool_call_id: "c1", content: "a.ts" }]);
		expect(cursor_context_has_content(mapped)).toBe(true);
	});
});

describe("Cursor session key", () => {
	test("stores and returns the active Pi session id", () => {
		set_cursor_session_key("session-abc");
		expect(get_cursor_session_key()).toBe("session-abc");
	});
});

describe("Cursor mode directive gating", () => {
	test("includes directive on first turn then skips same-mode turns", () => {
		reset_cursor_session();
		set_cursor_pi_mode("code");
		expect(__test_only.should_include_mode_directive()).toBe(true);
		const prompt = __test_only.build_system_prompt("Base");
		expect(prompt).toContain("code mode");
		__test_only.mark_mode_directive_sent();
		expect(__test_only.should_include_mode_directive()).toBe(false);
		expect(__test_only.build_system_prompt("Base")).toBe("Base");
	});

	test("mode change re-enables directive", () => {
		reset_cursor_session();
		set_cursor_pi_mode("code");
		__test_only.mark_mode_directive_sent();
		set_cursor_pi_mode("plan");
		expect(__test_only.should_include_mode_directive()).toBe(true);
	});
});

describe("Tool argument finalization", () => {
	test("normalizes Cursor edit args when a tool call closes", () => {
		const partial_json = JSON.stringify({
			file_path: "foo.ts",
			old_string: "a",
			new_string: "b",
		});
		const args = __test_only.finalize_cursor_tool_arguments("edit", partial_json, []);
		expect(args).toEqual({
			path: "foo.ts",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});
});

describe("Conversation key helpers", () => {
	test("derives stable conversation keys and ids", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const key = derive_conversation_key(mapped);
		expect(key).toHaveLength(16);
		const id = deterministic_conversation_id(key);
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});

describe("Model catalog normalization", () => {
	test("normalizes GetUsableModels entries", () => {
		const model = __catalog_test_only.normalize_model_entry({
			modelId: "composer-2",
			displayName: "Composer 2",
			thinkingDetails: {},
		});
		expect(model).toEqual({
			id: "composer-2",
			name: "Composer 2",
			reasoning: true,
			context_window: 200_000,
			max_tokens: 32_000,
		});
	});
});
