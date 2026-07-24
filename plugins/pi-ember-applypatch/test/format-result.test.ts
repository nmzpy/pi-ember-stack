import { describe, expect, test } from "bun:test";
import { getSharedRenderer } from "../../pi-compact-tools/index.ts";
import {
	compact_patch_failure_reason,
	format_result_row,
	type ApplyPatchDetails,
} from "../index.ts";

function makeTheme() {
	return {
		fg: (kind: string, text: string) => `[${kind}:${text}]`,
		bold: (text: string) => `*${text}*`,
	} as any;
}

describe("format_result_row", () => {
	test("surfaces the first apply failure inline", () => {
		const details: ApplyPatchDetails = {
			ok: false,
			fileCount: 1,
			results: [
				{
					path: "plugins/pi-ember-ui/index.ts",
					op: "update",
					status: "error",
					error: "Invalid Context: @@ missing anchor",
				},
			],
		};
		const row = format_result_row(details, makeTheme(), true);
		expect(row).toContain("0/1 ok");
		expect(row).toContain("1 failed");
		expect(row).toContain("Invalid Context");
	});

	test("compact_patch_failure_reason prefers error over hint", () => {
		expect(
			compact_patch_failure_reason({
				ok: false,
				fileCount: 1,
				results: [
					{
						path: "a.ts",
						op: "update",
						status: "error",
						error: "Ambiguous Context",
						hint: "Re-read the file",
					},
				],
			}),
		).toBe("Ambiguous Context");
	});

	test("renderResult replaces the Patching call row in place", async () => {
		const theme = makeTheme();
		const renderer = getSharedRenderer();
		renderer.resetForSession();
		const state: Record<string, unknown> = {};
		const toolCallId = "apply-patch-test-1";
		const context = {
			args: { input: "" },
			toolCallId,
			invalidate: () => {},
			state,
			isError: true,
		};
		const { default: piEmberApplypatch } = await import("../index.ts");
		let toolDef: {
			renderCall: (args: { input: string }, theme: unknown, context: typeof context) => Component;
			renderResult: (
				result: { details: ApplyPatchDetails },
				opts: Record<string, never>,
				theme: unknown,
				context: typeof context & { isError: boolean },
			) => Component;
		};
		piEmberApplypatch({
			registerTool(def: typeof toolDef) {
				toolDef = def;
			},
		} as ExtensionAPI);

		const patch_input = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: b.ts",
			"@@",
			"-x",
			"+y",
			"*** End Patch",
		].join("\n");

		toolDef.renderCall({ input: patch_input }, theme, {
			...context,
			args: { input: patch_input },
		});
		const callText = (state.callText as PatchTextLike).text;
		expect(callText).toContain("Patching");
		expect(callText).toContain("2 files");
		expect(callText).toContain("a.ts");
		expect(callText).toContain("b.ts");
		expect(callText).not.toContain("more");

		const empty = toolDef.renderResult(
			{
				details: {
					ok: false,
					fileCount: 2,
					results: [
						{ path: "a.ts", op: "update", status: "error", error: "Invalid Context" },
						{ path: "b.ts", op: "update", status: "ok" },
					],
				},
			},
			{},
			theme,
			{ ...context, isError: true },
		);
		const resultText = (state.callText as PatchTextLike).text;
		expect(resultText).toContain("Patched");
		expect(resultText).not.toContain("Patching 2 files");
		expect(resultText).toContain("a.ts");
		expect(resultText).toContain("b.ts");
		expect(empty.render(80)).toEqual([]);
	});
});

type PatchTextLike = { text: string };
type Component = { render: (width: number) => string[] };
type ExtensionAPI = { registerTool: (def: unknown) => void };
