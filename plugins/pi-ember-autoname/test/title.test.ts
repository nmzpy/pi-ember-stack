import { describe, expect, it } from "bun:test";
import { extractUserText, sanitizeSessionName, shouldArmAutoNaming } from "../title.ts";

function userMessage(text: string) {
	return { type: "message" as const, message: { role: "user" as const, content: text } };
}

describe("shouldArmAutoNaming", () => {
	it("arms when no name and no user messages", () => {
		expect(shouldArmAutoNaming([], undefined)).toBe(true);
		expect(shouldArmAutoNaming([], "")).toBe(true);
	});

	it("does not arm when a name exists", () => {
		expect(shouldArmAutoNaming([], "Existing")).toBe(false);
	});

	it("does not arm when prior user messages exist", () => {
		expect(shouldArmAutoNaming([userMessage("hi")], undefined)).toBe(false);
	});
});

describe("extractUserText", () => {
	it("extracts string content", () => {
		expect(extractUserText("hello world")).toBe("hello world");
	});

	it("extracts text parts", () => {
		expect(extractUserText([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
	});

	it("returns empty for non-text parts", () => {
		expect(extractUserText([{ type: "image", uri: "x" }])).toBe("");
	});
});

describe("sanitizeSessionName", () => {
	it("strips labels and punctuation", () => {
		expect(sanitizeSessionName("Title: Fix the bug.")).toBe("Fix the bug");
	});

	it("strips code fences", () => {
		expect(sanitizeSessionName("```\nFix Bug\n```")).toBe("Fix Bug");
	});

	it("truncates long titles", () => {
		const long = "a".repeat(80);
		const result = sanitizeSessionName(long);
		expect(result).toBeDefined();
		expect(result?.length).toBeLessThanOrEqual(60);
	});

	it("returns undefined for empty titles", () => {
		expect(sanitizeSessionName("   ")).toBeUndefined();
	});
});
