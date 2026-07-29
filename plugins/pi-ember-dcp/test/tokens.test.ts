import { describe, expect, test } from "bun:test";
import { count_tokens, trim_to_token_budget } from "../lib/tokens.ts";

describe("token helpers", () => {
	test("count_tokens uses conservative char heuristic", () => {
		expect(count_tokens("")).toBe(0);
		expect(count_tokens("abcd")).toBe(1);
		expect(count_tokens("abcde")).toBe(2);
	});

	test("trim_to_token_budget returns all items when they fit", () => {
		const items = ["a", "b", "c"];
		const result = trim_to_token_budget(items, 100, (slice) => slice.join(" "));
		expect(result).toEqual(items);
	});

	test("trim_to_token_budget keeps the newest suffix and drops oldest", () => {
		const items = ["first", "mid", "x"];
		// "x" = 1 token; "mid x" = 7 chars -> 2 tokens. Keep last 2 under budget 2.
		const result = trim_to_token_budget(items, 2, (slice) => slice.join(" "));
		expect(result).toEqual(["mid", "x"]);
	});

	test("trim_to_token_budget returns empty when budget is non-positive", () => {
		const items = ["a", "b"];
		expect(trim_to_token_budget(items, 0, (slice) => slice.join(""))).toEqual([]);
		expect(trim_to_token_budget(items, -5, (slice) => slice.join(""))).toEqual([]);
	});

	test("trim_to_token_budget returns empty when a single item exceeds budget", () => {
		const items = ["this is a very long string that definitely exceeds one token"];
		const result = trim_to_token_budget(items, 1, (slice) => slice.join(" "));
		expect(result).toEqual([]);
	});

	test("trim_to_token_budget preserves the last item when it barely fits", () => {
		const items = ["huge-thing-that-will-not-fit", "tiny"];
		const result = trim_to_token_budget(items, 1, (slice) => slice.join(" "));
		expect(result).toEqual(["tiny"]);
	});
});
