import { describe, expect, test } from "bun:test";
import { buildEditErrorMessage } from "../edit-errors";

function attempt(oldText: string, newText = ""): { oldText: string; newText: string } {
	return { oldText, newText };
}

describe("buildEditErrorMessage", () => {
	test("not-found with indent-tolerant candidate points to the correct block", () => {
		const content = [
			"class Foo {",
			"  constructor() {",
			"    this.x = 1;",
			"  }",
			"}",
		].join("\n");
		const oldText = [
			"  constructor() {",
			"    this.x = 1;",
			"  }",
		].join("\n");
		const error = new Error("Could not find the exact text in foo.ts. The old text must match exactly.");
		const message = buildEditErrorMessage("foo.ts", content, [attempt(oldText)], error);
		expect(message).toContain("Could not find the exact text in foo.ts");
		expect(message).toContain("Nearest similar block found around line 2");
		expect(message).toContain("constructor() {");
	});

	test("not-found without candidate suggests re-read", () => {
		const content = "hello world\n";
		const error = new Error("Could not find the exact text in bar.ts. The old text must match exactly.");
		const message = buildEditErrorMessage("bar.ts", content, [attempt("missing block")], error);
		expect(message).toContain("Could not find the exact text in bar.ts");
		expect(message).toContain("No similar block found");
		expect(message).toContain("re-read the file");
	});

	test("duplicate lists occurrence line numbers", () => {
		const content = "// header\nfunction a() {}\nfunction b() {}\nfunction a() {}\nfunction c() {}\n";
		const error = new Error("Found 3 occurrences of the text in dup.ts. The text must be unique.");
		const message = buildEditErrorMessage("dup.ts", content, [attempt("function a() {}")], error);
		expect(message).toContain("Found 2 occurrence(s) at line(s): 2, 4");
		expect(message).toContain("Add surrounding context to make oldText unique");
	});

	test("empty oldText is reported clearly", () => {
		const error = new Error("oldText must not be empty in empty.ts");
		const message = buildEditErrorMessage("empty.ts", "x", [attempt("")], error);
		expect(message).toContain("oldText must not be empty in empty.ts");
	});

	test("overlap preserves index information", () => {
		const error = new Error("edits[0] and edits[1] overlap in over.ts. Merge them into one edit.");
		const message = buildEditErrorMessage("over.ts", "abc", [attempt("a", "b"), attempt("b", "c")], error);
		expect(message).toContain("edits[0] and edits[1] overlap in over.ts");
		expect(message).toContain("disjoint regions");
	});

	test("no-change reports verification hint", () => {
		const error = new Error("No changes made to same.ts. The replacements produced identical content.");
		const message = buildEditErrorMessage("same.ts", "abc", [attempt("a", "a")], error);
		expect(message).toContain("No changes made to same.ts");
		expect(message).toContain("oldText and newText differ");
	});

	test("io error includes actionable hint", () => {
		const error = new Error("Could not edit file: missing.ts. Error code: ENOENT.");
		const message = buildEditErrorMessage("missing.ts", "", [attempt("x")], error);
		expect(message).toContain("Could not edit file: missing.ts");
		expect(message).toContain("confirm the file exists");
	});

	test("unknown error appends generic re-read hint", () => {
		const error = new Error("Something went wrong");
		const message = buildEditErrorMessage("weird.ts", "content", [attempt("old")], error);
		expect(message).toContain("Something went wrong");
		expect(message).toContain("re-read the file");
	});
});
