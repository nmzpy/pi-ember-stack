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
	McpInstructionsSchema,
	McpToolDefinitionSchema,
	McpToolsSchema,
	ModelDetailsSchema,
	RequestContextEnvSchema,
	RequestContextSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	type ConversationStateStructure,
	type ConversationTurnStructure,
	type McpToolDefinition,
	type RequestContext,
} from "./proto/agent_pb.js";
import { frame_connect_message } from "./wire.js";
import {
	assert_conversation_blobs_present,
	blob_id_to_store_key,
	lookup_blob,
	store_cursor_blob,
} from "./blobs.js";
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

export const EMBER_MCP_PROVIDER_IDENTIFIER = "pi-ember-stack";

const EMBER_MCP_INSTRUCTIONS = `
Available MCP tools use the pi_ember_ name prefix (e.g. pi_ember_read, pi_ember_grep).
Use only these MCP tools. The native tools Read, Grep, Glob, LS, Shell and Write are not available in this environment.
`;

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
			providerIdentifier: EMBER_MCP_PROVIDER_IDENTIFIER,
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
		mcpInstructions: [
			create(McpInstructionsSchema, {
				serverName: EMBER_MCP_PROVIDER_IDENTIFIER,
				instructions: EMBER_MCP_INSTRUCTIONS.trim(),
			}),
		],
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

function empty_conversation_metadata() {
	return {
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
	};
}

function blob_ids_match(left: Uint8Array, right: Uint8Array): boolean {
	return blob_id_to_store_key(left) === blob_id_to_store_key(right);
}

/** Preserve non-history checkpoint fields when the system prompt blob is unchanged. */
function checkpoint_metadata_shell(
	checkpoint: Uint8Array | null,
	system_blob_id: Uint8Array,
) {
	if (!checkpoint) return empty_conversation_metadata();

	const loaded = fromBinary(ConversationStateStructureSchema, checkpoint);
	const cached_system = loaded.rootPromptMessagesJson[0];
	if (!cached_system || !blob_ids_match(cached_system, system_blob_id)) {
		return empty_conversation_metadata();
	}

	return {
		todos: loaded.todos,
		pendingToolCalls: loaded.pendingToolCalls,
		previousWorkspaceUris: loaded.previousWorkspaceUris,
		fileStates: loaded.fileStates,
		fileStatesV2: loaded.fileStatesV2,
		summaryArchives: loaded.summaryArchives,
		turnTimings: loaded.turnTimings,
		subagentStates: loaded.subagentStates,
		selfSummaryCount: loaded.selfSummaryCount,
		readPaths: loaded.readPaths,
		summary: loaded.summary,
		plan: loaded.plan,
		summaryArchive: loaded.summaryArchive,
	};
}

function push_root_prompt_json_blob(
	blob_store: Map<string, Uint8Array>,
	ids: Uint8Array[],
	value: unknown,
): void {
	ids.push(
		store_cursor_blob(blob_store, new TextEncoder().encode(JSON.stringify(value))),
	);
}

/** Cursor feeds rootPromptMessagesJson (not turns[]) to the model — include prior JSON history. */
function build_root_prompt_blob_ids(
	mapped: CursorMappedContext,
	blob_store: Map<string, Uint8Array>,
): Uint8Array[] {
	const ids: Uint8Array[] = [];
	push_root_prompt_json_blob(blob_store, ids, {
		role: "system",
		content: mapped.system_prompt,
	});

	for (const turn of mapped.turns) {
		if (turn.user_text.trim()) {
			push_root_prompt_json_blob(blob_store, ids, {
				role: "user",
				content: [{ type: "text", text: turn.user_text }],
			});
		}
		if (turn.assistant_text.trim()) {
			push_root_prompt_json_blob(blob_store, ids, {
				role: "assistant",
				content: [{ type: "text", text: turn.assistant_text }],
			});
		}
		for (const result of turn.embedded_tool_results) {
			push_root_prompt_json_blob(blob_store, ids, {
				role: "user",
				content: [{ type: "text", text: `[Tool Result]\n${result.content}` }],
			});
		}
	}

	return ids;
}

function build_turn_blob_ids(
	turn: CursorTurn,
	blob_store: Map<string, Uint8Array>,
): Uint8Array {
	const user_msg = create(UserMessageSchema, {
		text: turn.user_text,
		messageId: crypto.randomUUID(),
	});
	const user_message_blob_id = store_cursor_blob(
		blob_store,
		toBinary(UserMessageSchema, user_msg),
	);

	const step_blob_ids: Uint8Array[] = [];
	if (turn.assistant_text) {
		step_blob_ids.push(
			store_cursor_blob(blob_store, build_assistant_step_bytes(turn.assistant_text)),
		);
	}

	const results_by_id = new Map(
		turn.embedded_tool_results.map((result) => [result.tool_call_id, result]),
	);
	for (const tool_call of turn.tool_calls) {
		step_blob_ids.push(
			store_cursor_blob(
				blob_store,
				build_tool_call_step_bytes(
					tool_call,
					results_by_id.get(tool_call.id),
					cursor_tool_name_for_pi_tool(tool_call.name),
				),
			),
		);
	}

	const agent_turn = create(AgentConversationTurnStructureSchema, {
		userMessage: user_message_blob_id,
		steps: step_blob_ids,
	});
	const turn_structure = create(ConversationTurnStructureSchema, {
		turn: { case: "agentConversationTurn", value: agent_turn },
	});
	return store_cursor_blob(blob_store, toBinary(ConversationTurnStructureSchema, turn_structure));
}

/** Read a turn structure blob referenced from conversation_state.turns. */
export function read_turn_structure_blob(
	blob_store: Map<string, Uint8Array>,
	turn_blob_id: Uint8Array,
): ConversationTurnStructure {
	const turn_bytes = lookup_blob(blob_store, turn_blob_id);
	if (!turn_bytes) {
		throw new Error(`Cursor turn blob missing from store: ${blob_id_to_store_key(turn_blob_id).slice(0, 12)}`);
	}
	return fromBinary(ConversationTurnStructureSchema, turn_bytes);
}

export function build_cursor_request(
	model_id: string,
	mapped: CursorMappedContext,
	conversation_id: string,
	checkpoint: Uint8Array | null,
	existing_blob_store?: Map<string, Uint8Array>,
): CursorRequestPayload {
	const blob_store = new Map<string, Uint8Array>(existing_blob_store ?? []);

	const root_prompt_blob_ids = build_root_prompt_blob_ids(mapped, blob_store);
	const system_blob_id = root_prompt_blob_ids[0];
	if (!system_blob_id) {
		throw new Error("Cursor request is missing the system prompt blob");
	}
	const turn_blob_ids = mapped.turns.map((turn) => build_turn_blob_ids(turn, blob_store));

	const conversation_state = create(ConversationStateStructureSchema, {
		...checkpoint_metadata_shell(checkpoint, system_blob_id),
		rootPromptMessagesJson: root_prompt_blob_ids,
		turns: turn_blob_ids,
	});

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
