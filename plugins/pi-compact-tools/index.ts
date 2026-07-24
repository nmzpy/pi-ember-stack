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
} from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import {
	CompactRenderer,
	GROUPABLE_TOOLS,
	bashGrepInfo,
	resolve_assistant_group_boundary_event,
	type ToolRenderContext,
	type ToolRenderResultOptions,
} from "./renderer.ts";
import {
	isThinkingBlocksHidden,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	setToolGroupActive,
	setTurnToolTranscriptActive,
} from "../pi-ember-ui/mode-colors.ts";
import { syncThinkingGradientClock } from "../pi-ember-ui/index.ts";
import { subscribe_theme_refresh } from "../pi-ember-ui/theme-refresh.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function update_tool_group_active(renderer: CompactRenderer): void {
	setToolGroupActive(renderer.hasActiveGroups());
	setGroupThinkingChildActive(renderer.hasGroupThinkingChild());
	setGroupReopenableActive(isThinkingBlocksHidden() && renderer.hasReopenableGroup());
	syncThinkingGradientClock();
}

type ToolFactory = (cwd: string) => any;

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
	const definition = factory(SOURCE_ROOT);
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

		async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			return factory(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args: any, theme: any, context: ToolRenderContext): Component {
			return renderer.renderCall(name, args, theme, context);
		},

		renderResult(
			result: any,
			options: ToolRenderResultOptions,
			theme: any,
			context: ToolRenderContext & { isError: boolean },
		): Component {
			return renderer.renderResult(name, context.args, result, options, theme, context);
		},
	});
}

let sharedRenderer: CompactRenderer | null = null;
let unsubscribe_theme_refresh: (() => void) | undefined;

export { bashGrepInfo };

export function getSharedRenderer(): CompactRenderer {
	if (!sharedRenderer) sharedRenderer = new CompactRenderer();
	return sharedRenderer;
}

export default function piCompactToolsPlugin(pi: ExtensionAPI): void {
	const renderer = getSharedRenderer();
	unsubscribe_theme_refresh?.();
	unsubscribe_theme_refresh = subscribe_theme_refresh((theme) => {
		renderer.refreshThemeColors(theme);
	});
	pi.on("session_shutdown", () => {
		unsubscribe_theme_refresh?.();
		unsubscribe_theme_refresh = undefined;
	});
	pi.on("turn_start", () => renderer.beginTurn());
	pi.on("turn_end", () => {
		renderer.endTurn();
		update_tool_group_active(renderer);
	});
	pi.on("agent_end", () => {
		renderer.settleAllGroups();
		update_tool_group_active(renderer);
	});
	pi.on("agent_start", () => {
		update_tool_group_active(renderer);
	});
	pi.on("agent_settled", () => {
		renderer.clearGroupThinkingChild();
		update_tool_group_active(renderer);
	});
	pi.on("message_start", (event: any) => {
		if (event?.message?.role === "user") renderer.noteUserMessage();
	});
	pi.on("message_update", (event: any) => {
		// Group contract (thinking blocks hidden):
		// - visible text → hard exit (header-only, drop reopen pointer);
		// - thinking stream → thinking lane inside the live group;
		// - visible thinking blocks → hard exit like visible text.
		const ev = event?.assistantMessageEvent;
		if (!ev) return;
		const boundary = resolve_assistant_group_boundary_event(ev);
		if (boundary === "visible_text") {
			renderer.noteVisibleText();
			update_tool_group_active(renderer);
		} else if (boundary === "thinking") {
			if (isThinkingBlocksHidden()) renderer.noteThinking();
			else renderer.noteVisibleText();
			update_tool_group_active(renderer);
		}
	});
	pi.on("tool_call", (event: any) => {
		if (GROUPABLE_TOOLS.has(event.toolName) || TOOL_FACTORIES[event.toolName]) {
			setTurnToolTranscriptActive(true);
			renderer.registerCall(event.toolName, event.toolCallId, event.input);
			update_tool_group_active(renderer);
		}
	});
	// A completed group member may flip the group-active flag to false
	// (all members done) — update the shared flag so group state and the
	// group header gradient stay synchronized.
	pi.on("tool_execution_end", () => {
		update_tool_group_active(renderer);
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
	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		registerCompactTool(pi, name, factory, renderer);
	}
}
