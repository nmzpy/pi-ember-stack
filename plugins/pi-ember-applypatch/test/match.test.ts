import { describe, expect, test } from "bun:test";
import {
	find_context_matches,
	find_exact_matches,
	line_matches_at_rung,
	normalize_for_fuzzy_match,
	trim_trailing_whitespace_line,
} from "../match.ts";

describe("match ladder", () => {
	test("find_exact_matches only matches byte-for-byte", () => {
		const lines = ["hello ", "world"];
		expect(find_exact_matches(lines, ["hello"])).toEqual([]);
		expect(find_context_matches(lines, ["hello"])).toEqual([0]);
	});

	test("trim_trailing rung ignores trailing spaces", () => {
		expect(trim_trailing_whitespace_line("foo  \t")).toBe("foo");
		expect(line_matches_at_rung("def foo():  ", "def foo():", "trim_trailing")).toBe(true);
	});

	test("fuzzy rung normalizes smart quotes", () => {
		const curly = `print(${String.fromCharCode(0x201c)}hi${String.fromCharCode(0x201d)})`;
		expect(normalize_for_fuzzy_match(curly)).toBe('print("hi")');
		expect(line_matches_at_rung(curly, 'print("hi")', "fuzzy")).toBe(true);
	});

	test("ambiguous fuzzy matches still return all indices", () => {
		const lines = ["x", "y", "x"];
		expect(find_context_matches(lines, ["x"])).toEqual([0, 2]);
	});
});
