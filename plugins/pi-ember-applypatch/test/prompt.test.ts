import { describe, expect, test } from "bun:test";
import { TOOL_PROMPT_GUIDELINES, TOOL_PROMPT_SNIPPET } from "../prompt.ts";

describe("apply_patch prompt metadata", () => {
	test("snippet is present for Pi Available tools section", () => {
		expect(TOOL_PROMPT_SNIPPET.length).toBeGreaterThan(0);
		expect(TOOL_PROMPT_SNIPPET).toMatch(/patch/i);
	});

	test("guidelines name apply_patch and document hunk line prefixes", () => {
		expect(TOOL_PROMPT_GUIDELINES.length).toBeGreaterThan(0);
		for (const line of TOOL_PROMPT_GUIDELINES) {
			expect(line).toMatch(/apply_patch/);
		}
		const joined = TOOL_PROMPT_GUIDELINES.join("\n");
		expect(joined).toContain("` `");
		expect(joined).toContain("`-`");
		expect(joined).toContain("`+`");
		expect(joined).toContain("*** Begin Patch");
		expect(joined).toContain("git-style");
		expect(joined).toContain("trailing whitespace");
	});
});
