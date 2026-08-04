import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bashGrepInfo, rewriteGrepToRg } from "./bash-grep.ts";
import { sync_compact_group_flags } from "./group-flags.ts";
import {
	type CompactRenderer,
	GROUPABLE_TOOLS,
	WORK_GROUP_SOFT_BOUNDARY_TOOLS,
} from "./renderer.ts";
import { getSharedRenderer } from "./shared-renderer.ts";
import {
	setGroupReopenableActive,
	setToolGroupActive,
	setGroupThinkingChildActive,
	setTurnToolTranscriptActive,
} from "../pi-ember-ui/mode-colors.ts";
import { syncThinkingGradientClock } from "../pi-ember-ui/index.ts";
import { subscribe_theme_refresh } from "../pi-ember-ui/theme-refresh.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Structural mirror of renderer.ts internal ToolResult (not exported) so the
 *  renderResult delegation can pass Pi's result through with an explicit cast. */
type CompactToolResult = {
	content?: Array<{ type: string; text?: string }>;
	details?: { diff?: string; totalMatched?: number };
	[key: string]: unknown;
};

type ToolFactory = (cwd: string) => ToolDefinition;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
	bash: createBashTool,
	edit: createEditTool,
	find: createFindTool,
	grep: createGrepTool,
	ls: createLsTool,
	read: createReadTool,
	write: createWriteTool,
};

function registerCompactTool(
	pi: ExtensionAPI,
	name: string,
	factory: ToolFactory,
	renderer: CompactRenderer,
): void {
	const definition: ToolDefinition = factory(SOURCE_ROOT);
	pi.registerTool({
		name,
		label: name,
		description: definition.description,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
		parameters: definition.parameters,
		renderShell: "self",
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return factory(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme, context) {
			return renderer.renderCall(name, args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderer.renderResult(
				name,
				context.args,
				result as unknown as CompactToolResult,
				options,
				theme,
				context,
			);
		},
	});
}

let unsubscribe_theme_refresh: (() => void) | undefined;

export { bashGrepInfo, rewriteGrepToRg, getSharedRenderer };
export type CompactToolsOptions = { excludeTools?: readonly string[] };

export default function piCompactToolsPlugin(
	pi: ExtensionAPI,
	opts?: CompactToolsOptions,
): void {
	const renderer = getSharedRenderer();
	unsubscribe_theme_refresh?.();
	unsubscribe_theme_refresh = subscribe_theme_refresh((theme) => {
		renderer.refreshThemeColors(theme);
	});
	pi.on("session_shutdown", () => {
		unsubscribe_theme_refresh?.();
		unsubscribe_theme_refresh = undefined;
	});
	pi.on("turn_start", () => {
		renderer.beginTurn();
		sync_compact_group_flags(renderer);
	});
	pi.on("turn_end", () => {
		renderer.endTurn();
		sync_compact_group_flags(renderer);
	});
	pi.on("agent_end", () => {
		renderer.settleAllGroups();
		sync_compact_group_flags(renderer);
	});
	pi.on("agent_start", () => {
		sync_compact_group_flags(renderer);
	});
	pi.on("agent_settled", () => {
		renderer.clearGroupThinkingChild();
		renderer.resyncGroupGradientTick();
		sync_compact_group_flags(renderer);
	});
	pi.on("message_start", (event) => {
		if (event?.message?.role !== "user") return;
		const display = (event.message as { display?: boolean }).display;
		if (display !== false) renderer.noteUserMessage();
		sync_compact_group_flags(renderer);
	});
	pi.on("tool_call", (event) => {
		// The model announced/started a tool call: drop the in-group
		// `└ Thinking` lane synchronously before the call joins or replaces the
		// work group. registerCall/appendToGroup also clears it, but announcing
		// first repaints the shared row text in this same update instead of
		// waiting on the scheduled microtask invalidation.
		renderer.announceToolCall();
		const is_groupable =
			GROUPABLE_TOOLS.has(event.toolName) || TOOL_FACTORIES[event.toolName];
		if (is_groupable) {
			setTurnToolTranscriptActive(true);
			renderer.registerCall(event.toolName, event.toolCallId, event.input);
		} else if (WORK_GROUP_SOFT_BOUNDARY_TOOLS.has(event.toolName)) {
			renderer.noteSoftInterveningToolCall();
		} else {
			renderer.noteInterveningToolCall();
		}
		sync_compact_group_flags(renderer);
	});
	// Completed group members may flip the group-active flag; child-row fold
	// happens on thinking stream, visible assistant text, user message, or the
	// next tool wave (appendToGroup reopen) — not on Pi turn_start/turn_end.
	pi.on("tool_execution_end", () => {
		sync_compact_group_flags(renderer);
	});
	// Reset the shared renderer on session replacement so stale call rows
	// from the previous session do not leak into the new one. The renderer
	// is module-level (shared across sessions because jiti caches the
	// module), so it must be explicitly cleared.
	pi.on("session_start", () => {
		renderer.resetForSession();
		setToolGroupActive(false);
		setGroupThinkingChildActive(false);
		setGroupReopenableActive(false);
		syncThinkingGradientClock();
	});
	const excluded = new Set(opts?.excludeTools ?? []);
	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		if (excluded.has(name)) continue;
		registerCompactTool(pi, name, factory, renderer);
	}
}
