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
	type ToolRenderContext,
	type ToolRenderResultOptions,
} from "./renderer.ts";

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
		parameters: definition.parameters,
		renderShell: "self",

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

export function getSharedRenderer(): CompactRenderer {
	if (!sharedRenderer) sharedRenderer = new CompactRenderer();
	return sharedRenderer;
}

export default function piCompactToolsPlugin(pi: ExtensionAPI): void {
	const renderer = getSharedRenderer();
	pi.on("turn_start", () => renderer.beginTurn());
	pi.on("tool_call", (event: any) => {
		if (GROUPABLE_TOOLS.has(event.toolName) || TOOL_FACTORIES[event.toolName]) {
			renderer.observeCall(event.toolName, event.toolCallId, event.input);
		}
	});
	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		registerCompactTool(pi, name, factory, renderer);
	}
}
