import { describe, expect, test } from "bun:test";
import {
	build_full_tools,
	DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS,
	OPENAI_CODEX_PROVIDER,
	resolve_patch_tool_name,
	SUBAGENT_RESUME_TOOL_NAME,
	uses_apply_patch_provider,
	with_provider_patch_tool,
} from "../edit-tools.ts";

describe("edit-tools provider resolution", () => {
	test("openai-codex uses apply_patch", () => {
		expect(uses_apply_patch_provider(OPENAI_CODEX_PROVIDER)).toBe(true);
		expect(resolve_patch_tool_name(OPENAI_CODEX_PROVIDER)).toBe("apply_patch");
	});

	test("other providers use edit", () => {
		for (const provider of ["cursor", "devin", "anthropic", undefined]) {
			expect(uses_apply_patch_provider(provider)).toBe(false);
			expect(resolve_patch_tool_name(provider)).toBe("edit");
		}
	});

	test("build_full_tools swaps patch tool by provider", () => {
		const codex = build_full_tools(OPENAI_CODEX_PROVIDER);
		const devin = build_full_tools("devin");
		expect(codex).toContain("apply_patch");
		expect(codex).not.toContain("edit");
		expect(devin).toContain("edit");
		expect(devin).not.toContain("apply_patch");
	});

	test("build_full_tools excludes subagent delegation tools", () => {
		for (const provider of [OPENAI_CODEX_PROVIDER, "devin", undefined]) {
			const tools = build_full_tools(provider);
			expect(tools).not.toContain("subagent");
			expect(tools).not.toContain(SUBAGENT_RESUME_TOOL_NAME);
		}
	});

	test("with_provider_patch_tool normalizes agent lists", () => {
		const from_md = ["read", "bash", "apply_patch", "write", "grep"];
		expect(with_provider_patch_tool(from_md, "devin")).toEqual([
			"read",
			"bash",
			"write",
			"edit",
			"grep",
		]);
		expect(with_provider_patch_tool(from_md, OPENAI_CODEX_PROVIDER)).toEqual([
			"read",
			"bash",
			"write",
			"apply_patch",
			"grep",
		]);
	});

	test("with_provider_patch_tool swaps edit to apply_patch for codex", () => {
		const from_md = ["read", "bash", "edit", "write", "grep"];
		expect(with_provider_patch_tool(from_md, OPENAI_CODEX_PROVIDER)).toEqual([
			"read",
			"bash",
			"write",
			"apply_patch",
			"grep",
		]);
		// coder.md lists edit; a non-codex model keeps edit, never apply_patch.
		expect(with_provider_patch_tool(from_md, "opencode-go")).toEqual([
			"read",
			"bash",
			"write",
			"edit",
			"grep",
		]);
	});

	test("with_provider_patch_tool dedupes when both patch names are listed", () => {
		const both = ["read", "edit", "apply_patch", "write", "grep"];
		expect(with_provider_patch_tool(both, "devin")).toEqual([
			"read",
			"write",
			"edit",
			"grep",
		]);
		expect(with_provider_patch_tool(both, OPENAI_CODEX_PROVIDER)).toEqual([
			"read",
			"write",
			"apply_patch",
			"grep",
		]);
	});

	test("default subagent tools prefer edit until provider resolves codex", () => {
		expect(DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS).toContain("edit");
		expect(DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS).not.toContain("apply_patch");
		// Defaults (edit) are normalized to apply_patch when the resolved model is codex.
		expect(
			with_provider_patch_tool(
				[...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS],
				OPENAI_CODEX_PROVIDER,
			),
		).toContain("apply_patch");
		expect(
			with_provider_patch_tool(
				[...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS],
				OPENAI_CODEX_PROVIDER,
			),
		).not.toContain("edit");
	});
});
