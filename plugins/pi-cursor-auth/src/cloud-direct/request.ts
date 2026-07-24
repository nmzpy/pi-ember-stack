/**
 * Build Cursor AgentService/Run protobuf requests from Pi conversation shapes.
 * Adapted from ephraimduncan/opencode-cursor proxy.ts (BSD-3-Clause).
 */
import { createHash } from "node:crypto";
import os from "node:os";
import { create, fromBinary, toBinary, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	AgentConversationTurnStructureSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	ConversationTurnStructureSchema,
	McpToolDefinitionSchema,
	McpToolsSchema,
	ModelDetailsSchema,
	RequestContextEnvSchema,
	RequestContextSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	type ConversationStateStructure,
	type McpToolDefinition,
	type RequestContext,
} from "./proto/agent_pb.js";
import { frame_connect_message } from "./wire.js";
import { assert_conversation_blobs_present, store_blob } from "./blobs.js";
import type { CursorMappedContext, CursorToolDef, CursorTurn } from "../context-map.js";
import { cursor_tool_name_for_pi_tool } from "../context.js";
import {
	build_assistant_step_bytes,
	build_tool_call_step_bytes,
} from "./history.js";

/** Legacy Pi/catalog ids that are not valid Cursor Run model keys. */
const CURSOR_MODEL_ALIASES: Record<string, string> = {
	auto: "default",
};

/** Map Pi/catalog aliases to Cursor API model ids. */
export function resolve_cursor_model_id(model_id: string): string {
	const trimmed = model_id.trim();
	return CURSOR_MODEL_ALIASES[trimmed] ?? trimmed;
}

export interface CursorRequestPayload {
	request_bytes: Uint8Array;
	blob_store: Map<string, Uint8Array>;
	mcp_tools: McpToolDefinition[];
}

export function build_client_heartbeat_frame(): Buffer {
	const heartbeat = create(AgentClientMessageSchema, {
		message: {
			case: "clientHeartbeat",
			value: create(ClientHeartbeatSchema, {}),
		},
	});
	return frame_connect_message(toBinary(AgentClientMessageSchema, heartbeat));
}

export function derive_conversation_key(mapped: CursorMappedContext): string {
	const first_user = mapped.turns[0]?.user_text ?? mapped.user_text;
	return createHash("sha256")
		.update(`conv:${first_user.slice(0, 200)}`)
		.digest("hex")
		.slice(0, 16);
}

/** Deterministic UUID from conv key so Cursor server-side conversation persists. */
export function deterministic_conversation_id(conv_key: string): string {
	const hex = createHash("sha256")
		.update(`cursor-conv-id:${conv_key}`)
		.digest("hex")
		.slice(0, 32);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		`${(0x8 | (Number.parseInt(hex[16] ?? "0", 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
		hex.slice(20, 32),
	].join("-");
}

function build_mcp_tool_definitions(tools: readonly CursorToolDef[]): McpToolDefinition[] {
	return tools.map((tool) => {
		const json_schema: JsonValue =
			tool.parameters && typeof tool.parameters === "object"
				? (tool.parameters as JsonValue)
				: { type: "object", properties: {}, required: [] };
		const input_schema = toBinary(ValueSchema, fromJson(ValueSchema, json_schema));
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-ember-stack",
			toolName: tool.name,
			inputSchema: input_schema,
		});
	});
}

export function build_request_context(
	mcp_tools: McpToolDefinition[],
	workspace_path?: string,
): RequestContext {
	const workspace = workspace_path?.trim() ?? "";
	return create(RequestContextSchema, {
		rules: [],
		repositoryInfo: [],
		tools: mcp_tools,
		gitRepos: [],
		projectLayouts: [],
		mcpInstructions: [],
		fileContents: {},
		customSubagents: [],
		env: create(RequestContextEnvSchema, {
			osVersion: `${process.platform} ${os.release()} (${process.arch})`,
			workspacePaths: workspace ? [workspace] : [],
			shell: process.env.SHELL || process.env.ComSpec || "sh",
			sandboxEnabled: false,
			terminalsFolder: "",
			agentSharedNotesFolder: "",
			agentConversationNotesFolder: "",
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
			projectFolder: "",
			agentTranscriptsFolder: "",
		}),
	});
}

export function format_tool_results_for_cursor(results: readonly { tool_call_id: string; content: string }[]): string {
	return results
		.map(
			(result) =>
				`<tool_result tool_call_id="${result.tool_call_id}">\n${result.content}\n</tool_result>`,
		)
		.join("\n\n");
}

function build_turn_step_bytes(turn: CursorTurn): Uint8Array[] {
	const step_bytes: Uint8Array[] = [];
	if (turn.assistant_text) {
		step_bytes.push(build_assistant_step_bytes(turn.assistant_text));
	}
	const results_by_id = new Map(
		turn.embedded_tool_results.map((result) => [result.tool_call_id, result]),
	);
	for (const tool_call of turn.tool_calls) {
		step_bytes.push(
			build_tool_call_step_bytes(
				tool_call,
				results_by_id.get(tool_call.id),
				cursor_tool_name_for_pi_tool(tool_call.name),
			),
		);
	}
	return step_bytes;
}

export function build_cursor_request(
	model_id: string,
	mapped: CursorMappedContext,
	conversation_id: string,
	checkpoint: Uint8Array | null,
	existing_blob_store?: Map<string, Uint8Array>,
): CursorRequestPayload {
	const blob_store = new Map<string, Uint8Array>(existing_blob_store ?? []);

	const system_json = JSON.stringify({ role: "system", content: mapped.system_prompt });
	const system_bytes = new TextEncoder().encode(system_json);
	const system_blob_id = new Uint8Array(createHash("sha256").update(system_bytes).digest());
	store_blob(blob_store, system_blob_id, system_bytes);

	let conversation_state: ConversationStateStructure;
	if (checkpoint) {
		const loaded = fromBinary(ConversationStateStructureSchema, checkpoint);
		conversation_state = create(ConversationStateStructureSchema, {
			...loaded,
			rootPromptMessagesJson: [system_blob_id],
		});
	} else {
		const turn_bytes: Uint8Array[] = [];
		for (const turn of mapped.turns) {
			const user_msg = create(UserMessageSchema, {
				text: turn.user_text,
				messageId: crypto.randomUUID(),
			});
			const user_msg_bytes = toBinary(UserMessageSchema, user_msg);

			const step_bytes = build_turn_step_bytes(turn);

			const agent_turn = create(AgentConversationTurnStructureSchema, {
				userMessage: user_msg_bytes,
				steps: step_bytes,
			});
			const turn_structure = create(ConversationTurnStructureSchema, {
				turn: { case: "agentConversationTurn", value: agent_turn },
			});
			turn_bytes.push(toBinary(ConversationTurnStructureSchema, turn_structure));
		}

		conversation_state = create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: [system_blob_id],
			turns: turn_bytes,
			todos: [],
			pendingToolCalls: [],
			previousWorkspaceUris: [],
			fileStates: {},
			fileStatesV2: {},
			summaryArchives: [],
			turnTimings: [],
			subagentStates: {},
			selfSummaryCount: 0,
			readPaths: [],
		});
	}

	const effective_user_text =
		mapped.user_text ||
		(mapped.tool_results.length > 0 ? format_tool_results_for_cursor(mapped.tool_results) : "");

	const user_message = create(UserMessageSchema, {
		text: effective_user_text,
		messageId: crypto.randomUUID(),
	});
	const action = create(ConversationActionSchema, {
		action: {
			case: "userMessageAction",
			value: create(UserMessageActionSchema, { userMessage: user_message }),
		},
	});

	const resolved_model_id = resolve_cursor_model_id(model_id);
	const model_details = create(ModelDetailsSchema, {
		modelId: resolved_model_id,
		displayModelId: resolved_model_id,
		displayName: resolved_model_id,
	});
	const mcp_tools = build_mcp_tool_definitions(mapped.tools);

	assert_conversation_blobs_present(conversation_state.rootPromptMessagesJson, blob_store);

	const run_request = create(AgentRunRequestSchema, {
		conversationState: conversation_state,
		action,
		modelDetails: model_details,
		conversationId: conversation_id,
		mcpTools: create(McpToolsSchema, { mcpTools: mcp_tools }),
	});

	const client_message = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: run_request },
	});

	return {
		request_bytes: toBinary(AgentClientMessageSchema, client_message),
		blob_store,
		mcp_tools,
	};
}

/** Decode MCP arg bytes to a JS object. */
export function decode_mcp_arg_value(value: Uint8Array): unknown {
	try {
		const parsed = fromBinary(ValueSchema, value);
		return toJson(ValueSchema, parsed);
	} catch {
		return new TextDecoder().decode(value);
	}
}

export function decode_mcp_args_map(args: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decode_mcp_arg_value(value);
	}
	return decoded;
}
