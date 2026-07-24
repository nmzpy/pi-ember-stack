import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	apply_hunks_to_content,
	apply_ops,
	find_exact_matches,
	make_temp_workspace,
} from "../apply.ts";
import { parse_patch } from "../parse.ts";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

function tmp(): string {
	const dir = make_temp_workspace();
	temps.push(dir);
	return dir;
}

function write(root: string, rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf8");
}

function read(root: string, rel: string): string {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("find_exact_matches", () => {
	test("returns all matches for ambiguity", () => {
		const lines = ["a", "x", "b", "x", "c"];
		expect(find_exact_matches(lines, ["x"])).toEqual([1, 3]);
	});

	test("prefer_eof returns only eof match when it fits", () => {
		const lines = ["a", "b", "c"];
		expect(find_exact_matches(lines, ["b", "c"], 0, true)).toEqual([1]);
	});
});

describe("apply_hunks_to_content", () => {
	test("applies strict update", () => {
		const next = apply_hunks_to_content("hello\nworld\n", [
			{
				lines: [
					{ kind: "remove", text: "world" },
					{ kind: "add", text: "ember" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toBe("hello\nember\n");
	});

	test("preserves CRLF", () => {
		const next = apply_hunks_to_content("hello\r\nworld\r\n", [
			{
				lines: [
					{ kind: "keep", text: "hello" },
					{ kind: "remove", text: "world" },
					{ kind: "add", text: "ember" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toBe("hello\r\nember\r\n");
	});

	test("invalid context throws", () => {
		expect(() =>
			apply_hunks_to_content("a\n", [
				{
					lines: [{ kind: "remove", text: "missing" }],
					end_of_file: false,
				},
			]),
		).toThrow(/Invalid Context/);
	});

	test("ambiguous context throws", () => {
		expect(() =>
			apply_hunks_to_content("x\ny\nx\n", [
				{
					lines: [
						{ kind: "remove", text: "x" },
						{ kind: "add", text: "z" },
					],
					end_of_file: false,
				},
			]),
		).toThrow(/Ambiguous Context/);
	});

	test("applies when git @@ metadata is stripped and context lines match", () => {
		const next = apply_hunks_to_content("def foo():\nold\n", [
			{
				lines: [
					{ kind: "keep", text: "def foo():" },
					{ kind: "remove", text: "old" },
					{ kind: "add", text: "new" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toBe("def foo():\nnew\n");
	});

	test("fuzzy match tolerates trailing whitespace on context lines", () => {
		const next = apply_hunks_to_content("def foo():  \nold\n", [
			{
				lines: [
					{ kind: "keep", text: "def foo():" },
					{ kind: "remove", text: "old" },
					{ kind: "add", text: "new" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toBe("def foo():  \nnew\n");
	});

	test("fuzzy match preserves original bytes on keep lines", () => {
		const next = apply_hunks_to_content("def foo():  \nold\n", [
			{
				lines: [
					{ kind: "keep", text: "def foo():" },
					{ kind: "remove", text: "old" },
					{ kind: "add", text: "new" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toContain("def foo():  ");
	});

	test("@@ soft anchor narrows window", () => {
		// Without @@, "x" is ambiguous; after "first" only the second "x" matches.
		const next = apply_hunks_to_content("x\nfirst\nx\nsecond\n", [
			{
				header: "first",
				lines: [
					{ kind: "remove", text: "x" },
					{ kind: "add", text: "X" },
				],
				end_of_file: false,
			},
		]);
		expect(next).toBe("x\nfirst\nX\nsecond\n");
	});

	test("End of File insert appends at eof", () => {
		const next = apply_hunks_to_content("a\nb\n", [
			{
				lines: [{ kind: "add", text: "c" }],
				end_of_file: true,
			},
		]);
		expect(next).toBe("a\nb\nc\n");
	});
});

describe("apply_ops filesystem", () => {
	test("multi-file add + update + delete", async () => {
		const root = tmp();
		write(root, "keep.txt", "old\n");
		write(root, "gone.txt", "bye\n");

		const parsed = parse_patch(`*** Begin Patch
*** Add File: new.txt
+hello
*** Update File: keep.txt
-old
+new
*** Delete File: gone.txt
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(true);
		expect(read(root, "new.txt")).toBe("hello\n");
		expect(read(root, "keep.txt")).toBe("new\n");
		expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(false);
	});

	test("parallel updates across files", async () => {
		const root = tmp();
		write(root, "a.txt", "A\n");
		write(root, "b.txt", "B\n");
		write(root, "c.txt", "C\n");

		const parsed = parse_patch(`*** Begin Patch
*** Update File: a.txt
-A
+a
*** Update File: b.txt
-B
+b
*** Update File: c.txt
-C
+c
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(true);
		expect(read(root, "a.txt")).toBe("a\n");
		expect(read(root, "b.txt")).toBe("b\n");
		expect(read(root, "c.txt")).toBe("c\n");
	});

	test("partial success: invalid context on one file still updates another", async () => {
		const root = tmp();
		write(root, "good.txt", "ok\n");
		write(root, "bad.txt", "stay\n");

		const parsed = parse_patch(`*** Begin Patch
*** Update File: good.txt
-ok
+done
*** Update File: bad.txt
-missing
+nope
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(false);
		expect(summary.results.find((r) => r.path === "good.txt")?.status).toBe("ok");
		expect(summary.results.find((r) => r.path === "bad.txt")?.status).toBe("error");
		expect(summary.results.find((r) => r.path === "bad.txt")?.error).toMatch(/Invalid Context/);
		expect(read(root, "good.txt")).toBe("done\n");
		expect(read(root, "bad.txt")).toBe("stay\n");
	});

	test("move after update", async () => {
		const root = tmp();
		write(root, "old/name.txt", "v1\n");

		const parsed = parse_patch(`*** Begin Patch
*** Update File: old/name.txt
*** Move to: new/name.txt
-v1
+v2
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(true);
		expect(fs.existsSync(path.join(root, "old/name.txt"))).toBe(false);
		expect(read(root, "new/name.txt")).toBe("v2\n");
	});

	test("preserves CRLF on disk", async () => {
		const root = tmp();
		write(root, "crlf.txt", "a\r\nb\r\n");
		const parsed = parse_patch(`*** Begin Patch
*** Update File: crlf.txt
-a
+A
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		await apply_ops(root, parsed.ops);
		expect(read(root, "crlf.txt")).toBe("A\r\nb\r\n");
	});

	test("rejects path traversal", async () => {
		const root = tmp();
		const parsed = parse_patch(`*** Begin Patch
*** Add File: ../escape.txt
+nope
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(false);
		expect(summary.results[0].error).toMatch(/escapes|Absolute/i);
	});

	test("add fails if exists", async () => {
		const root = tmp();
		write(root, "a.txt", "x\n");
		const parsed = parse_patch(`*** Begin Patch
*** Add File: a.txt
+y
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.results[0].status).toBe("error");
		expect(summary.results[0].error).toMatch(/already exists/i);
	});

	test("delete fails if missing", async () => {
		const root = tmp();
		const parsed = parse_patch(`*** Begin Patch
*** Delete File: missing.txt
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.results[0].status).toBe("error");
		expect(summary.results[0].error).toMatch(/does not exist/i);
	});

	test("End of File insert on disk", async () => {
		const root = tmp();
		write(root, "eof.txt", "a\nb\n");
		const parsed = parse_patch(`*** Begin Patch
*** Update File: eof.txt
@@
+c
*** End of File
*** End Patch
`);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const summary = await apply_ops(root, parsed.ops);
		expect(summary.ok).toBe(true);
		expect(read(root, "eof.txt")).toBe("a\nb\nc\n");
	});
});
