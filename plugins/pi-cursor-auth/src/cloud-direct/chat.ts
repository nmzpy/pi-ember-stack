/**
 * Cloud-direct AgentService/Run streaming for Cursor.
 * Adapted from ephraimduncan/opencode-cursor proxy.ts (BSD-3-Clause).
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BackgroundShellSpawnResultSchema,
	ConversationStateStructureSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DiagnosticsResultSchema,
	ExecClientMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	GetBlobResultSchema,
	GrepErrorSchema,
	GrepResultSchema,
	KvClientMessageSchema,
	LsRejectedSchema,
	LsResultSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolResultContentItemSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSuccessSchema,
	SetBlobResultSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	type AgentServerMessage,
	type ConversationStateStructure,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
} from "./proto/agent_pb.js";
import { CONNECT_END_STREAM_FLAG, frame_connect_message, format_bridge_stderr, is_conversation_recovery_error, parse_connect_trailer_error, type ConnectTrailerError } from "./wire.js";
import { spawn_bridge } from "./transport.js";
import { CURSOR_RUN_RPC_PATH } from "./metadata.js";
import {
	build_client_heartbeat_frame,
	build_request_context,
	decode_mcp_args_map,
	type CursorRequestPayload,
} from "./request.js";
import { lookup_blob, store_blob } from "./blobs.js";
import type { CursorMappedContext } from "../context-map.js";
import {
	build_run_payload,
	get_or_create_conversation_state,
	persist_blob_store,
	reset_conversation_after_blob_error,
	update_conversation_checkpoint,
} from "./session.js";

export type CursorChatEvent =
	| { kind: "text"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool_call_start"; id: string; name: string }
	| { kind: "tool_call_args"; args_delta: string; id?: string }
	| { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
	| {
			kind: "usage";
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
	  };

export class CursorChatError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message);
		this.name = "CursorChatError";
	}
}

export interface CursorChatRequest {
	access_token: string;
	model_id: string;
	mapped: CursorMappedContext;
	session_key: string;
	workspace_path?: string;
	signal?: AbortSignal;
}

interface PendingMcpExec {
	exec_id: string;
	exec_msg_id: string;
	tool_call_id: string;
	tool_name: string;
	decoded_args: string;
}

interface StreamState {
	output_tokens: number;
	total_tokens: number;
}

const REJECT_REASON =
	"Tool not available in this environment. Use the MCP tools provided instead.";

function build_stream_failure_message(options: {
	trailer?: ConnectTrailerError | null;
	bridge_stderr?: string;
	exit_code?: number;
	model_id: string;
}): string {
	const parts: string[] = [];
	if (options.trailer) parts.push(options.trailer.display_message);

	const bridge_detail = format_bridge_stderr(options.bridge_stderr ?? "");
	if (bridge_detail) parts.push(bridge_detail);

	if (!options.trailer && options.exit_code && options.exit_code !== 0) {
		parts.push(`Cursor bridge exited with code ${options.exit_code}`);
	}

	parts.push(`model: ${options.model_id}`);
	return parts.join(" — ");
}

function create_connect_frame_parser(
	on_message: (bytes: Uint8Array) => void,
	on_end_stream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
	let pending = Buffer.alloc(0);
	return (incoming: Buffer) => {
		pending = Buffer.concat([pending, incoming]);
		while (pending.length >= 5) {
			const flags = pending[0]!;
			const msg_len = pending.readUInt32BE(1);
			if (pending.length < 5 + msg_len) break;
			const message_bytes = pending.subarray(5, 5 + msg_len);
			pending = pending.subarray(5 + msg_len);
			if (flags & CONNECT_END_STREAM_FLAG) on_end_stream(message_bytes);
			else on_message(message_bytes);
		}
	};
}

function send_kv_response(
	kv_msg: KvServerMessage,
	message_case: string,
	value: unknown,
	send_frame: (data: Uint8Array) => void,
): void {
	const response = create(KvClientMessageSchema, {
		id: kv_msg.id,
		message: { case: message_case as never, value: value as never },
	});
	const client_msg = create(AgentClientMessageSchema, {
		message: { case: "kvClientMessage", value: response },
	});
	send_frame(frame_connect_message(toBinary(AgentClientMessageSchema, client_msg)));
}

function send_exec_result(
	exec_msg: ExecServerMessage,
	message_case: string,
	value: unknown,
	send_frame: (data: Uint8Array) => void,
): void {
	const exec_client_message = create(ExecClientMessageSchema, {
		id: exec_msg.id,
		execId: exec_msg.execId,
		message: { case: message_case as never, value: value as never },
	});
	const client_message = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: exec_client_message },
	});
	send_frame(frame_connect_message(toBinary(AgentClientMessageSchema, client_message)));
}

function handle_kv_message(
	kv_msg: KvServerMessage,
	blob_store: Map<string, Uint8Array>,
	send_frame: (data: Uint8Array) => void,
): void {
	const kv_case = kv_msg.message.case;
	if (kv_case === "getBlobArgs") {
		const blob_id = kv_msg.message.value.blobId;
		const blob_data = lookup_blob(blob_store, blob_id);
		send_kv_response(
			kv_msg,
			"getBlobResult",
			create(GetBlobResultSchema, blob_data ? { blobData: blob_data } : {}),
			send_frame,
		);
		return;
	}

	if (kv_case === "setBlobArgs") {
		const { blobId, blobData } = kv_msg.message.value;
		store_blob(blob_store, blobId, blobData);
		send_kv_response(kv_msg, "setBlobResult", create(SetBlobResultSchema, {}), send_frame);
	}
}

function handle_exec_message(
	exec_msg: ExecServerMessage,
	mcp_tools: McpToolDefinition[],
	send_frame: (data: Uint8Array) => void,
	on_mcp_exec: (exec: PendingMcpExec) => void,
	workspace_path?: string,
): void {
	const exec_case = exec_msg.message.case;

	if (exec_case === "requestContextArgs") {
		const request_context = build_request_context(mcp_tools, workspace_path);
		const result = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext: request_context }),
			},
		});
		send_exec_result(exec_msg, "requestContextResult", result, send_frame);
		return;
	}

	if (exec_case === "mcpArgs") {
		const mcp_args = exec_msg.message.value;
		const decoded = decode_mcp_args_map(mcp_args.args ?? {});
		on_mcp_exec({
			exec_id: String(exec_msg.execId),
			exec_msg_id: String(exec_msg.id),
			tool_call_id: mcp_args.toolCallId || crypto.randomUUID(),
			tool_name: mcp_args.toolName || mcp_args.name,
			decoded_args: JSON.stringify(decoded),
		});
		return;
	}

	if (exec_case === "readArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"readResult",
			create(ReadResultSchema, {
				result: {
					case: "rejected",
					value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "lsArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"lsResult",
			create(LsResultSchema, {
				result: {
					case: "rejected",
					value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "grepArgs") {
		send_exec_result(
			exec_msg,
			"grepResult",
			create(GrepResultSchema, {
				result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "writeArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"writeResult",
			create(WriteResultSchema, {
				result: {
					case: "rejected",
					value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "deleteArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"deleteResult",
			create(DeleteResultSchema, {
				result: {
					case: "rejected",
					value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "shellArgs" || exec_case === "shellStreamArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"shellResult",
			create(ShellResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command ?? "",
						workingDirectory: args.workingDirectory ?? "",
						reason: REJECT_REASON,
						isReadonly: false,
					}),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "backgroundShellSpawnArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"backgroundShellSpawnResult",
			create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command ?? "",
						workingDirectory: args.workingDirectory ?? "",
						reason: REJECT_REASON,
						isReadonly: false,
					}),
				},
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "writeShellStdinArgs") {
		send_exec_result(
			exec_msg,
			"writeShellStdinResult",
			create(WriteShellStdinResultSchema, {
				result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) },
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "fetchArgs") {
		const args = exec_msg.message.value;
		send_exec_result(
			exec_msg,
			"fetchResult",
			create(FetchResultSchema, {
				result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) },
			}),
			send_frame,
		);
		return;
	}
	if (exec_case === "diagnosticsArgs") {
		send_exec_result(exec_msg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), send_frame);
	}
}

function handle_interaction_update(
	update: { message?: { case?: string; value?: { text?: string; tokens?: number } } },
	state: StreamState,
	on_text: (text: string, is_thinking?: boolean) => void,
): void {
	const update_case = update.message?.case;
	if (update_case === "textDelta") {
		const delta = update.message?.value?.text || "";
		if (delta) on_text(delta, false);
		return;
	}
	if (update_case === "thinkingDelta") {
		const delta = update.message?.value?.text || "";
		if (delta) on_text(delta, true);
		return;
	}
	if (update_case === "tokenDelta") {
		state.output_tokens += update.message?.value?.tokens ?? 0;
	}
}

function process_server_message(
	msg: AgentServerMessage,
	blob_store: Map<string, Uint8Array>,
	mcp_tools: McpToolDefinition[],
	send_frame: (data: Uint8Array) => void,
	state: StreamState,
	on_text: (text: string, is_thinking?: boolean) => void,
	on_mcp_exec: (exec: PendingMcpExec) => void,
	on_checkpoint?: (checkpoint: Uint8Array) => void,
	on_usage?: (total_tokens: number) => void,
	workspace_path?: string,
): void {
	const msg_case = msg.message.case;
	if (msg_case === "interactionUpdate") {
		handle_interaction_update(msg.message.value as never, state, on_text);
		return;
	}
	if (msg_case === "kvServerMessage") {
		handle_kv_message(msg.message.value as KvServerMessage, blob_store, send_frame);
		return;
	}
	if (msg_case === "execServerMessage") {
		handle_exec_message(
			msg.message.value as ExecServerMessage,
			mcp_tools,
			send_frame,
			on_mcp_exec,
			workspace_path,
		);
		return;
	}
	if (msg_case === "conversationCheckpointUpdate") {
		const state_structure = msg.message.value as ConversationStateStructure;
		if (state_structure.tokenDetails?.usedTokens !== undefined) {
			on_usage?.(state_structure.tokenDetails.usedTokens);
		}
		if (on_checkpoint) {
			on_checkpoint(toBinary(ConversationStateStructureSchema, state_structure));
		}
	}
}

export async function* stream_agent_events(req: CursorChatRequest): AsyncGenerator<CursorChatEvent> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) {
			reset_conversation_after_blob_error(req.session_key);
		}

		try {
			yield* stream_agent_events_once(req);
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt === 0 && is_conversation_recovery_error(message)) {
				continue;
			}
			throw error;
		}
	}
}

async function* stream_agent_events_once(req: CursorChatRequest): AsyncGenerator<CursorChatEvent> {
	const conversation = get_or_create_conversation_state(req.session_key, req.mapped);
	const had_checkpoint_at_start = conversation.checkpoint !== null;
	const payload: CursorRequestPayload = build_run_payload(req.model_id, req.mapped, conversation);

	const bridge = spawn_bridge({
		access_token: req.access_token,
		rpc_path: CURSOR_RUN_RPC_PATH,
	});

	let trailer_error: ConnectTrailerError | null | undefined;
	let bridge_stderr = "";
	let bridge_exit_code = 0;
	let saw_tool_call = false;
	const state: StreamState = { output_tokens: 0, total_tokens: 0 };
	let pending_checkpoint: Uint8Array | undefined;
	let stream_succeeded = false;

	const abort = (): void => {
		try {
			bridge.proc.kill();
		} catch {
			// ignore
		}
	};
	req.signal?.addEventListener("abort", abort, { once: true });

	const heartbeat = setInterval(() => {
		bridge.write(build_client_heartbeat_frame());
	}, 5000);

	let resolve_close: (info: { exit_code: number; stderr: string }) => void = () => {};
	const close_promise = new Promise<{ exit_code: number; stderr: string }>((resolve) => {
		resolve_close = resolve;
	});

	bridge.write(frame_connect_message(payload.request_bytes));

	const event_queue: CursorChatEvent[] = [];
	let done = false;
	let stream_error: Error | undefined;
	let tool_batch_finished = false;

	const push_event = (event: CursorChatEvent): void => {
		event_queue.push(event);
	};

	const finalize_tool_batch = (): void => {
		tool_batch_finished = __chat_test_only_finalize_tool_batch(
			push_event,
			saw_tool_call,
			tool_batch_finished,
		);
	};

	const on_mcp_exec = (exec: PendingMcpExec): void => {
		saw_tool_call = true;
		__chat_test_only_push_mcp_tool(push_event, exec);
		// Keep the Run stream open so Cursor can emit additional MCP tools in one batch.
	};

	const mark_stream_done = (): void => {
		finalize_tool_batch();
		done = true;
	};

	bridge.on_close((info) => {
		bridge_exit_code = info.exit_code;
		bridge_stderr = info.stderr;
		mark_stream_done();
		resolve_close(info);
	});

	bridge.on_data(
		create_connect_frame_parser(
			(message_bytes) => {
				try {
					const server_message = fromBinary(AgentServerMessageSchema, message_bytes);
					process_server_message(
						server_message,
						payload.blob_store,
						payload.mcp_tools,
						(data) => bridge.write(data),
						state,
						(text, is_thinking) => {
							push_event({
								kind: is_thinking ? "reasoning" : "text",
								text,
							});
						},
						on_mcp_exec,
						(checkpoint) => {
							pending_checkpoint = checkpoint;
						},
						(total_tokens) => {
							state.total_tokens = total_tokens;
						},
						req.workspace_path,
					);
				} catch (error) {
					stream_error =
						error instanceof Error ? error : new Error(String(error));
					mark_stream_done();
				}
			},
			(end_stream_bytes) => {
				trailer_error = parse_connect_trailer_error(end_stream_bytes);
				mark_stream_done();
			},
		),
	);

	try {
		while (!done || event_queue.length > 0) {
			while (event_queue.length > 0) {
				yield event_queue.shift()!;
			}
			if (done) break;
			await Promise.race([
				close_promise,
				new Promise<void>((resolve) => setTimeout(resolve, 25)),
			]);
			if (req.signal?.aborted) {
				throw new CursorChatError("Cursor request aborted");
			}
		}

		await close_promise.catch(() => ({ exit_code: 1, stderr: "" }));

		if (stream_error) throw stream_error;
		if (trailer_error || bridge_exit_code !== 0) {
			const message = build_stream_failure_message({
				trailer: trailer_error,
				bridge_stderr,
				exit_code: bridge_exit_code,
				model_id: req.model_id,
			});
			throw new CursorChatError(message, trailer_error?.code);
		}

		if (!saw_tool_call) {
			const completion = state.output_tokens;
			const total = state.total_tokens || completion;
			const prompt = Math.max(0, total - completion);
			yield {
				kind: "usage",
				prompt_tokens: prompt,
				completion_tokens: completion,
				total_tokens: total,
			};
			yield { kind: "finish", reason: "stop" };
		}

		stream_succeeded = true;
	} finally {
		clearInterval(heartbeat);
		req.signal?.removeEventListener("abort", abort);
		if (stream_succeeded) {
			if (pending_checkpoint) {
				update_conversation_checkpoint(req.session_key, pending_checkpoint, payload.blob_store);
			}
			persist_blob_store(req.session_key, payload.blob_store);
		} else if (!had_checkpoint_at_start) {
			// A failed first turn can poison the server-side conversation id; rotate before retry.
			reset_conversation_after_blob_error(req.session_key);
		}
		bridge.end();
	}
}

/** Test helpers for MCP tool batching (no live bridge). */
export function __chat_test_only_push_mcp_tool(
	push_event: (event: CursorChatEvent) => void,
	exec: PendingMcpExec,
): void {
	push_event({ kind: "tool_call_start", id: exec.tool_call_id, name: exec.tool_name });
	push_event({ kind: "tool_call_args", args_delta: exec.decoded_args, id: exec.tool_call_id });
}

export function __chat_test_only_finalize_tool_batch(
	push_event: (event: CursorChatEvent) => void,
	saw_tool_call: boolean,
	already_finished: boolean,
): boolean {
	if (!saw_tool_call || already_finished) return already_finished;
	push_event({ kind: "finish", reason: "tool_calls" });
	return true;
}

export type { PendingMcpExec };
