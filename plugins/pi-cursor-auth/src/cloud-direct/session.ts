/**
 * Per-session Cursor conversation checkpoint state.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	build_cursor_request,
	type CursorRequestPayload,
} from "./request.js";
import {
	ConversationStateStructureSchema,
} from "./proto/agent_pb.js";
import { blob_id_to_store_key, bytes_look_like_blob_id } from "./blobs.js";
import type { CursorMappedContext } from "../context-map.js";
import {
	clear_all_persisted_sessions,
	clear_persisted_session,
	load_persisted_session,
	save_persisted_session,
} from "./session-store.js";

export interface CursorConversationState {
	conversation_id: string;
	checkpoint: Uint8Array | null;
	blob_store: Map<string, Uint8Array>;
}

const session_states = new Map<string, CursorConversationState>();

function new_conversation_id(): string {
	return crypto.randomUUID();
}

function maybe_collect_blob_id(ids: Set<string>, bytes: Uint8Array | undefined): void {
	if (!bytes || bytes.length === 0 || !bytes_look_like_blob_id(bytes)) return;
	ids.add(blob_id_to_store_key(bytes));
}

/** Collect every KV blob id referenced by a server checkpoint (not inline turn bytes). */
export function collect_checkpoint_blob_hex_ids(checkpoint: Uint8Array): string[] {
	const state = fromBinary(ConversationStateStructureSchema, checkpoint);
	const ids = new Set<string>();
	for (const blob_id of state.rootPromptMessagesJson) {
		ids.add(blob_id_to_store_key(blob_id));
	}
	maybe_collect_blob_id(ids, state.summary);
	maybe_collect_blob_id(ids, state.plan);
	maybe_collect_blob_id(ids, state.summaryArchive);
	for (const blob_id of state.summaryArchives) {
		ids.add(blob_id_to_store_key(blob_id));
	}
	for (const value of Object.values(state.fileStates)) {
		maybe_collect_blob_id(ids, value);
	}
	for (const file_state of Object.values(state.fileStatesV2)) {
		maybe_collect_blob_id(ids, file_state.content);
		maybe_collect_blob_id(ids, file_state.initialContent);
	}
	return [...ids];
}

export function checkpoint_has_required_blobs(
	checkpoint: Uint8Array,
	blob_store: Map<string, Uint8Array>,
): boolean {
	for (const blob_id of collect_checkpoint_blob_hex_ids(checkpoint)) {
		if (!blob_store.has(blob_id)) return false;
	}
	return true;
}

function persist_session_state(session_key: string, state: CursorConversationState): void {
	try {
		save_persisted_session(session_key, state);
	} catch {
		// Disk persistence is best-effort — in-memory state remains authoritative for this run.
	}
}

export function get_or_create_conversation_state(
	session_key: string,
	_mapped: CursorMappedContext,
): CursorConversationState {
	let state = session_states.get(session_key);
	if (!state) {
		state =
			load_persisted_session(session_key) ?? {
				conversation_id: new_conversation_id(),
				checkpoint: null,
				blob_store: new Map(),
			};
		session_states.set(session_key, state);
	}
	return state;
}

export function build_run_payload(
	model_id: string,
	mapped: CursorMappedContext,
	state: CursorConversationState,
): CursorRequestPayload {
	let checkpoint = state.checkpoint;
	if (checkpoint && !checkpoint_has_required_blobs(checkpoint, state.blob_store)) {
		checkpoint = null;
		state.checkpoint = null;
		state.conversation_id = new_conversation_id();
	}

	return build_cursor_request(
		model_id,
		mapped,
		state.conversation_id,
		checkpoint,
		state.blob_store,
	);
}

export function persist_blob_store(
	session_key: string,
	blob_store: Map<string, Uint8Array>,
): void {
	const state = session_states.get(session_key);
	if (!state) return;
	for (const [key, value] of blob_store) state.blob_store.set(key, value);
	persist_session_state(session_key, state);
}

export function update_conversation_checkpoint(
	session_key: string,
	checkpoint: Uint8Array,
	blob_store: Map<string, Uint8Array>,
): void {
	const state = session_states.get(session_key);
	if (!state) return;
	state.checkpoint = checkpoint;
	for (const [key, value] of blob_store) state.blob_store.set(key, value);
	persist_session_state(session_key, state);
}

/** Drop checkpoint + blobs and mint a fresh server conversation id. */
export function reset_conversation_after_blob_error(session_key: string): void {
	const state = session_states.get(session_key);
	if (!state) return;
	state.checkpoint = null;
	state.blob_store.clear();
	state.conversation_id = new_conversation_id();
	clear_persisted_session(session_key);
}

export function clear_conversation_state(session_key?: string): void {
	if (session_key) session_states.delete(session_key);
	else session_states.clear();
}

export function clear_all_conversation_states(): void {
	session_states.clear();
	clear_all_persisted_sessions();
}
