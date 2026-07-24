import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
} from "../src/cloud-direct/proto/agent_pb.ts";
import { map_context_to_cursor } from "../src/context-map.ts";
import {
	build_cursor_request,
	format_tool_results_for_cursor,
} from "../src/cloud-direct/request.ts";

describe("format_tool_results_for_cursor", () => {
	test("preserves tool_call_id markers in outbound user text", () => {
		const formatted = format_tool_results_for_cursor([
			{ tool_call_id: "call-read", content: "a.ts contents" },
			{ tool_call_id: "call-edit", content: "ok" },
		]);
		expect(formatted).toContain('tool_call_id="call-read"');
		expect(formatted).toContain("a.ts contents");
		expect(formatted).toContain('tool_call_id="call-edit"');
	});
});

describe("build_cursor_request history encoding", () => {
	test("build_cursor_request keeps the first user message out of turns", () => {
		const mapped = map_context_to_cursor({
			systemPrompt: "Base",
			messages: [{ role: "user", content: "hello" }],
			tools: [],
		});
		expect(mapped.turns).toEqual([]);
		expect(mapped.user_text).toBe("hello");

		const payload = build_cursor_request("default", mapped, crypto.randomUUID(), null);
		const client_message = fromBinary(AgentClientMessageSchema, payload.request_bytes);
		const run_request = client_message.message.case === "runRequest" ? client_message.message.value : undefined;
		expect(run_request?.conversationState?.turns.length).toBe(0);
		expect(run_request?.action?.action.case).toBe("userMessageAction");
	});

	test("embeds assistant tool calls into rebuilt conversation turns", () => {
		const mapped = map_context_to_cursor({
			systemPrompt: "Base",
			messages: [
				{ role: "user", content: "read a file" },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
				},
				{ role: "toolResult", toolCallId: "c1", content: "done earlier", isError: false },
				{ role: "assistant", content: [{ type: "text", text: "finished" }] },
			],
			tools: [],
		});

		const payload = build_cursor_request("auto", mapped, crypto.randomUUID(), null);
		const client_message = fromBinary(AgentClientMessageSchema, payload.request_bytes);
		expect(client_message.message.case).toBe("runRequest");
		const run_request = client_message.message.value;
		if (client_message.message.case !== "runRequest" || !run_request) {
			throw new Error("expected runRequest");
		}
		const conversation_state = run_request.conversationState;
		if (!conversation_state) throw new Error("expected conversation state");
		expect(conversation_state.turns.length).toBe(1);

		const turn_structure = fromBinary(ConversationTurnStructureSchema, conversation_state.turns[0] ?? new Uint8Array());
		if (turn_structure.turn.case !== "agentConversationTurn" || !turn_structure.turn.value) {
			throw new Error("expected agent conversation turn");
		}
		const agent_turn = turn_structure.turn.value;
		expect(agent_turn.steps.length).toBeGreaterThanOrEqual(2);

		const step_cases = agent_turn.steps.map((step_bytes) => {
			const step = fromBinary(ConversationStepSchema, step_bytes);
			return step.message.case;
		});
		expect(step_cases).toContain("toolCall");
		expect(step_cases).toContain("assistantMessage");
	});
});
