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
	type ToolRenderContext,
	type ToolRenderResultOptions,
} from "./renderer.ts";
import {
	isThinkingBlocksHidden,
	setToolGroupActive,
} from "../pi-ember-ui/mode-colors.ts";
import { subscribe_theme_refresh } from "../pi-ember-ui/theme-refresh.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

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
		setToolGroupActive(renderer.hasActiveGroups());
	});
	pi.on("agent_end", () => {
		renderer.settleAllGroups();
		setToolGroupActive(false);
	});
	pi.on("message_start", (event: any) => {
		if (event?.message?.role === "user") renderer.noteUserMessage();
	});
	pi.on("message_update", (event: any) => {
		// Visible text always marks a boundary: settle the active group so the
		// next groupable tool starts a fresh one.
		// Thinking blocks are trickier:
		// - When thinking blocks are HIDDEN, a thinking_delta produces no visible
		//   transcript break, so the active group can keep updating.
		// - When thinking blocks are SHOWN, the thinking stream appears as its own
		//   visible block below the group, so we must settle the group first so it
		//   flips from "Exploring" to "Explored" instead of continuing to mutate
		//   under the thinking text.
		const ev = event?.assistantMessageEvent;
		if (!ev) return;
		const isText = ev.type === "text_start" || ev.type === "text_delta";
		const isVisibleThinking =
			(ev.type === "thinking_start" || ev.type === "thinking_delta") &&
			!isThinkingBlocksHidden();
		if (isText || isVisibleThinking) {
			renderer.noteVisibleText();
		}
	});
	pi.on("tool_call", (event: any) => {
		if (GROUPABLE_TOOLS.has(event.toolName) || TOOL_FACTORIES[event.toolName]) {
			renderer.registerCall(event.toolName, event.toolCallId, event.input);
			setToolGroupActive(renderer.hasActiveGroups());
		}
	});
	// A completed group member may flip the group-active flag to false
	// (all members done) — update the shared flag so group state and the
	// group header gradient stay synchronized.
	pi.on("tool_execution_end", () => {
		setToolGroupActive(renderer.hasActiveGroups());
	});
	// Reset the shared renderer on session replacement so stale call rows
	// from the previous session do not leak into the new one. The renderer
	// is module-level (shared across sessions because jiti caches the
	// module), so it must be explicitly cleared.
	pi.on("session_start", () => {
		renderer.resetForSession();
		setToolGroupActive(false);
	});
	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		registerCompactTool(pi, name, factory, renderer);
	}
}
