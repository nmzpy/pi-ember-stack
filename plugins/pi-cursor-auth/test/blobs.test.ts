import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	assert_conversation_blobs_present,
	blob_id_to_store_key,
	lookup_blob,
	store_blob,
} from "../src/cloud-direct/blobs.ts";
import { build_cursor_request, resolve_cursor_model_id } from "../src/cloud-direct/request.ts";
import { map_context_to_cursor } from "../src/context-map.ts";
import {
	AgentClientMessageSchema,
	ConversationStateStructureSchema,
} from "../src/cloud-direct/proto/agent_pb.ts";

describe("Cursor blob store keys", () => {
	test("request build and KV lookup share the same hex key for raw digest ids", () => {
		const mapped = map_context_to_cursor({
			systemPrompt: "Base",
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const payload = build_cursor_request("auto", mapped, crypto.randomUUID(), null);
		const msg = fromBinary(AgentClientMessageSchema, payload.request_bytes);
		const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
		expect(run).toBeDefined();
		const blob_id = run!.conversationState!.rootPromptMessagesJson[0]!;
		const key = blob_id_to_store_key(blob_id);
		expect(lookup_blob(payload.blob_store, blob_id)).toBeDefined();
		expect(payload.blob_store.get(key)).toBeDefined();
	});

	test("lookup accepts hex-ascii blob ids from the server", () => {
		const system_json = JSON.stringify({ role: "system", content: "hello" });
		const system_bytes = new TextEncoder().encode(system_json);
		const digest = new Uint8Array(createHash("sha256").update(system_bytes).digest());
		const store = new Map<string, Uint8Array>();
		store_blob(store, digest, system_bytes);

		const ascii_id = new TextEncoder().encode(blob_id_to_store_key(digest));
		expect(lookup_blob(store, ascii_id)).toEqual(system_bytes);
	});

	test("assert_conversation_blobs_present passes for new chat payloads", () => {
		const mapped = map_context_to_cursor({
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		const payload = build_cursor_request("auto", mapped, crypto.randomUUID(), null);
		const msg = fromBinary(AgentClientMessageSchema, payload.request_bytes);
		const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
		expect(() =>
			assert_conversation_blobs_present(
				run!.conversationState!.rootPromptMessagesJson,
				payload.blob_store,
			),
		).not.toThrow();
	});

	test("assert_conversation_blobs_present fails when checkpoint blobs are absent", () => {
		const blob_id = new Uint8Array(createHash("sha256").update("missing").digest());
		const checkpoint = create(ConversationStateStructureSchema, {
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
		});
		expect(() =>
			assert_conversation_blobs_present(checkpoint.rootPromptMessagesJson, new Map()),
		).toThrow(/missing root prompt blob/);
	});

	test("resolve_cursor_model_id keeps default and maps legacy auto", () => {
		expect(resolve_cursor_model_id("default")).toBe("default");
		expect(resolve_cursor_model_id("auto")).toBe("default");
		expect(resolve_cursor_model_id("composer-2")).toBe("composer-2");
	});
});
