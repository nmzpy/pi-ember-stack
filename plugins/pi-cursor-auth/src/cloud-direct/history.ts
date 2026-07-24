/**
 * Encode Pi assistant tool calls into Cursor ConversationStep protobuf bytes.
 */
import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
	AssistantMessageSchema,
	ConversationStepSchema,
	McpArgsSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ToolCallSchema,
} from "./proto/agent_pb.js";
import type { CursorAssistantToolCall, CursorToolResult } from "../context-map.js";

const MCP_PROVIDER_ID = "pi-ember-stack";

function encode_mcp_args_map(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) {
		encoded[key] = toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
	}
	return encoded;
}

function build_mcp_tool_result(content: string, is_error = false) {
	return create(McpToolResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content: [
					create(McpToolResultContentItemSchema, {
						content: {
							case: "text",
							value: create(McpTextContentSchema, { text: content }),
						},
					}),
				],
				isError: is_error,
			}),
		},
	});
}

/** Build a ConversationStep byte blob for a completed MCP tool call + optional result. */
export function build_tool_call_step_bytes(
	tool_call: CursorAssistantToolCall,
	result: CursorToolResult | undefined,
	cursor_tool_name: string,
): Uint8Array {
	const mcp_call = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: cursor_tool_name,
			toolName: cursor_tool_name,
			toolCallId: tool_call.id,
			providerIdentifier: MCP_PROVIDER_ID,
			args: encode_mcp_args_map(tool_call.arguments),
		}),
	});
	if (result) {
		mcp_call.result = build_mcp_tool_result(result.content);
	}

	const step = create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, {
				tool: {
					case: "mcpToolCall",
					value: mcp_call,
				},
			}),
		},
	});
	return toBinary(ConversationStepSchema, step);
}

/** Build assistant text step bytes. */
export function build_assistant_step_bytes(text: string): Uint8Array {
	const step = create(ConversationStepSchema, {
		message: {
			case: "assistantMessage",
			value: create(AssistantMessageSchema, { text }),
		},
	});
	return toBinary(ConversationStepSchema, step);
}
