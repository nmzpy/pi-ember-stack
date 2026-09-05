import { describe, expect, test } from "bun:test";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import { build_history_summarization_prompt, trim_llm_messages_for_summary } from "../stack-compaction.ts";
import { trim_to_token_budget } from "../stack-compaction-tokens.ts";
import { SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "../compaction-prompts.ts";

function fake_model(contextWindow: number): Model<Api> {
	return { contextWindow, maxTokens: 8192 } as unknown as Model<Api>;
}

function fake_messages(count: number, charsPerMessage = 400): { role: "user"; content: string }[] {
	return Array.from({ length: count }, (_, i) => ({
		role: "user",
		content: `message ${i} ` + "x".repeat(charsPerMessage),
	}));
}

describe("stack-compaction prompt building", () => {
	test("initial history prompt wraps conversation and uses initial template", () => {
		const prompt = build_history_summarization_prompt("[User]: fix music", undefined);
		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain("[User]: fix music");
		expect(prompt).toContain(SUMMARIZATION_PROMPT);
		expect(prompt).not.toContain("<previous-summary>");
	});

	test("update history prompt includes previous summary block", () => {
		const prompt = build_history_summarization_prompt("[User]: continue", "## Goal\nold");
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("## Goal\nold");
		expect(prompt).toContain(UPDATE_SUMMARIZATION_PROMPT);
	});
});

describe("trim_to_token_budget", () => {
	const serialize = (msgs: { role: string; content: string }[]) => msgs.map((m) => m.content).join("\n");

	test("returns all items when they fit the budget", () => {
		const items = fake_messages(3, 40);
		expect(trim_to_token_budget(items, 1000, serialize)).toBe(items);
	});

	test("default keeps the tail (most recent items)", () => {
		const items = fake_messages(10, 400);
		const trimmed = trim_to_token_budget(items, 500, serialize);
		expect(trimmed.length).toBeGreaterThan(0);
		expect(trimmed.length).toBeLessThan(items.length);
		expect(trimmed[0]).toBe(items[items.length - trimmed.length]);
	});

	test("keepHead keeps the oldest items", () => {
		const items = fake_messages(10, 400);
		const trimmed = trim_to_token_budget(items, 500, serialize, { keepHead: true });
		expect(trimmed.length).toBeGreaterThan(0);
		expect(trimmed.length).toBeLessThan(items.length);
		expect(trimmed[0]).toBe(items[0]);
		expect(trimmed[trimmed.length - 1]).toBe(items[trimmed.length - 1]);
	});

	test("returns empty for non-positive budget", () => {
		expect(trim_to_token_budget(fake_messages(3), 0, serialize)).toEqual([]);
	});
});

describe("trim_llm_messages_for_summary", () => {
	test("sends the ENTIRE history untrimmed when it fits the model window (no empty summary)", () => {
		const model = fake_model(1_000_000);
		const messages = fake_messages(50, 400); // ~5k tokens of history
		const llm = trim_llm_messages_for_summary(
			messages,
			model,
			4096,
			build_history_summarization_prompt("", undefined),
		);
		expect(llm.length).toBe(messages.length);
	});

	test("trims to the OLDEST messages only when the window cannot fit the history", () => {
		const model = fake_model(2048);
		const messages = fake_messages(50, 400); // ~5k tokens of history
		const llm = trim_llm_messages_for_summary(
			messages,
			model,
			256,
			build_history_summarization_prompt("", undefined),
		);
		expect(llm.length).toBeGreaterThan(0);
		expect(llm.length).toBeLessThan(messages.length);
		expect(llm[0]).toBe(messages[0]); // oldest history survives
	});

	test("unknown window sends everything (fail loudly, never empty)", () => {
		const model = fake_model(0);
		const messages = fake_messages(10, 400);
		const llm = trim_llm_messages_for_summary(
			messages,
			model,
			4096,
			build_history_summarization_prompt("", undefined),
		);
		expect(llm.length).toBe(messages.length);
	});
});
