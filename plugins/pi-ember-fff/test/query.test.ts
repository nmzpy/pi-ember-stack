import { describe, expect, test } from "bun:test";
import { normalizePathConstraint, normalizeExcludes, buildQuery } from "../query.ts";

describe("normalizePathConstraint", () => {
	test("empty string returns empty", () => {
		expect(normalizePathConstraint("")).toBe("");
	});

	test("dot returns null", () => {
		expect(normalizePathConstraint(".")).toBeNull();
		expect(normalizePathConstraint("./")).toBeNull();
	});

	test("bare directory gets trailing slash", () => {
		expect(normalizePathConstraint("src")).toBe("src/");
	});

	test("glob is preserved", () => {
		expect(normalizePathConstraint("*.ts")).toBe("*.ts");
		expect(normalizePathConstraint("src/**/*.cc")).toBe("src/**/*.cc");
	});

	test("filename with extension is preserved", () => {
		expect(normalizePathConstraint("main.rs")).toBe("main.rs");
	});

	test("recursive dir glob collapses to prefix", () => {
		expect(normalizePathConstraint("src/**")).toBe("src/");
		expect(normalizePathConstraint("src/**/*")).toBe("src/");
	});

	test("leading ./ is stripped", () => {
		expect(normalizePathConstraint("./src")).toBe("src/");
	});
});

describe("normalizeExcludes", () => {
	test("undefined returns empty array", () => {
		expect(normalizeExcludes(undefined)).toEqual([]);
	});

	test("comma-separated string is split", () => {
		expect(normalizeExcludes("test/, *.min.js")).toEqual(["!test/", "!*.min.js"]);
	});

	test("leading ! is tolerated", () => {
		expect(normalizeExcludes("!src/")).toEqual(["!src/"]);
	});

	test("array input works", () => {
		expect(normalizeExcludes(["test/", "vendor/"])).toEqual(["!test/", "!vendor/"]);
	});
});

describe("buildQuery", () => {
	test("assembles path + excludes + pattern", () => {
		const q = buildQuery("src/", "MyClass", "test/");
		expect(q).toContain("src/");
		expect(q).toContain("!test/");
		expect(q).toContain("MyClass");
	});

	test("no path or excludes yields just pattern", () => {
		expect(buildQuery(undefined, "foo")).toBe("foo");
	});
});
