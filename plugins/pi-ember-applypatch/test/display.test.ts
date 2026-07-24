import { describe, expect, test } from "bun:test";
import {
	patch_file_errors_by_path,
	patch_files_from_input,
	patch_has_file_errors,
	stats_from_op,
} from "../display.ts";

describe("patch display", () => {
	test("extracts per-file stats from a valid patch", () => {
		const input = [
			"*** Begin Patch",
			"*** Add File: new.ts",
			"+line one",
			"+line two",
			"*** Update File: edit.ts",
			"@@",
			" context",
			"-old",
			"+new",
			"*** End Patch",
		].join("\n");
		expect(patch_files_from_input(input)).toEqual([
			{ path: "new.ts", additions: 2, removals: 0 },
			{ path: "edit.ts", additions: 1, removals: 1 },
		]);
	});

	test("best-effort extraction works while streaming", () => {
		const partial = [
			"*** Begin Patch",
			"*** Update File: gui/utils/config_utils.py",
			"@@",
			"-old",
			"+new",
			"*** Update File: other.py",
			"+added",
		].join("\n");
		expect(patch_files_from_input(partial)).toEqual([
			{ path: "gui/utils/config_utils.py", additions: 1, removals: 1 },
			{ path: "other.py", additions: 1, removals: 0 },
		]);
	});

	test("stats_from_op counts delete as zero-zero", () => {
		expect(stats_from_op({ op: "delete", path: "gone.ts" })).toEqual({
			additions: 0,
			removals: 0,
		});
	});

	test("patch_file_errors_by_path maps failed results by path", () => {
		const errors = patch_file_errors_by_path({
			ok: false,
			fileCount: 1,
			results: [
				{
					path: "gui/utils/config_utils.py",
					op: "update",
					status: "error",
					error: "Invalid Context: @@ -33,8 +33,10 @@",
				},
			],
		});
		expect(errors.get("gui/utils/config_utils.py")).toBe(
			"Invalid Context: @@ -33,8 +33,10 @@",
		);
		expect(patch_has_file_errors({ ok: false, fileCount: 1, results: [] })).toBe(false);
	});
});
