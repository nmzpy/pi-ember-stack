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
import { isThinkingBlocksHidden, setToolGroupActive } from "../pi-ember-ui/mode-colors.ts";

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

		async execute(
			toolCallId: string,
			params: any,
			signal: AbortSignal,
			onUpdate: any,
			ctx: any,
		) {
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

export { bashGrepInfo };

export function getSharedRenderer(): CompactRenderer {
	if (!sharedRenderer) sharedRenderer = new CompactRenderer();
	return sharedRenderer;
}

export default function piCompactToolsPlugin(pi: ExtensionAPI): void {
	const renderer = getSharedRenderer();
	pi.on("turn_start", () => renderer.beginTurn());
	pi.on("turn_end", (event: any) => {
		renderer.endTurn(isThinkingBlocksHidden(), event?.message);
		setToolGroupActive(false);
	});
	pi.on("message_start", (event: any) => {
		if (event?.message?.role === "user") renderer.noteUserMessage();
	});
	pi.on("message_update", (event: any) => {
		// When the model streams visible text (not just thinking tokens),
		// mark the turn as having visible output so the next discovery
		// call starts a fresh group instead of appending to the previous
		// turn's group. Thinking-only turns keep grouping coherent.
		const ev = event?.assistantMessageEvent;
		if (ev && (ev.type === "text_start" || ev.type === "text_delta")) {
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
	// (all members done) — update the shared flag so the Thinking/Working
	// widget can return and the group header reverts to plain bold.
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
