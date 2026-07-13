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
import { Text, type Component } from "@earendil-works/pi-tui";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BULLET = "• ";
const DISCOVERY_TOOLS = new Set(["read", "grep", "find", "ls"]);

type ToolFactory = (cwd: string) => any;
type ToolRenderContext = {
	args: any;
	toolCallId: string;
	invalidate: () => void;
};
type ToolRenderResultOptions = {
	isPartial: boolean;
};
type CompactCall = {
	id: string;
	name: string;
	args: any;
	group?: DiscoveryGroup;
	invalidate?: () => void;
	isError: boolean;
};
type DiscoveryGroup = {
	records: CompactCall[];
};

function textValue(value: unknown, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	return String(value).replace(/[\r\n]+/g, " ");
}

function toolPath(args: any): string {
	return textValue(args?.file_path ?? args?.path, ".");
}

function errorText(result: any, isError: boolean): string | undefined {
	const content = result?.content?.find((item: any) => item.type === "text");
	if (!isError && !content?.text?.startsWith("Error")) return undefined;
	return textValue(content?.text, "Tool failed").split("\n")[0];
}

function diffStats(result: any): { additions: number; removals: number } {
	const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function formatCallBody(name: string, args: any, theme: any): string {
	const pathName = toolPath(args);
	switch (name) {
		case "read":
			return theme.fg("toolTitle", theme.bold("Read")) +
				theme.fg("accent", ` ${pathName}`);
		case "grep":
			return theme.fg("toolTitle", theme.bold("Search")) +
				theme.fg("accent", ` ${textValue(args?.pattern)}`) +
				theme.fg("toolOutput", ` in ${pathName}`);
		case "find":
			return theme.fg("toolTitle", theme.bold("Find")) +
				theme.fg("accent", ` ${textValue(args?.pattern)}`) +
				theme.fg("toolOutput", ` in ${pathName}`);
		case "ls":
			return theme.fg("toolTitle", theme.bold("List")) +
				theme.fg("accent", ` ${pathName}`);
		case "bash":
			return theme.fg("toolTitle", theme.bold("Run")) +
				theme.fg("accent", ` $ ${textValue(args?.command)}`);
		case "edit":
			return theme.fg("toolTitle", theme.bold("edit")) +
				theme.fg("accent", ` ${pathName}`);
		case "write":
			return theme.fg("toolTitle", theme.bold("write")) +
				theme.fg("accent", ` ${pathName}`);
		default:
			return theme.fg("toolTitle", theme.bold(name));
	}
}

function formatGroup(group: DiscoveryGroup, theme: any): string {
	const lines = [
		theme.fg("muted", BULLET) + theme.fg("toolTitle", theme.bold("Explored")),
	];
	for (const [index, record] of group.records.entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		lines.push(theme.fg("dim", prefix) + formatCallBody(record.name, record.args, theme));
	}
	return lines.join("\n");
}

class CompactRenderer {
	private readonly calls = new Map<string, CompactCall>();
	private lastCall: CompactCall | undefined;

	beginTurn(): void {
		this.lastCall = undefined;
	}

	observeCall(name: string, id: string, args: any): CompactCall {
		return this.registerCall(name, id, args);
	}

	registerCall(
		name: string,
		id: string,
		args: any,
		invalidate?: () => void,
	): CompactCall {
		const existing = this.calls.get(id);
		if (existing) {
			existing.args = args;
			existing.invalidate = invalidate ?? existing.invalidate;
			return existing;
		}

		const record: CompactCall = { id, name, args, isError: false };
		this.calls.set(id, record);
		if (DISCOVERY_TOOLS.has(name) && this.lastCall && DISCOVERY_TOOLS.has(this.lastCall.name)) {
			const group = this.lastCall.group ?? { records: [this.lastCall] };
			this.lastCall.group = group;
			group.records.push(record);
			record.group = group;
			for (const groupedCall of group.records) groupedCall.invalidate?.();
		}
		this.lastCall = record;
		record.invalidate = invalidate;
		return record;
	}

	setResult(record: CompactCall, result: any, isError: boolean): void {
		record.isError = isError;
		if (record.group) {
			record.group.records[0]?.invalidate?.();
		}
	}

	renderCall(
		name: string,
		args: any,
		theme: any,
		context: ToolRenderContext,
	): Component {
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		if (record.group && record.group.records.length > 1) {
			if (record.group.records[0] !== record) return new Text("", 0, 0);
			return new Text(formatGroup(record.group, theme), 0, 0);
		}
		return new Text(
			theme.fg("muted", BULLET) + formatCallBody(name, args, theme),
			0,
			0,
		);
	}

	renderResult(
		name: string,
		args: any,
		result: any,
		options: ToolRenderResultOptions,
		theme: any,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		this.setResult(record, result, context.isError);
		if (record.group && record.group.records.length > 1) {
			if (record.group.records[0] !== record) return new Text("", 0, 0);
			const error = errorText(result, context.isError);
			return error ? new Text(theme.fg("error", error), 0, 0) : new Text("", 0, 0);
		}
		if (options.isPartial) return new Text("", 0, 0);

		const error = errorText(result, context.isError);
		if (error) return new Text(theme.fg("error", error), 0, 0);
		if (name === "edit") {
			const { additions, removals } = diffStats(result);
			return new Text(
				theme.fg("success", `+${additions}`) +
					theme.fg("dim", " / ") +
					theme.fg("error", `-${removals}`),
				0,
				0,
			);
		}
		if (name === "bash") return new Text(theme.fg("success", "Done"), 0, 0);
		if (name === "write") return new Text(theme.fg("success", "Written"), 0, 0);
		return new Text("", 0, 0);
	}
}

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

export default function piCompactToolsPlugin(pi: ExtensionAPI): void {
	const renderer = new CompactRenderer();
	pi.on("turn_start", () => renderer.beginTurn());
	pi.on("tool_call", (event: any) => {
		if (TOOL_FACTORIES[event.toolName]) {
			renderer.observeCall(event.toolName, event.toolCallId, event.input);
		}
	});
	for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
		registerCompactTool(pi, name, factory, renderer);
	}
}
