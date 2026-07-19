import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export interface SerializedContent {
	type: "text" | "image" | "thinking" | "toolCall";
	text?: string;
	image_url?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface SerializedMessage {
	role: Message["role"];
	content: SerializedContent[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

const REQUEST_PREAMBLE = [
	"This is a serialized model API request.",
	"Treat systemPrompt as the system message, messages as ordered conversation history, and tools as callable function schemas.",
	"When calling a tool, use its exact listed name and arguments. Never call a tool that is absent from tools.",
	"Respond only to the final conversation state.",
].join(" ");

function text_from_user_content(message: Extract<Message, { role: "user" }>): SerializedContent[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((content) => {
		if (content.type === "image") {
			return { type: "image", image_url: `data:${content.mimeType};base64,${content.data}` };
		}
		return { type: "text", text: content.text };
	});
}

function serialize_message(message: Message): SerializedMessage {
	if (message.role === "user") {
		return { role: message.role, content: text_from_user_content(message) };
	}

	if (message.role === "toolResult") {
		const content = message.content.map((part): SerializedContent => {
			if (part.type === "image") {
				return { type: "image", image_url: `data:${part.mimeType};base64,${part.data}` };
			}
			return { type: "text", text: part.text };
		});
		return {
			role: message.role,
			content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}

	return {
		role: message.role,
		content: message.content.map((part): SerializedContent => {
			if (part.type === "text") return { type: "text", text: part.text };
			if (part.type === "thinking") return { type: "thinking", thinking: part.thinking };
			return {
				type: "toolCall",
				id: part.id,
				name: part.name,
				arguments: part.arguments,
			};
		}),
	};
}

function serialize_tool(tool: Tool): Record<string, unknown> {
	const cursor_name = PI_TO_CURSOR_TOOL_NAME.get(tool.name) ?? tool.name;
	const cursor_params = remap_tool_schema(tool.name, tool.parameters);
	return {
		name: cursor_name,
		description: tool.description,
		parameters: cursor_params,
	};
}

const PI_TO_CURSOR_TOOL_NAME = new Map<string, string>([
	["bash", "Shell"],
	["read", "Read"],
	["write", "Write"],
	["edit", "Edit"],
	["ls", "LS"],
	["grep", "Grep"],
	["find", "Glob"],
]);

const PI_TO_CURSOR_ARG_NAMES: Record<string, Record<string, string>> = {
	read: { path: "file_path" },
	write: { path: "file_path" },
	edit: { path: "file_path", oldText: "old_string", newText: "new_string" },
	ls: { path: "path" },
	grep: { pattern: "pattern", path: "include" },
	find: { pattern: "glob", path: "path" },
};

function remap_property_names(schema: unknown, pi_tool_name: string): unknown {
	if (typeof schema !== "object" || schema === null) return schema;
	const obj = schema as Record<string, unknown>;
	if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
		const arg_map = PI_TO_CURSOR_ARG_NAMES[pi_tool_name];
		const props = obj.properties as Record<string, unknown>;
		const remapped: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(props)) {
			const cursor_key = arg_map?.[key] ?? key;
			remapped[cursor_key] = value;
		}
		const result: Record<string, unknown> = { ...obj, properties: remapped };
		if (Array.isArray(obj.required)) {
			result.required = (obj.required as string[]).map((key) => arg_map?.[key] ?? key);
		}
		return result;
	}
	return obj;
}

function remap_tool_schema(pi_tool_name: string, parameters: unknown): unknown {
	return remap_property_names(parameters, pi_tool_name);
}

export function build_cursor_prompt(context: Context): string {
	const request = {
		systemPrompt: context.systemPrompt || "",
		messages: context.messages.map(serialize_message),
		tools: (context.tools || []).map(serialize_tool),
	};
	return `${REQUEST_PREAMBLE}\n<pi_model_request>\n${JSON.stringify(request)}\n</pi_model_request>`;
}

function normalized_tool_name(value: string): string {
	return value
		.toLowerCase()
		.replace(/toolcall$/i, "")
		.replace(/[^a-z0-9]/g, "");
}

const TOOL_ALIASES = new Map<string, string>([
	["shell", "bash"],
	["shellcommand", "bash"],
	["runcommand", "bash"],
	["readfile", "read"],
	["writefile", "write"],
	["strreplace", "edit"],
	["listdirectory", "ls"],
	["listfiles", "ls"],
	["searchfiles", "grep"],
	["findfiles", "find"],
	["glob", "find"],
]);

export function resolve_pi_tool_name(raw_name: string, tools: readonly Tool[]): string | undefined {
	const exact = tools.find((tool) => tool.name === raw_name);
	if (exact) return exact.name;

	const normalized = normalized_tool_name(raw_name);
	const normalized_match = tools.find((tool) => normalized_tool_name(tool.name) === normalized);
	if (normalized_match) return normalized_match.name;

	const alias = TOOL_ALIASES.get(normalized) || normalized;
	return tools.find((tool) => normalized_tool_name(tool.name) === normalized_tool_name(alias))
		?.name;
}

function first_defined(input: Record<string, unknown>, names: readonly string[]): unknown {
	for (const name of names) {
		if (input[name] !== undefined) return input[name];
	}
	return undefined;
}

export function normalize_tool_arguments(
	tool_name: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (tool_name === "bash") {
		const output: Record<string, unknown> = {
			command: first_defined(input, ["command", "cmd", "script"]),
		};
		if (input.timeout !== undefined) output.timeout = input.timeout;
		return output;
	}
	if (tool_name === "read") {
		const output: Record<string, unknown> = {
			path: first_defined(input, ["path", "filePath", "file_path"]),
		};
		if (input.offset !== undefined) output.offset = input.offset;
		if (input.limit !== undefined) output.limit = input.limit;
		return output;
	}
	if (tool_name === "write") {
		return {
			path: first_defined(input, ["path", "filePath", "file_path"]),
			content: first_defined(input, ["content", "contents"]),
		};
	}
	if (tool_name === "edit") {
		const edits = Array.isArray(input.edits)
			? input.edits
			: [
					{
						oldText: first_defined(input, ["oldText", "oldString", "old_string"]),
						newText: first_defined(input, ["newText", "newString", "new_string"]),
					},
				];
		return {
			path: first_defined(input, ["path", "filePath", "file_path"]),
			edits,
		};
	}
	if (tool_name === "ls") {
		const output: Record<string, unknown> = {};
		const path = first_defined(input, ["path", "directory", "dir"]);
		if (path !== undefined) output.path = path;
		if (input.limit !== undefined) output.limit = input.limit;
		return output;
	}
	if (tool_name === "grep") {
		const output: Record<string, unknown> = {
			pattern: first_defined(input, ["pattern", "query", "regex", "substring", "value"]),
		};
		const path = first_defined(input, [
			"path",
			"include",
			"glob",
			"glob_filter",
			"directory",
			"dir",
		]);
		if (path !== undefined) output.path = path as string;
		if (input.exclude !== undefined) output.exclude = input.exclude;
		if (input.caseSensitive !== undefined) output.caseSensitive = input.caseSensitive;
		if (input.context !== undefined) output.context = input.context;
		if (input.limit !== undefined) output.limit = input.limit;
		return output;
	}
	if (tool_name === "find") {
		const output: Record<string, unknown> = {};
		const pattern = first_defined(input, [
			"pattern",
			"glob",
			"glob_pattern",
			"globPattern",
			"query",
		]);
		if (pattern !== undefined) output.pattern = pattern as string;
		const path = first_defined(input, [
			"path",
			"directory",
			"dir",
			"folder",
			"file_path",
			"filePath",
		]);
		if (path !== undefined) output.path = path as string;
		if (input.exclude !== undefined) output.exclude = input.exclude;
		if (input.limit !== undefined) output.limit = input.limit;
		return output;
	}
	return input;
}

export const __test_only = { REQUEST_PREAMBLE };
