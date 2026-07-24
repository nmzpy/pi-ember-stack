/**
 * SSOT for provider-aware code-edit tool selection.
 *
 * `apply_patch` is exposed only for the openai-codex provider; all other
 * providers use Pi's native `edit` tool instead.
 */

export const OPENAI_CODEX_PROVIDER = "openai-codex";

export type PatchToolName = "apply_patch" | "edit";

const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content"] as const;

export function uses_apply_patch_provider(provider: string | undefined): boolean {
	return provider === OPENAI_CODEX_PROVIDER;
}

export function resolve_patch_tool_name(provider: string | undefined): PatchToolName {
	return uses_apply_patch_provider(provider) ? "apply_patch" : "edit";
}

export function model_provider_of(model: { provider?: string } | undefined): string | undefined {
	return typeof model?.provider === "string" ? model.provider : undefined;
}

/** Full code-mode tool set with the correct patch/edit tool for the provider. */
export function build_full_tools(provider: string | undefined): string[] {
	const patch_tool = resolve_patch_tool_name(provider);
	return [
		"read",
		"bash",
		"write",
		patch_tool,
		"grep",
		"find",
		"ls",
		"quiz",
		"todo",
		"subagent",
		...WEB_ACCESS_TOOLS,
	];
}

/** Replace apply_patch/edit in an agent tool list with the provider-appropriate tool. */
export function with_provider_patch_tool(tools: string[], provider: string | undefined): string[] {
	const patch_tool = resolve_patch_tool_name(provider);
	const filtered = tools.filter((tool) => tool !== "apply_patch" && tool !== "edit");
	const write_idx = filtered.indexOf("write");
	if (write_idx >= 0) {
		return [...filtered.slice(0, write_idx + 1), patch_tool, ...filtered.slice(write_idx + 1)];
	}
	return [...filtered, patch_tool];
}

export const DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"todo",
] as const;
