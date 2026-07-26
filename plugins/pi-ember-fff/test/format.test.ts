import { describe, expect, test } from "bun:test";
import { fffFileAnnotation, formatFindOutput } from "../format.ts";

describe("fffFileAnnotation", () => {
	test("shows git status when dirty", () => {
		expect(fffFileAnnotation({ gitStatus: "modified" })).toBe("  [modified in git]");
	});

	test("shows very often touched for high frecency", () => {
		expect(fffFileAnnotation({ totalFrecencyScore: 30 })).toBe(
			"  [VERY often touched file]",
		);
	});

	test("shows often touched for warm frecency", () => {
		expect(fffFileAnnotation({ accessFrecencyScore: 22 })).toBe(
			"  [often touched file]",
		);
	});

	test("returns empty for clean low-frecency files", () => {
		expect(fffFileAnnotation({ gitStatus: "clean", totalFrecencyScore: 5 })).toBe("");
	});
});

describe("formatFindOutput weak-find capping", () => {
	test("caps weak scattered matches at five results", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({
			relativePath: `src/file${i}.ts`,
			fileName: `file${i}.ts`,
		}));
		const result = formatFindOutput(
			{
				items,
				scores: [{ total: 1 }],
				totalMatched: 20,
				totalFiles: 20,
			} as Parameters<typeof formatFindOutput>[0],
			30,
			"unlikelyqueryxyz",
		);
		expect(result.weak).toBe(true);
		expect(result.shownCount).toBe(5);
		expect(result.output.split("\n")).toHaveLength(5);
	});

	test("shows full limit for strong matches", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({
			relativePath: `src/strong${i}.ts`,
			fileName: `strong${i}.ts`,
		}));
		const result = formatFindOutput(
			{
				items,
				scores: [{ total: 500 }],
				totalMatched: 10,
				totalFiles: 10,
			} as Parameters<typeof formatFindOutput>[0],
			10,
			"strongquery",
		);
		expect(result.weak).toBe(false);
		expect(result.shownCount).toBe(10);
	});
});
