import { createHash } from "node:crypto";
import { describe, expect, test, beforeEach } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "../src/cloud-direct/proto/agent_pb.ts";
import { map_context_to_cursor } from "../src/context-map.ts";
import { build_cursor_request } from "../src/cloud-direct/request.ts";
import { blob_id_to_store_key } from "../src/cloud-direct/blobs.ts";
import {
	build_run_payload,
	checkpoint_has_required_blobs,
	clear_all_conversation_states,
	collect_checkpoint_blob_hex_ids,
	get_or_create_conversation_state,
	persist_blob_store,
	reset_conversation_after_blob_error,
} from "../src/cloud-direct/session.ts";

describe("Cursor conversation checkpoint blobs", () => {
	beforeEach(() => {
		clear_all_conversation_states();
	});

	test("collects root prompt blob ids from checkpoint bytes", () => {
		const blob_id = new Uint8Array(createHash("sha256").update("system").digest());
		const checkpoint = toBinary(
			ConversationStateStructureSchema,
			create(ConversationStateStructureSchema, {
				rootPromptMessagesJson: [blob_id],
				turns: [],
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
			}),
		);

		expect(collect_checkpoint_blob_hex_ids(checkpoint)).toEqual([
			Buffer.from(blob_id).toString("hex"),
		]);
	});

	test("drops stale checkpoint when referenced blobs are missing locally", () => {
		const mapped = map_context_to_cursor({
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
				{ role: "user", content: "again" },
			],
			tools: [],
		});
		const state = get_or_create_conversation_state("proj", mapped);
		const original_id = state.conversation_id;
		const blob_id = new Uint8Array(createHash("sha256").update("missing").digest());
		state.checkpoint = toBinary(
			ConversationStateStructureSchema,
			create(ConversationStateStructureSchema, {
				rootPromptMessagesJson: [blob_id],
				turns: [],
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
			}),
		);

		expect(checkpoint_has_required_blobs(state.checkpoint!, state.blob_store)).toBe(false);

		const payload = build_run_payload("grok-4.5", mapped, state);
		expect(state.checkpoint).toBeNull();
		expect(state.conversation_id).not.toBe(original_id);
		expect(payload.blob_store.size).toBeGreaterThan(0);
	});

	test("persists blob store across stream completion", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const state = get_or_create_conversation_state("proj", mapped);
		const payload = build_run_payload("grok-4.5", mapped, state);
		const extra_key = "abc123";
		payload.blob_store.set(extra_key, new TextEncoder().encode("blob"));

		persist_blob_store("proj", payload.blob_store);
		expect(new TextDecoder().decode(state.blob_store.get(extra_key)!)).toBe("blob");
	});

	test("reset after blob error clears checkpoint and rotates conversation id", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const state = get_or_create_conversation_state("proj", mapped);
		const original_id = state.conversation_id;
		state.checkpoint = new Uint8Array([1, 2, 3]);
		state.blob_store.set("deadbeef", new Uint8Array([9]));

		reset_conversation_after_blob_error("proj");

		expect(state.checkpoint).toBeNull();
		expect(state.blob_store.size).toBe(0);
		expect(state.conversation_id).not.toBe(original_id);
	});

	test("uses a fresh random conversation id per session state", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const a = get_or_create_conversation_state("session-a", mapped);
		const b = get_or_create_conversation_state("session-b", mapped);
		expect(a.conversation_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(b.conversation_id).not.toBe(a.conversation_id);
	});

	test("isolates checkpoint state per Pi session id", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const first = get_or_create_conversation_state("pi-session-1", mapped);
		const second = get_or_create_conversation_state("pi-session-2", mapped);
		first.checkpoint = new Uint8Array([1, 2, 3]);
		expect(second.checkpoint).toBeNull();
	});

	test("build_cursor_request always stores the current system prompt blob", () => {
		const mapped = map_context_to_cursor({
			systemPrompt: "Base",
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const payload = build_cursor_request("grok-4.5", mapped, crypto.randomUUID(), null);
		const system_json = JSON.stringify({ role: "system", content: mapped.system_prompt });
		const system_blob_id = blob_id_to_store_key(
			new Uint8Array(createHash("sha256").update(system_json).digest()),
		);
		expect(payload.blob_store.has(system_blob_id)).toBe(true);
	});
});
