import { describe, expect, test } from "bun:test";
import { parse_patch } from "../parse.ts";

describe("parse_patch", () => {
	test("parses add, update with move, and delete", () => {
		const input = `*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
`;
		const result = parse_patch(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ops).toHaveLength(3);
		expect(result.ops[0]).toEqual({
			op: "add",
			path: "hello.txt",
			contents: "Hello world\n",
		});
		expect(result.ops[1].op).toBe("update");
		if (result.ops[1].op === "update") {
			expect(result.ops[1].path).toBe("src/app.py");
			expect(result.ops[1].move_to).toBe("src/main.py");
			expect(result.ops[1].hunks).toHaveLength(1);
			expect(result.ops[1].hunks[0].header).toBe("def greet():");
			expect(result.ops[1].hunks[0].lines).toEqual([
				{ kind: "remove", text: 'print("Hi")' },
				{ kind: "add", text: 'print("Hello, world!")' },
			]);
		}
		expect(result.ops[2]).toEqual({ op: "delete", path: "obsolete.txt" });
	});

	test("rejects missing begin marker", () => {
		const result = parse_patch("*** Add File: a.txt\n+x\n*** End Patch\n");
		expect(result.ok).toBe(false);
	});

	test("rejects duplicate path", () => {
		const input = `*** Begin Patch
*** Add File: a.txt
+one
*** Update File: a.txt
@@
-one
+two
*** End Patch
`;
		const result = parse_patch(input);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Duplicate path");
	});

	test("parses End of File marker", () => {
		const input = `*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** End of File
*** End Patch
`;
		const result = parse_patch(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ops[0].op).toBe("update");
		if (result.ops[0].op === "update") {
			expect(result.ops[0].hunks[0].end_of_file).toBe(true);
		}
	});

	test("parses hunk without @@ header", () => {
		const input = `*** Begin Patch
*** Update File: a.txt
-old
+new
*** End Patch
`;
		const result = parse_patch(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		if (result.ops[0].op === "update") {
			expect(result.ops[0].hunks[0].header).toBeUndefined();
			expect(result.ops[0].hunks[0].lines).toHaveLength(2);
		}
	});

	test("rejects empty patch body", () => {
		const result = parse_patch("*** Begin Patch\n*** End Patch\n");
		expect(result.ok).toBe(false);
	});

	test("strips git unified-diff @@ metadata and applies via context lines", () => {
		const input = `*** Begin Patch
*** Update File: gui/utils/config_utils.py
@@ -33,8 +33,10 @@
 def foo():
-old
+new
*** End Patch
`;
		const result = parse_patch(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		if (result.ops[0].op === "update") {
			expect(result.ops[0].hunks[0].header).toBeUndefined();
			expect(result.ops[0].hunks[0].lines).toEqual([
				{ kind: "keep", text: "def foo():" },
				{ kind: "remove", text: "old" },
				{ kind: "add", text: "new" },
			]);
		}
	});
});
