/**
 * Keep Pi's self-shell separator for compact subagent rows.
 *
 * Pi owns the ToolExecutionComponent render cycle. The native self-shell
 * renderer prepends one separator row to every tool component — the same
 * 1-row padding every other tool row has, so the `Subagents`/`Delegating`/
 * single-agent header never sits flush against the previous transcript
 * block. This wrapper delegates the complete native render and drops the
 * separator only for pure-spacer (empty) components, i.e. grouped non-owner
 * members, so parallel/successive subagent rows stay tight with no stray
 * blanks below the block.
 */

const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_resume"]);
const PATCH_MARKER = Symbol.for("pi-custom-agents:subagent-render-spacing");

interface ToolExecutionInstance {
	toolName?: string;
}

interface ToolExecutionPrototype {
	render(this: ToolExecutionInstance, width: number): string[];
}

interface ToolExecutionModule {
	ToolExecutionComponent?: {
		prototype: ToolExecutionPrototype;
	};
}

/** Keep the native leading separator for content rows; drop it only for
 *  pure-spacer (empty) components so grouped non-owner members contribute
 *  zero vertical space instead of stacking stray blanks. */
export function strip_subagent_leading_render_gap(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	// A lone blank (the native separator with no content) is an empty
	// non-owner member — render nothing. Content rows keep the separator
	// so the header gets its 1-row padding above.
	if (lines.every((line) => line === "")) return [];
	return lines;
}

/** Install the narrow component wrapper once across jiti module instances. */
export async function install_subagent_render_spacing_patch(): Promise<void> {
	const global_state = globalThis as unknown as Record<PropertyKey, unknown>;
	if (global_state[PATCH_MARKER] === true) return;

	const coding_agent_entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const tool_execution_url = new URL(
		"./modes/interactive/components/tool-execution.js",
		coding_agent_entry,
	);
	const module = (await import(tool_execution_url.href)) as ToolExecutionModule;
	const component = module.ToolExecutionComponent;
	if (!component?.prototype || typeof component.prototype.render !== "function") {
		throw new Error("Unable to install the subagent render-spacing patch: Pi ToolExecutionComponent is unavailable.");
	}

	const native_render = component.prototype.render;
	component.prototype.render = function subagent_render_without_leading_gap(
		this: ToolExecutionInstance,
		width: number,
	): string[] {
		const lines = native_render.call(this, width);
		if (!SUBAGENT_TOOL_NAMES.has(this.toolName ?? "")) return lines;
		return strip_subagent_leading_render_gap(lines);
	};

	global_state[PATCH_MARKER] = true;
}
