import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	FindOperations,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Type } from "typebox";
import { resolveXaiAuthToken } from "../auth.js";
import { DEFAULT_XAI_MODEL, XAI_CURSOR_TOOL_NAMES, XAI_PROVIDER_ID } from "../constants.js";
import { isGrokCliProxyModel } from "../models.js";
import { createXaiResponse } from "../responses.js";
import { extractResponsesText, messageFromError, statusFromError } from "../text.js";
import { xaiToolError } from "./common.js";
import {
	firstString,
	normalizeDeleteArgs,
	normalizeEditArgs,
	normalizeGlobArgs,
	normalizeGrepArgs,
	normalizeLsArgs,
	normalizeReadArgs,
	normalizeShellArgs,
	normalizeWriteArgs,
	objectFromCursorArgs,
	safeWorkspacePath,
} from "./cursor-args.js";

const DEFAULT_CURSOR_GLOB_LIMIT = 1000;
const DEFAULT_CURSOR_GREP_LIMIT = 1000;
const MAX_CURSOR_REGEX_LENGTH = 500;
const MAX_CURSOR_GREP_CONTEXT_LINES = 20;
const SKIPPED_SEARCH_DIRS = new Set([".git", ".omp", "node_modules"]);

const readShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to read" })),
	file_path: Type.Optional(Type.String({ description: "Cursor-style alias for path" })),
	offset: Type.Optional(Type.Number({ description: "1-indexed line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});

const writeShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to write" })),
	file_path: Type.Optional(Type.String({ description: "Cursor-style alias for path" })),
	content: Type.Optional(Type.String({ description: "Content to write" })),
	contents: Type.Optional(Type.String({ description: "Cursor-style alias for content" })),
});

const strReplaceShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to edit" })),
	file_path: Type.Optional(Type.String({ description: "Cursor-style alias for path" })),
	old_string: Type.Optional(Type.String({ description: "Text to replace" })),
	new_string: Type.Optional(Type.String({ description: "Replacement text" })),
	oldText: Type.Optional(Type.String({ description: "pi-style alias for old_string" })),
	newText: Type.Optional(Type.String({ description: "pi-style alias for new_string" })),
});

const editShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to edit" })),
	file_path: Type.Optional(Type.String({ description: "Cursor-style alias for path" })),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.Optional(Type.String()),
				old_string: Type.Optional(Type.String()),
				newText: Type.Optional(Type.String()),
				new_string: Type.Optional(Type.String()),
			}),
			{ description: "Array of { oldText/old_string, newText/new_string } replacements" },
		),
	),
	old_string: Type.Optional(Type.String({ description: "Text to replace" })),
	new_string: Type.Optional(Type.String({ description: "Replacement text" })),
});

const deleteShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to delete" })),
	file_path: Type.Optional(Type.String({ description: "Cursor-style alias for path" })),
	recursive: Type.Optional(Type.Boolean({ description: "Allow recursive directory deletion" })),
});

const lsShimSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory or file path" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return" })),
});

const grepShimSchema = Type.Object({
	pattern: Type.String({
		description:
			"REQUIRED search text (regex or literal). This is the string to find in files — not a file glob.",
	}),
	query: Type.Optional(
		Type.String({
			description: "Alias for pattern (Cursor/Grok CLI style). Mapped to pattern before execution.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	include: Type.Optional(
		Type.String({
			description: "Glob filter for which files to search, e.g. *.ts (NOT the search text)",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: "Glob filter for which files to search, e.g. *.ts (NOT the search text)",
		}),
	),
	glob_filter: Type.Optional(Type.String({ description: "Cursor-style alias for glob" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as a literal string instead of regex" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of context lines before/after each match" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
});

const globShimSchema = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Glob pattern, e.g. **/*.ts" })),
	glob: Type.Optional(Type.String({ description: "Cursor-style alias for pattern" })),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
});

const shellShimSchema = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command to execute" })),
	cmd: Type.Optional(Type.String({ description: "Alias for command" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
});

const webSearchShimSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query" })),
	search_term: Type.Optional(Type.String({ description: "Alias for query" })),
});

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function escapeRegExpChar(char: string): string {
	return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index += 1;
				if (pattern[index + 1] === "/") {
					index += 1;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegExpChar(char);
		}
	}
	return new RegExp(`^${source}$`);
}

function globMatches(pattern: string | undefined, relativePath: string): boolean {
	const normalizedPattern = toPosixPath(pattern || "**/*");
	const normalizedPath = toPosixPath(relativePath);
	const matchTarget = normalizedPattern.includes("/")
		? normalizedPath
		: normalizedPath.split("/").pop() || normalizedPath;
	return globToRegExp(normalizedPattern).test(matchTarget);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function isRegexQuantifierStart(char: string | undefined): boolean {
	return char === "*" || char === "+" || char === "?" || char === "{";
}

function hasUnsafeRegexStructure(pattern: string): boolean {
	let inCharacterClass = false;
	const groupStack: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = [];

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "\\") {
			if (/\d/.test(pattern[index + 1] || "")) return true;
			index += 1;
			continue;
		}
		if (inCharacterClass) {
			if (char === "]") inCharacterClass = false;
			continue;
		}
		if (char === "[") {
			inCharacterClass = true;
			continue;
		}
		if (char === "(") {
			groupStack.push({ hasQuantifier: false, hasAlternation: false });
			continue;
		}
		if (char === "|") {
			const current = groupStack[groupStack.length - 1];
			if (current) current.hasAlternation = true;
			continue;
		}
		if (char === ")") {
			const group = groupStack.pop();
			if (
				group &&
				(group.hasQuantifier || group.hasAlternation) &&
				isRegexQuantifierStart(pattern[index + 1])
			) {
				return true;
			}
			continue;
		}
		if (isRegexQuantifierStart(char)) {
			const current = groupStack[groupStack.length - 1];
			if (current) current.hasQuantifier = true;
		}
	}

	return false;
}

function createSafeRegexMatcher(pattern: string, ignoreCase: boolean): RegExp {
	if (pattern.length > MAX_CURSOR_REGEX_LENGTH) {
		throw new Error(
			`Regex pattern exceeds maximum length of ${MAX_CURSOR_REGEX_LENGTH} characters`,
		);
	}
	if (hasUnsafeRegexStructure(pattern)) {
		throw new Error(
			"Unsafe regex pattern: nested quantifiers, quantified alternation, and backreferences are not supported",
		);
	}
	try {
		return new RegExp(pattern, ignoreCase ? "i" : undefined);
	} catch (error) {
		throw new Error(
			`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function pathExists(absolutePath: string): Promise<boolean> {
	try {
		await stat(absolutePath);
		return true;
	} catch {
		return false;
	}
}

async function localGlob(
	pattern: string,
	searchPath: string,
	options: { ignore: string[]; limit: number },
): Promise<string[]> {
	const results: string[] = [];
	const limit = Math.max(1, options.limit || DEFAULT_CURSOR_GLOB_LIMIT);

	async function visit(directory: string): Promise<void> {
		if (results.length >= limit) return;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (results.length >= limit) return;
			if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolutePath);
			} else if (entry.isFile()) {
				const relativePath = toPosixPath(relative(searchPath, absolutePath));
				if (globMatches(pattern, relativePath)) results.push(absolutePath);
			}
		}
	}

	await visit(searchPath);
	return results;
}

const localFindOperations: FindOperations = {
	exists: pathExists,
	glob: localGlob,
};

async function collectLocalFiles(
	searchPath: string,
	rootPath: string,
	globPattern: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	throwIfAborted(signal);
	const info = await stat(searchPath);
	if (info.isFile()) return [searchPath];
	if (!info.isDirectory()) return [];

	const files: string[] = [];
	async function visit(directory: string): Promise<void> {
		throwIfAborted(signal);
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			throwIfAborted(signal);
			if (entry.isDirectory() && SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolutePath);
			} else if (entry.isFile()) {
				const relativePath = toPosixPath(relative(rootPath, absolutePath));
				if (!globPattern || globMatches(globPattern, relativePath)) files.push(absolutePath);
			}
		}
	}

	await visit(searchPath);
	return files;
}

type GrepDetails = { matchLimitReached?: number } | undefined;

async function runLocalGrep(
	cwd: string,
	params: ReturnType<typeof normalizeGrepArgs>,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GrepDetails>> {
	throwIfAborted(signal);
	const searchPath = safeWorkspacePath(cwd, params.path || ".");
	const searchInfo = await stat(searchPath).catch(() => undefined);
	if (!searchInfo) throw new Error(`Path not found: ${searchPath}`);

	const pattern = params.pattern || "";
	if (!pattern) {
		throw new Error("Grep requires a non-empty pattern (or query alias)");
	}

	const ignoreCase = !!params.ignoreCase;
	const literalPattern = ignoreCase ? pattern.toLowerCase() : pattern;
	const matcher = params.literal ? undefined : createSafeRegexMatcher(pattern, ignoreCase);
	const limit = Math.max(1, params.limit || DEFAULT_CURSOR_GREP_LIMIT);
	const contextLines = Math.min(
		MAX_CURSOR_GREP_CONTEXT_LINES,
		Math.max(0, Math.floor(params.context || 0)),
	);
	const files = await collectLocalFiles(searchPath, searchPath, params.glob, signal);
	const outputLines: string[] = [];
	let matchCount = 0;
	let limitReached = false;

	for (const filePath of files) {
		if (matchCount >= limit) {
			limitReached = true;
			break;
		}
		const content = await readFile(filePath, "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const displayPath = searchInfo.isDirectory()
			? toPosixPath(relative(searchPath, filePath))
			: toPosixPath(relative(cwd, filePath));
		const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			throwIfAborted(signal);
			const line = lines[index];
			const matched = params.literal
				? (ignoreCase ? line.toLowerCase() : line).includes(literalPattern)
				: matcher!.test(line);
			if (!matched) continue;

			const start = Math.max(0, index - contextLines);
			const end = Math.min(lines.length - 1, index + contextLines);
			for (let current = start; current <= end; current += 1) {
				const isMatchLine = current === index;
				const separator = isMatchLine ? ":" : "-";
				outputLines.push(`${displayPath}${separator}${current + 1}${separator} ${lines[current]}`);
			}

			matchCount++;
			if (matchCount >= limit) {
				limitReached = true;
				break;
			}
		}
	}

	if (matchCount === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	let text = outputLines.join("\n");
	const details: GrepDetails = limitReached ? { matchLimitReached: limit } : undefined;
	if (limitReached) {
		text += `\n\n[${limit} matches limit reached]`;
	}

	return {
		content: [{ type: "text", text }],
		details,
	};
}

function uniqueToolNames(toolNames: string[]): string[] {
	return [...new Set(toolNames)];
}

type ToolApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/** Enable Cursor/Grok CLI shims only for Grok CLI proxy models. */
export function syncCursorToolShimsForModel(api: ToolApi, model?: Model<Api>): void {
	if (typeof api?.getActiveTools !== "function" || typeof api?.setActiveTools !== "function")
		return;

	let activeTools: string[];
	try {
		const current = api.getActiveTools();
		activeTools = Array.isArray(current) ? (current as string[]) : [];
	} catch {
		return;
	}
	const withoutCursorShims = activeTools.filter(
		(toolName) =>
			!XAI_CURSOR_TOOL_NAMES.includes(toolName as (typeof XAI_CURSOR_TOOL_NAMES)[number]),
	);
	const shouldEnableCursorShims =
		model?.provider === XAI_PROVIDER_ID && isGrokCliProxyModel(model.id);
	const nextTools = shouldEnableCursorShims
		? uniqueToolNames([...withoutCursorShims, ...XAI_CURSOR_TOOL_NAMES])
		: withoutCursorShims;

	if (
		nextTools.length !== activeTools.length ||
		nextTools.some((toolName, index) => toolName !== activeTools[index])
	) {
		try {
			api.setActiveTools(nextTools);
		} catch {
			// Ignore transient registry failures; a later synchronization will retry.
		}
	}
}

type ExecuteCtx = ExtensionContext;
type ExecuteSignal = AbortSignal | undefined;
type ExecuteOnUpdate<T> = AgentToolUpdateCallback<T> | undefined;

/** Register Cursor/Grok CLI compatibility shims. */
export function registerCursorToolShims(pi: ExtensionAPI): void {
	const readTool: ToolDefinition<typeof readShimSchema, undefined> = {
		name: "Read",
		label: "Read",
		description:
			"Cursor/Grok CLI compatibility shim for pi's read tool. Reads a file by path/file_path with optional offset and limit.",
		promptSnippet: "Cursor-style alias for read; accepts path/file_path plus optional offset/limit",
		parameters: readShimSchema,
		prepareArguments: normalizeReadArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createReadToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeReadArgs(_params) as Parameters<
					ReturnType<typeof createReadToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(readTool);

	const writeTool: ToolDefinition<typeof writeShimSchema, undefined> = {
		name: "Write",
		label: "Write",
		description:
			"Cursor/Grok CLI compatibility shim for pi's write tool. Writes content/contents to path/file_path.",
		promptSnippet: "Cursor-style alias for write; accepts path/file_path and content/contents",
		parameters: writeShimSchema,
		prepareArguments: normalizeWriteArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createWriteToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeWriteArgs(_params) as Parameters<
					ReturnType<typeof createWriteToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(writeTool);

	const strReplaceTool: ToolDefinition<typeof strReplaceShimSchema, undefined> = {
		name: "StrReplace",
		label: "StrReplace",
		description:
			"Cursor/Grok CLI compatibility shim for exact string replacement. Accepts old_string/new_string or oldText/newText.",
		promptSnippet: "Cursor-style exact string replacement; accepts old_string/new_string",
		parameters: strReplaceShimSchema,
		prepareArguments: normalizeEditArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createEditToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeEditArgs(_params) as Parameters<
					ReturnType<typeof createEditToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(strReplaceTool);

	const editTool: ToolDefinition<typeof editShimSchema, undefined> = {
		name: "Edit",
		label: "Edit",
		description:
			"Cursor/Grok CLI compatibility shim for pi's edit tool. Accepts edits or old_string/new_string aliases.",
		promptSnippet: "Cursor-style alias for edit; accepts edits or old_string/new_string",
		parameters: editShimSchema,
		prepareArguments: normalizeEditArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createEditToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeEditArgs(_params) as Parameters<
					ReturnType<typeof createEditToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(editTool);

	const deleteTool: ToolDefinition<typeof deleteShimSchema, undefined> = {
		name: "Delete",
		label: "Delete",
		description:
			"Cursor/Grok CLI compatibility shim for deleting a workspace file. Directories require recursive=true.",
		promptSnippet: "Cursor-style delete for workspace files; directories require recursive=true",
		parameters: deleteShimSchema,
		prepareArguments: normalizeDeleteArgs,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			const { path, recursive } = normalizeDeleteArgs(params);
			if (!path) throw new Error("Delete requires a path");
			const absolutePath = safeWorkspacePath(ctx.cwd, path);
			await rm(absolutePath, { recursive: !!recursive, force: false });
			return { content: [{ type: "text" as const, text: `Deleted ${path}` }], details: undefined };
		},
	};
	pi.registerTool(deleteTool);

	const lsTool: ToolDefinition<typeof lsShimSchema, undefined> = {
		name: "LS",
		label: "LS",
		description: "Cursor/Grok CLI compatibility shim for pi's ls tool. Lists files under path.",
		promptSnippet: "Cursor-style alias for ls; lists files under path",
		parameters: lsShimSchema,
		prepareArguments: normalizeLsArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createLsToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeLsArgs(_params) as Parameters<
					ReturnType<typeof createLsToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(lsTool);

	const grepTool: ToolDefinition<typeof grepShimSchema, GrepDetails> = {
		name: "Grep",
		label: "Grep",
		description:
			"Search file contents for a required pattern (search regex/string). query is an optional alias for pattern. include/glob only filter which files are searched — they are not the search text.",
		promptSnippet:
			"Search file contents; requires pattern (query alias ok); optional include/glob file filters",
		parameters: grepShimSchema,
		prepareArguments: normalizeGrepArgs,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return runLocalGrep(ctx.cwd, normalizeGrepArgs(params), signal);
		},
	};
	pi.registerTool(grepTool);

	const globTool: ToolDefinition<typeof globShimSchema, undefined> = {
		name: "Glob",
		label: "Glob",
		description:
			"Cursor/Grok CLI compatibility shim for pi's find tool. Finds files matching pattern/glob.",
		promptSnippet: "Cursor-style alias for find; accepts pattern/glob",
		parameters: globShimSchema,
		prepareArguments: normalizeGlobArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createFindToolDefinition(ctx.cwd, { operations: localFindOperations }).execute(
				toolCallId,
				normalizeGlobArgs(_params) as Parameters<
					ReturnType<typeof createFindToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(globTool);

	const shellTool: ToolDefinition<typeof shellShimSchema, undefined> = {
		name: "Shell",
		label: "Shell",
		description:
			"Cursor/Grok CLI compatibility shim for pi's bash tool. Executes command/cmd in the workspace shell.",
		promptSnippet: "Cursor-style alias for bash; executes command/cmd in the workspace shell",
		parameters: shellShimSchema,
		prepareArguments: normalizeShellArgs,
		execute: async (toolCallId, _params, signal, onUpdate, ctx) => {
			return createBashToolDefinition(ctx.cwd).execute(
				toolCallId,
				normalizeShellArgs(_params) as Parameters<
					ReturnType<typeof createBashToolDefinition>["execute"]
				>[1],
				signal,
				onUpdate as ExecuteOnUpdate<unknown>,
				ctx,
			) as Promise<AgentToolResult<undefined>>;
		},
	};
	pi.registerTool(shellTool);

	type WebSearchDetails = { response_id?: string; error?: boolean; status?: number } | undefined;

	const webSearchTool: ToolDefinition<typeof webSearchShimSchema, WebSearchDetails> = {
		name: "WebSearch",
		label: "WebSearch",
		description:
			"Cursor/Grok CLI compatibility shim for xAI web search. Searches the web with xAI's native web_search tool.",
		promptSnippet: "Cursor-style web search backed by xAI native web_search",
		parameters: webSearchShimSchema,
		prepareArguments: (args: unknown) => {
			const params = objectFromCursorArgs(args);
			return { query: firstString(params.query, params.search_term, params.value) || "" };
		},
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExecuteCtx) => {
			const query = firstString(params?.query, params?.search_term);
			if (!query) return xaiToolError<WebSearchDetails>("Error: WebSearch requires a query.");
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey)
				return xaiToolError<WebSearchDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
				);

			try {
				const data = await createXaiResponse(
					apiKey,
					{
						model: DEFAULT_XAI_MODEL,
						input: `Search the web for: ${query}\n\nSummarize the key results with sources where available.`,
						tools: [{ type: "web_search", enable_image_understanding: true }],
					},
					signal,
				);
				return {
					content: [{ type: "text" as const, text: extractResponsesText(data) }],
					details: { response_id: (data as { id?: string })?.id },
				};
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<WebSearchDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status },
				);
			}
		},
	};
	pi.registerTool(webSearchTool);
}
