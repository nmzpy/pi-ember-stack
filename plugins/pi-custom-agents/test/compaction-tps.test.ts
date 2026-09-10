/**
 * Compaction → footer TPS meter wiring.
 *
 * Regression guard for the `• Compacting` row showing no live TPS: the
 * summarization LLM call must STREAM through the canonical ModelRuntime so
 * `pi-ember-tps` receives deltas and the footer paints the meter on the 20 FPS
 * renders the compaction status row already issues via the shared gradient
 * clock. A missing `streamFn` silently fell back to the non-streaming
 * `completeSimple` path, leaving the meter at zero for the whole compaction.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { end_aux_stream, getLiveTps, getLiveTpsOpacity } from "../../pi-ember-tps/index.ts";
import install_compaction_wiring from "../compaction-wiring.ts";
import { resolve_runtime_stream_simple } from "../model-runtime-bridge.ts";
import { run_stack_compaction } from "../stack-compaction.ts";

const FAKE_MODEL = {
	id: "fake-summary-model",
	name: "Fake Summary Model",
	api: "openai-completions",
	provider: "fake-compaction-provider",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>;

function fake_assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: FAKE_MODEL.provider,
		model: FAKE_MODEL.id,
		usage: {
			input: 100,
			output: 12,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 112,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function fake_preparation(): Parameters<typeof run_stack_compaction>[0] {
	return {
		firstKeptEntryId: "entry-1",
		messagesToSummarize: [
			{ role: "user", content: [{ type: "text", text: "fix the widget" }] },
		] as unknown as Message[],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		previousSummary: undefined,
		fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() },
		settings: { reserveTokens: 4096 },
	} as unknown as Parameters<typeof run_stack_compaction>[0];
}

/** Fake ModelRuntime whose `streamSimple` emits real streaming deltas. */
function fake_runtime(on_delta?: () => void) {
	let calls = 0;
	const runtime = {
		streamSimple(_model: Model<Api>, _context: unknown, _opts?: unknown) {
			calls++;
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				stream.push({ type: "text_start" } as never);
				stream.push({ type: "text_delta", delta: "## Goal\n" } as never);
				// Cross the meter's 300 ms warm-up so a live TPS value exists.
				await new Promise((resolve) => setTimeout(resolve, 350));
				stream.push({ type: "text_delta", delta: "ship the footer TPS" } as never);
				// Let the consumer's microtask observe the delta before sampling.
				await new Promise((resolve) => setTimeout(resolve, 0));
				on_delta?.();
				stream.end(fake_assistant("## Goal\nship the footer TPS"));
			})();
			return stream;
		},
	};
	return { runtime, stream_calls: () => calls };
}

afterEach(() => {
	end_aux_stream();
});

describe("compaction summarizer streams through the canonical ModelRuntime", () => {
	test("streamed deltas drive the footer TPS meter", async () => {
		let sampled_tps = 0;
		let sampled_opacity = 0;
		const { runtime } = fake_runtime(() => {
			sampled_tps = getLiveTps();
			sampled_opacity = getLiveTpsOpacity();
		});

		const result = await run_stack_compaction(
			fake_preparation(),
			FAKE_MODEL,
			{ apiKey: "test-key" },
			undefined,
			undefined,
			resolve_runtime_stream_simple({ runtime } as unknown as ModelRegistry),
		);

		expect(result.summary).toContain("ship the footer TPS");
		expect(result.tokensBefore).toBe(1000);
		// Live while streaming (opacity 1 → the footer renders the segment).
		expect(sampled_tps).toBeGreaterThan(0);
		expect(sampled_opacity).toBe(1);
		// Inert again once the summarization span ends.
		expect(getLiveTpsOpacity()).toBe(0);
	});
});

describe("session_before_compact wiring", () => {
	test("hands the canonical runtime streamFn to the summarizer", async () => {
		const { runtime, stream_calls } = fake_runtime();
		let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
		const fake_api = {
			on(event: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) {
				if (event === "session_before_compact") handler = fn;
			},
		} as unknown as ExtensionAPI;
		install_compaction_wiring(fake_api);
		expect(handler).toBeDefined();

		const result = (await handler?.(
			{
				preparation: fake_preparation(),
				branchEntries: [],
				reason: "manual",
				willRetry: false,
				signal: undefined,
			},
			{
				model: FAKE_MODEL,
				modelRegistry: {
					runtime,
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
				},
			},
		)) as { compaction?: { summary?: string } } | undefined;

		expect(stream_calls()).toBe(1);
		expect(result?.compaction?.summary).toContain("ship the footer TPS");
	});
});

describe("resolve_runtime_stream_simple", () => {
	test("delegates to the runtime's streamSimple", async () => {
		const { runtime, stream_calls } = fake_runtime();
		const stream_fn = resolve_runtime_stream_simple({ runtime } as unknown as ModelRegistry);
		expect(stream_fn).toBeDefined();
		const stream = await stream_fn?.(
			FAKE_MODEL,
			{ systemPrompt: "", messages: [] } as never,
			undefined,
		);
		await stream?.result();
		expect(stream_calls()).toBe(1);
	});

	test("returns undefined when no runtime facade exists (legacy Pi)", () => {
		expect(resolve_runtime_stream_simple(undefined)).toBeUndefined();
		expect(resolve_runtime_stream_simple({} as unknown as ModelRegistry)).toBeUndefined();
	});
});
