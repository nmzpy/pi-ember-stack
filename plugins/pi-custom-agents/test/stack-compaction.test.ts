import { describe, expect, test } from "bun:test";
import { build_history_summarization_prompt } from "../stack-compaction.ts";
import { SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "../compaction-prompts.ts";

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
