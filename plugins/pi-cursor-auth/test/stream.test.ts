import { describe, expect, test } from "bun:test";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { __test_only } from "../src/stream.ts";

const MODEL = {
	id: "auto",
	name: "Auto",
	api: "cursor-cli",
	provider: "cursor",
	baseUrl: "https://cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as Model<Api>;

function make_consumer(tools: Tool[] = []) {
	const output = __test_only.make_initial_message(MODEL);
	const events: AssistantMessageEvent[] = [];
	const stream = {
		push: (event: AssistantMessageEvent) => events.push(event),
	} as unknown as AssistantMessageEventStream;
	const consumer = new __test_only.CursorEventConsumer(output, stream, tools);
	return { consumer, output, events };
}

describe("Cursor event conversion", () => {
	test("converts thinking and mixed delta/snapshot text without duplication", () => {
		const { consumer, output, events } = make_consumer();
		consumer.consume({ type: "thinking", subtype: "delta", text: "Plan", timestamp_ms: 1 });
		consumer.consume({
			type: "assistant",
			timestamp_ms: 2,
			message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
		});
		consumer.consume({
			type: "assistant",
			model_call_id: "model-call",
			message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
		});
		consumer.consume({
			type: "assistant",
			model_call_id: "model-call",
			message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
		});
		consumer.finish();

		expect(output.content).toEqual([
			{ type: "thinking", thinking: "Plan" },
			{ type: "text", text: "Hello" },
		]);
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
			"Hel",
			"lo",
		]);
	});

	test("emits an allowed native tool call using Pi's name and schema", () => {
		const tools: Tool[] = [
			{
				name: "bash",
				description: "Run command",
				parameters: Type.Object({ command: Type.String() }),
			},
		];
		const { consumer, output } = make_consumer(tools);
		const action = consumer.consume({
			type: "tool_call",
			subtype: "started",
			call_id: "call-1",
			tool_call: { shellToolCall: { args: { cmd: "npm test" } } },
		});
		const result = consumer.finish();

		expect(action).toBe("terminate");
		expect(result.toolCall).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "npm test" },
		});
		expect(output.content.at(-1)).toEqual(result.toolCall);
	});

	test("unwraps mcpToolCall envelopes and resolves the inner tool", () => {
		const tools: Tool[] = [
			{
				name: "read",
				description: "Read file",
				parameters: Type.Object({ path: Type.String() }),
			},
		];
		const { consumer, output } = make_consumer(tools);
		const action = consumer.consume({
			type: "tool_call",
			subtype: "started",
			call_id: "call-mcp",
			tool_call: {
				mcpToolCall: {
					args: {
						name: "read_file",
						args: { file_path: "README.md" },
						provider_identifier: "filesystem",
						tool_name: "read_file",
					},
				},
			},
		});
		const result = consumer.finish();

		expect(action).toBe("terminate");
		expect(result.toolCall).toEqual({
			type: "toolCall",
			id: "call-mcp",
			name: "read",
			arguments: { path: "README.md" },
		});
		expect(output.content.at(-1)).toEqual(result.toolCall);
	});

	test("fails closed for a tool absent from Pi's active list", () => {
		const { consumer } = make_consumer();
		const action = consumer.consume({
			type: "tool_call",
			subtype: "started",
			call_id: "call-2",
			tool_call: { deleteToolCall: { args: { path: "important.txt" } } },
		});
		const result = consumer.finish();
		expect(action).toBe("terminate");
		expect(result.toolCall).toBeUndefined();
		expect(result.error).toContain("unavailable tool deleteToolCall");
	});

	test("skips Cursor-native MCP introspection tool calls and continues the stream", () => {
		const { consumer, output } = make_consumer();
		const action = consumer.consume({
			type: "tool_call",
			subtype: "started",
			call_id: "call-mcp",
			tool_call: { getMcpToolsToolCall: { args: { toolCallId: "call-mcp" } } },
		});
		const result = consumer.finish();

		expect(action).toBe("continue");
		expect(result.toolCall).toBeUndefined();
		expect(result.error).toBeUndefined();
		expect(output.content).toEqual([]);
	});

	test("maps reported usage into Pi's accounting contract", () => {
		const { output } = make_consumer();
		__test_only.apply_usage(output, {
			inputTokens: 100,
			outputTokens: 20,
			reasoningTokens: 5,
			cacheReadTokens: 10,
			cacheWriteTokens: 2,
		});
		expect(output.usage).toMatchObject({
			input: 100,
			output: 25,
			reasoning: 5,
			cacheRead: 10,
			cacheWrite: 2,
			totalTokens: 137,
		});
	});

	test("normalizes CLI correlation ids before handing them to Pi", () => {
		expect(__test_only.safe_tool_call_id("call-one\nfc_two/three")).toBe(
			"call-one-fc_two-three",
		);
	});
});
