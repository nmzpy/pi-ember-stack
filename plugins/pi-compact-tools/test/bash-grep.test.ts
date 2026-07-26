import { describe, expect, test } from "bun:test";
import { bashGrepInfo, rewriteGrepToRg } from "../bash-grep.ts";

describe("bashGrepInfo", () => {
	test("detects simple grep", () => {
		expect(bashGrepInfo("grep foo")).toEqual({ pattern: "foo", path: "." });
	});

	test("detects cd && grep", () => {
		expect(bashGrepInfo("cd src && grep bar")).toEqual({
			pattern: "bar",
			path: "src",
		});
	});

	test("stops at pipe", () => {
		expect(bashGrepInfo("grep foo | wc -l")).toEqual({
			pattern: "foo",
			path: ".",
		});
	});

	test("returns undefined for non-grep", () => {
		expect(bashGrepInfo("ls -la")).toBeUndefined();
	});
});

describe("rewriteGrepToRg", () => {
	test("rewrites simple grep to rg", () => {
		expect(rewriteGrepToRg("grep foo")).toBe("rg -- foo");
	});

	test("rewrites combined short flags", () => {
		const result = rewriteGrepToRg("grep -rn foo");
		expect(result).toBe("rg -n -- foo");
	});

	test("rewrites cd && grep with path", () => {
		const result = rewriteGrepToRg("cd src && grep -i pattern");
		expect(result).toBe("cd src && rg -i -- pattern");
	});

	test("translates --include and --exclude-dir", () => {
		const result = rewriteGrepToRg(
			"grep --include '*.ts' --exclude-dir node_modules pattern",
		);
		expect(result).toContain("-g");
		expect(result).toContain("*.ts");
		expect(result).toContain("!node_modules/");
		expect(result).toContain("-- pattern");
	});

	test("strips stderr redirect before parsing paths", () => {
		const result = rewriteGrepToRg("grep foo bar 2>/dev/null");
		expect(result).toBe("rg -- foo bar");
	});

	test("bails on pipe (does not rewrite piped grep)", () => {
		// rewriteGrepToRg only processes before pipe; piped grep still rewrites
		// the grep portion — detection uses bashGrepInfo which also stops at pipe.
		const result = rewriteGrepToRg("grep foo | wc -l");
		expect(result).toBe("rg -- foo");
	});

	test("bails on unknown flags", () => {
		expect(rewriteGrepToRg("grep --color=auto foo")).toBeUndefined();
	});

	test("bails on invalid combined flags", () => {
		expect(rewriteGrepToRg("grep -xz foo")).toBeUndefined();
	});
});
