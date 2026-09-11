/**
 * Compaction output-cap regression guard.
 *
 * The summarizer must never be capped below the model's own output limit: a
 * self-imposed `min(0.8 * reserveTokens, model.maxTokens)` cap stopped
 * generation mid-checkpoint (missing `## Next Steps` / `## Critical Context`)
 * and, on providers that report the truncation as a failure, failed `/compact`
 * outright. A `length` stop must never become a session checkpoint.
 */
import { describe, expect, test } from "bun:test";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	run_stack_compaction,
	summarization_failure,
	summarization_max_output_tokens,
	summarization_output_reserve_tokens,
} from "../stack-compaction.ts";

function fake_model(maxTokens: number, contextWindow = 128_000): Model<Api> {
	return {
		id: "fake-summary-model",
		name: "Fake Summary Model",
		api: "openai-completions",
		provider: "fake-compaction-provider",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	} as unknown as Model<Api>;
}

function fake_assistant(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake-compaction-provider",
		model: "fake-summary-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function fake_preparation(reserveTokens: number): Parameters<typeof run_stack_compaction>[0] {
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
		settings: { enabled: true, keepRecentTokens: 20000, reserveTokens },
	} as unknown as Parameters<typeof run_stack_compaction>[0];
}

/** Capture the request options and answer with a canned summarization result. */
function capture_stream(text: string, stopReason: AssistantMessage["stopReason"]) {
	const seen: { maxTokens?: number }[] = [];
	const stream_fn = (async (_model: unknown, _context: unknown, options: unknown) => {
		seen.push(options as { maxTokens?: number });
		const stream = createAssistantMessageEventStream();
		stream.end(fake_assistant(text, stopReason));
		return stream;
	}) as unknown as StreamFn;
	return { stream_fn, seen };
}

describe("summarizer output budget", () => {
	test("max output tokens is the model limit, never Pi's 0.8 * reserveTokens cap", () => {
		expect(summarization_max_output_tokens(fake_model(8192))).toBe(8192);
		expect(summarization_max_output_tokens(fake_model(64_000))).toBe(64_000);
		// Unknown output limit stays unbounded (pi-ai clamps it to the window).
		expect(summarization_max_output_tokens(fake_model(0))).toBe(Number.POSITIVE_INFINITY);
	});

	test("input budgeting keeps Pi's compact() output allowance", () => {
		expect(summarization_output_reserve_tokens(fake_model(64_000), 16384)).toBe(13107);
		expect(summarization_output_reserve_tokens(fake_model(8192), 16384)).toBe(8192);
		expect(summarization_output_reserve_tokens(fake_model(0), 16384)).toBe(13107);
	});

	test("summarization request is uncapped below the model limit", async () => {
		const { stream_fn, seen } = capture_stream("## Goal\nship it", "stop");
		// reserveTokens 4096 would have capped the request at 3276.
		const result = await run_stack_compaction(
			fake_preparation(4096),
			fake_model(8192),
			{ apiKey: "test-key" },
			undefined,
			undefined,
			stream_fn,
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.maxTokens).toBe(8192);
		expect(result.summary).toContain("ship it");
	});

	test("a length-stop summary is rejected instead of persisted", async () => {
		const { stream_fn } = capture_stream("## Goal\npartial", "length");
		await expect(
			run_stack_compaction(
				fake_preparation(4096),
				fake_model(8192),
				{ apiKey: "test-key" },
				undefined,
				undefined,
				stream_fn,
			),
		).rejects.toThrow("generation hit the token cap and the summary is incomplete");
	});
});

describe("summarization_failure", () => {
	test("keeps the provider reason for an error stop", () => {
		expect(summarization_failure(fake_assistant("", "error"))).toBe("Summarization failed: Unknown error");
	});

	test("reports the token cap for a length stop", () => {
		expect(summarization_failure(fake_assistant("partial", "length"))).toBe(
			"Summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});

	test("accepts a complete summary", () => {
		expect(summarization_failure(fake_assistant("## Goal\nfine", "stop"))).toBeUndefined();
	});
});
