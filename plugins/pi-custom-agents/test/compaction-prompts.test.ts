import { describe, expect, test } from "bun:test";
import {
	merge_split_turn_summaries,
	select_summarization_prompt,
	SPLIT_TURN_HEADER,
	SUMMARIZATION_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
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

	test("turn prefix prompt includes split-turn handoff sections", () => {
		expect(TURN_PREFIX_SUMMARIZATION_PROMPT).toContain("## Original Request");
		expect(TURN_PREFIX_SUMMARIZATION_PROMPT).toContain("## Context for Suffix");
	});

	test("select_summarization_prompt chooses initial vs update", () => {
		expect(select_summarization_prompt()).toBe(SUMMARIZATION_PROMPT);
		expect(select_summarization_prompt("prior")).toBe(UPDATE_SUMMARIZATION_PROMPT);
	});

	test("merge_split_turn_summaries uses split-turn header glue", () => {
		const merged = merge_split_turn_summaries("history", "prefix");
		expect(merged).toContain("history");
		expect(merged).toContain("prefix");
		expect(merged).toContain(SPLIT_TURN_HEADER);
		expect(merged).toContain("---");
	});

	test("merge_split_turn_summaries omits empty history section", () => {
		const merged = merge_split_turn_summaries("", "prefix only");
		expect(merged).toBe("prefix only");
		expect(merged).not.toContain("No prior history");
	});
});
