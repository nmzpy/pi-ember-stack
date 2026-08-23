import { describe, expect, test } from "bun:test";
import {
	select_summarization_prompt,
	SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../compaction-prompts.ts";

describe("compaction-prompts", () => {
	test("initial prompt includes structured checkpoint sections", () => {
		expect(SUMMARIZATION_PROMPT).toContain("## Goal");
		expect(SUMMARIZATION_PROMPT).toContain("## Progress");
		expect(SUMMARIZATION_PROMPT).toContain("## Next Steps");
		expect(SUMMARIZATION_PROMPT).toContain("## Critical Context");
	});

	test("update prompt preserves merge rules", () => {
		expect(UPDATE_SUMMARIZATION_PROMPT).toContain("<previous-summary>");
		expect(UPDATE_SUMMARIZATION_PROMPT).toContain("### Done");
	});

	test("select_summarization_prompt chooses initial vs update", () => {
		expect(select_summarization_prompt()).toBe(SUMMARIZATION_PROMPT);
		expect(select_summarization_prompt("prior")).toBe(UPDATE_SUMMARIZATION_PROMPT);
	});
});
