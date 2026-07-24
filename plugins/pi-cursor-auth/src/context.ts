import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import { prepare_todo_arguments } from "../../pi-ember-todo/normalize.ts";

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PI_TO_CURSOR_TOOL_NAME = new Map<string, string>([
	["bash", "Shell"],
	["read", "Read"],
	["write", "Write"],
	["edit", "Edit"],
	["ls", "LS"],
	["grep", "Grep"],
	["find", "Glob"],
	["todo", "todo"],
	["apply_patch", "apply_patch"],
	["subagent", "subagent"],
	["quiz", "quiz"],
	["task", "task"],
	["web_search", "web_search"],
	["fetch_content", "fetch_content"],
	["get_search_content", "get_search_content"],
	["compress", "compress"],
]);

const PI_TO_CURSOR_ARG_NAMES: Record<string, Record<string, string>> = {
	read: { path: "file_path" },
	write: { path: "file_path" },
	edit: { path: "file_path", oldText: "old_string", newText: "new_string" },
	ls: { path: "path" },
	grep: { pattern: "pattern", path: "include" },
	find: { pattern: "glob", path: "path" },
	web_search: { query: "search_term" },
	fetch_content: { url: "url" },
	get_search_content: { responseId: "response_id" },
};

const MODE_DIRECTIVES: Record<string, string> = {
	plan: "You are in plan mode. Design your approach before coding. Reply in labeled lines: Task:, Investigation:, Module N:, Acceptance Criteria:. Do not write code until the plan is approved.",
	code: "You are in code mode. Implement the task directly. Prefer parallel read and edit calls for independent files. Explain briefly after changes.",
	debug: "You are in debug mode. Investigate the root cause, then fix it. Use read and bash to gather evidence. Prefer parallel independent reads.",
	orchestrate: "You are in orchestrate mode. Break the task into independent subtasks, delegate where possible, and synthesize results. Prefer parallel tool calls.",
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

export function cursor_tool_name_for_pi_tool(pi_tool_name: string): string {
	return PI_TO_CURSOR_TOOL_NAME.get(pi_tool_name) ?? pi_tool_name;
}

export function cursor_serialize_tool(tool: Tool): Record<string, unknown> {
	const cursor_name = cursor_tool_name_for_pi_tool(tool.name);
	const cursor_params = remap_tool_schema(tool.name, tool.parameters);
	return {
		name: cursor_name,
		description: tool.description,
		parameters: cursor_params,
	};
}

function user_message_is_visible(message: Message): boolean {
	return (message as { display?: boolean }).display !== false;
}

/** Hidden Pi injections that must never be forwarded as the user's ask. */
export function is_non_ask_user_message(message: Message): boolean {
	const custom_type = (message as { customType?: string }).customType;
	if (custom_type?.startsWith("pi-agents-enter-")) return true;
	if (custom_type === "pi-agents-exit") return true;
	if (custom_type === "pi-agents-tool-access") return true;
	if (custom_type === "pi-agents-auto-continue") return true;
	if (custom_type === "pi-agents-loop-retry") return true;
	if (custom_type === "pi-agents-loop-guidance") return true;
	if (custom_type === "pi-agents-plan-implement") return true;

	const text = extract_user_message_text(message)?.trim();
	if (!text) return false;
	if (/^Entered .+ mode\.$/.test(text)) return true;
	if (/^Exited .+ mode\.$/.test(text)) return true;
	return false;
}

export function is_forwardable_user_ask(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (/^Entered .+ mode\.$/.test(trimmed)) return false;
	if (/^Exited .+ mode\.$/.test(trimmed)) return false;
	return true;
}

export function extract_user_message_text(message: Message): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") {
		const text = message.content.trim();
		return text ? message.content : undefined;
	}
	const parts = message.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "image") return `[image/${part.mimeType || "unknown"}]`;
			return "";
		})
		.join("");
	return parts.trim() ? parts : undefined;
}

/** Walk history for the latest real user ask; visible rows win over hidden injections. */
function last_user_text(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!user_message_is_visible(message) || is_non_ask_user_message(message)) continue;
		const text = extract_user_message_text(message);
		if (text) return text;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (is_non_ask_user_message(message)) continue;
		const text = extract_user_message_text(message);
		if (text) return text;
	}
	return "";
}

function build_mode_directive(pi_mode: string | undefined): string {
	const mode = pi_mode ?? "code";
	return MODE_DIRECTIVES[mode] ?? MODE_DIRECTIVES.code;
}

/** True when the Pi context tip has a non-empty user message. */
export function cursor_context_has_user_text(
	context: Context,
	explicit_user_text?: string,
): boolean {
	return resolve_cursor_user_text(context, explicit_user_text).length > 0;
}

/** Latest user ask: explicit before_agent_start prompt, then visible context rows. */
export function resolve_cursor_user_text(context: Context, explicit_user_text?: string): string {
	const explicit = explicit_user_text?.trim();
	if (explicit && is_forwardable_user_ask(explicit)) return explicit;
	return last_user_text(context.messages).trim();
}

export function build_cursor_user_prompt(
	context: Context,
	pi_mode: string | undefined,
	include_mode_directive = true,
	explicit_user_text?: string,
): string {
	const user_text = resolve_cursor_user_text(context, explicit_user_text);
	if (!include_mode_directive) return user_text;
	const directive = build_mode_directive(pi_mode);
	if (!user_text) return directive;
	return `${directive}\n\n${user_text}`;
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
	["searchreplace", "edit"],
	["listdirectory", "ls"],
	["listfiles", "ls"],
	["listdir", "ls"],
	["searchfiles", "grep"],
	["filepathsearch", "grep"],
	["grep", "grep"],
	["findfiles", "find"],
	["glob", "find"],
	["globfilesearch", "find"],
	["applypatch", "apply_patch"],
	["edittoreplace", "edit"],
	["updatetodos", "todo"],
	["readtodos", "todo"],
	["websearch", "web_search"],
	["websearchtoolcall", "web_search"],
	["fetchtoolcall", "fetch_content"],
	["exafetchtoolcall", "fetch_content"],
	["askquestion", "quiz"],
	["askquestiontoolcall", "quiz"],
	["tasktoolcall", "subagent"],
]);

/** Canonical Pi tool ids Cursor can map to without a live Pi tool registry. */
const CANONICAL_PI_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"apply_patch",
	"task",
	"subagent",
	"todo",
]);

export function resolve_pi_tool_name(raw_name: string, tools: readonly Tool[] = []): string | undefined {
	const exact = tools.find((tool) => tool.name === raw_name);
	if (exact) return exact.name;

	const normalized = normalized_tool_name(raw_name);
	const normalized_match = tools.find((tool) => normalized_tool_name(tool.name) === normalized);
	if (normalized_match) return normalized_match.name;

	const aliased = TOOL_ALIASES.get(normalized) ?? normalized;
	const alias_match = tools.find(
		(tool) => normalized_tool_name(tool.name) === normalized_tool_name(aliased),
	);
	if (alias_match) return alias_match.name;

	// Cursor owns its tool loop — Pi's context.tools is often empty. Still map
	// known Cursor names onto Pi compact-tool ids so grouping/labels stay SSOT.
	if (TOOL_ALIASES.has(normalized)) return TOOL_ALIASES.get(normalized);
	if (CANONICAL_PI_TOOLS.has(aliased)) return aliased;
	return undefined;
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
			content: first_defined(input, ["content", "contents", "fileText"]),
		};
	}
	if (tool_name === "edit") {
		let edits: unknown[] | undefined;
		if (Array.isArray(input.edits)) {
			edits = input.edits;
		} else if (is_record(input.strReplace)) {
			const sr = input.strReplace;
			edits = [
				{
					oldText: first_defined(sr, ["oldText", "oldString", "old_string"]),
					newText: first_defined(sr, ["newText", "newString", "new_string"]),
				},
			];
		} else if (is_record(input.multiStrReplace)) {
			const msr = input.multiStrReplace;
			if (Array.isArray(msr.edits)) edits = msr.edits;
		}
		if (!edits) {
			edits = [
				{
					oldText: first_defined(input, ["oldText", "oldString", "old_string"]),
					newText: first_defined(input, ["newText", "newString", "new_string"]),
				},
			];
		}
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
	if (tool_name === "todo") {
		// Provider-native batch shapes (Cursor UpdateTodos, etc.) must be flattened
		// before Pi's schema validation strips unknown keys like `todos`.
		return prepare_todo_arguments(input) as Record<string, unknown>;
	}
	return input;
}

export const __test_only = {
	build_mode_directive,
	extract_user_message_text,
	is_forwardable_user_ask,
	is_non_ask_user_message,
	last_user_text,
	user_message_is_visible,
};
