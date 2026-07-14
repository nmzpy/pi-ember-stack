/**
 * pi-ember-fff: Ember-owned FFF-powered file search extension for pi.
 *
 * Forked from @ff-labs/pi-fff 0.9.6 (MIT, Copyright (c) Dmitry Kovalenko).
 * Always registers canonical `grep` and `find` tool names (override mode),
 * and delegates rendering to the shared Ember compact renderer from
 * @nmzpy/pi-ember-stack so the TUI stays consistent across all tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type {
	GrepCursor,
	GrepMode,
	GrepResult,
	MixedItem,
	SearchResult,
} from "@ff-labs/fff-node";
import { FileFinder } from "@ff-labs/fff-node";
import { Type } from "@sinclair/typebox";
import {
	buildExternalAllowlist,
	buildQuery,
	resolveExternalTarget,
	type ExternalAllowlist,
	type ExternalTarget,
} from "./query.ts";
import { getSharedRenderer, bashGrepInfo } from "../pi-compact-tools/index.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_MAX_LINE_LENGTH = 500;
const MENTION_MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

interface CachedGrepCursor {
	cursor: GrepCursor;
	externalDir?: string;
}

const cursorCache = new Map<string, CachedGrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor, externalDir?: string): string {
	const id = `fff_c${++cursorCounter}`;
	cursorCache.set(id, { cursor, externalDir });
	if (cursorCache.size > 200) {
		const first = cursorCache.keys().next().value;
		if (first) cursorCache.delete(first);
	}
	return id;
}

function getCursor(id: string): CachedGrepCursor | undefined {
	return cursorCache.get(id);
}

interface FindCursor {
	query: string;
	pattern: string;
	pageSize: number;
	nextPageIndex: number;
	externalDir?: string;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

function storeFindCursor(cursor: FindCursor): string {
	const id = `${++findCursorCounter}`;
	findCursorCache.set(id, cursor);
	if (findCursorCache.size > 200) {
		const first = findCursorCache.keys().next().value;
		if (first) findCursorCache.delete(first);
	}
	return id;
}

function getFindCursor(id: string): FindCursor | undefined {
	return findCursorCache.get(id);
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

export function fffFileAnnotation(item: {
	gitStatus?: string;
	totalFrecencyScore?: number;
	accessFrecencyScore?: number;
}): string {
	const git = item.gitStatus;
	if (git && git !== "clean" && git !== "unknown" && git !== "") {
		return `  [${git} in git]`;
	}

	const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
	if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
	if (frecency >= WARM_FRECENCY) return "  [often touched file]";

	return "";
}

function formatGrepOutput(result: GrepResult): string {
	if (result.items.length === 0) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of result.items) {
		if (match.relativePath !== currentFile) {
			if (lines.length > 0) lines.push("");
			currentFile = match.relativePath;
			lines.push(`${currentFile}${fffFileAnnotation(match)}`);
		}

		match.contextBefore?.forEach((line: string, i: number) => {
			const lineNum = match.lineNumber - match.contextBefore!.length + i;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});

		lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

		match.contextAfter?.forEach((line: string, i: number) => {
			const lineNum = match.lineNumber + 1 + i;
			lines.push(` ${lineNum}- ${truncateLine(line)}`);
		});
	}

	return lines.join("\n");
}

const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
	const perfect = pattern.length * 12;
	return Math.floor((perfect * 50) / 100);
}

interface FormattedFind {
	output: string;
	weak: boolean;
	shownCount: number;
}

function formatFindOutput(
	result: SearchResult,
	limit: number,
	pattern: string,
): FormattedFind {
	if (result.items.length === 0) {
		return {
			output: "No files found matching pattern",
			weak: false,
			shownCount: 0,
		};
	}

	const reordered = result.items.map((item) => ({ item }));

	const topScore = result.scores[0]?.total ?? 0;
	const weak = topScore < weakScoreThreshold(pattern);
	const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
	const shown = reordered.slice(0, effective);

	return {
		output: shown
			.map((p) => `${p.item.relativePath}${fffFileAnnotation(p.item)}`)
			.join("\n"),
		weak,
		shownCount: shown.length,
	};
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
	getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const currentLine = lines[cursorLine] || "";
			const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
			if (!prefix || options.signal.aborted) return null;

			const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
			const items = await getItems(query, options.signal);
			return options.signal.aborted || items.length === 0 ? null : { items, prefix };
		},
		applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = _lines[cursorLine] || "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol);
			const newLine = before + item.value + after;
			const newCursorCol = cursorCol - prefix.length + item.value.length;
			return {
				lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: newCursorCol,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function emberFffExtension(pi: ExtensionAPI) {
	const renderer = getSharedRenderer();

	let finder: FileFinder | null = null;
	let finderCwd: string | null = null;
	let finderPromise: Promise<FileFinder> | null = null;
	let activeCwd = process.cwd();

	let externalFinder: FileFinder | null = null;
	let externalFinderDir: string | null = null;
	let externalFinderPromise: Promise<FileFinder> | null = null;
	let externalAllowlist: ExternalAllowlist = buildExternalAllowlist();

	const frecencyDbPath =
		(pi.getFlag("fff-frecency-db") as string | undefined) ??
		process.env.FFF_FRECENCY_DB ??
		undefined;
	const historyDbPath =
		(pi.getFlag("fff-history-db") as string | undefined) ??
		process.env.FFF_HISTORY_DB ??
		undefined;

	function resolveBoolOpt(flagName: string, envName: string): boolean {
		const flag = pi.getFlag(flagName);
		if (typeof flag === "boolean") return flag;
		if (typeof flag === "string") return flag === "true" || flag === "1";
		const env = process.env[envName];
		return env === "1" || env === "true";
	}
	const enableFsRootScanning = resolveBoolOpt(
		"fff-enable-root-scan",
		"FFF_ENABLE_ROOT_SCAN",
	);

	const enableExternalAllow = (() => {
		const flag = pi.getFlag("fff-external-allow");
		if (typeof flag === "boolean") return flag;
		if (typeof flag === "string") return flag === "true" || flag === "1";
		const env = process.env.FFF_EXTERNAL_ALLOW;
		if (env !== undefined) return env === "1" || env === "true";
		return true; // default ON
	})();

	function ensureFinder(cwd: string): Promise<FileFinder> {
		if (finder && !finder.isDestroyed && finderCwd === cwd)
			return Promise.resolve(finder);
		if (finderPromise) return finderPromise;

		finderPromise = (async () => {
			if (finder && !finder.isDestroyed) {
				finder.destroy();
				finder = null;
				finderCwd = null;
			}

			const result = FileFinder.create({
				basePath: cwd,
				frecencyDbPath,
				historyDbPath,
				aiMode: true,
				enableHomeDirScanning: true,
				enableFsRootScanning,
			});

			if (!result.ok)
				throw new Error(`Failed to create FFF file finder: ${result.error}`);

			finder = result.value;
			finderCwd = cwd;
			await finder.waitForScan(15000);
			return finder;
		})().finally(() => {
			finderPromise = null;
		});

		return finderPromise;
	}

	function destroyFinder() {
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
			finderCwd = null;
		}
	}

	function ensureExternalFinder(dir: string): Promise<FileFinder> {
		if (externalFinder && !externalFinder.isDestroyed && externalFinderDir === dir)
			return Promise.resolve(externalFinder);
		if (externalFinderPromise) return externalFinderPromise;

		externalFinderPromise = (async () => {
			if (externalFinder && !externalFinder.isDestroyed) {
				externalFinder.destroy();
				externalFinder = null;
				externalFinderDir = null;
			}

			const result = FileFinder.create({
				basePath: dir,
				aiMode: true,
				enableHomeDirScanning: false,
				enableFsRootScanning: false,
			});

			if (!result.ok)
				throw new Error(`Failed to create external FFF file finder: ${result.error}`);

			externalFinder = result.value;
			externalFinderDir = dir;
			await externalFinder.waitForScan(15000);
			return externalFinder;
		})().finally(() => {
			externalFinderPromise = null;
		});

		return externalFinderPromise;
	}

	function destroyExternalFinder() {
		if (externalFinder && !externalFinder.isDestroyed) {
			externalFinder.destroy();
			externalFinder = null;
			externalFinderDir = null;
		}
	}

	/**
	 * If params.path targets an allowlisted external directory, return the
	 * external finder and the query scoped to that dir. Otherwise return
	 * the workspace finder and workspace query.
	 */
	async function resolveFinderAndQuery(
		pathParam: string | undefined,
		pattern: string,
		exclude: string | string[] | undefined,
	): Promise<{ finder: FileFinder; query: string }> {
		if (enableExternalAllow && externalAllowlist.entries.length > 0) {
			const target = resolveExternalTarget(pathParam, externalAllowlist);
			if (target) {
				const f = await ensureExternalFinder(target.entry.dir);
				const query = buildQuery(
					target.relativePath || undefined,
					pattern,
					exclude,
					target.entry.dir,
					externalAllowlist,
				);
				return { finder: f, query };
			}
		}
		const f = await ensureFinder(activeCwd);
		const query = buildQuery(pathParam, pattern, exclude, activeCwd, externalAllowlist);
		return { finder: f, query };
	}

	async function getMentionItems(
		query: string,
		signal: AbortSignal,
	): Promise<AutocompleteItem[]> {
		if (signal.aborted) return [];
		const f = await ensureFinder(activeCwd);
		if (signal.aborted) return [];

		const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
		if (!result.ok) return [];

		return result.value.items.slice(0, MENTION_MAX_RESULTS).map((mixed: MixedItem) => {
			if (mixed.type === "directory") {
				return {
					value: buildAtCompletionValue(mixed.item.relativePath),
					label: mixed.item.dirName,
					description: mixed.item.relativePath,
				};
			}
			return {
				value: buildAtCompletionValue(mixed.item.relativePath),
				label: mixed.item.fileName,
				description: mixed.item.relativePath,
			};
		});
	}

	function registerAutocompleteProvider(ctx: {
		ui: {
			addAutocompleteProvider?: (
				factory: (current: AutocompleteProvider) => AutocompleteProvider,
			) => void;
		};
	}) {
		if (typeof ctx.ui.addAutocompleteProvider !== "function") return;

		ctx.ui.addAutocompleteProvider((current) => {
			const mentionProvider = createFffMentionProvider(getMentionItems);

			return {
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					try {
						const mentionResult = await mentionProvider.getSuggestions(
							lines,
							cursorLine,
							cursorCol,
							options,
						);
						if (mentionResult) return mentionResult;
					} catch {
						// Delegate when FFF lookup is unavailable.
					}
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return (
						current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
					);
				},
			};
		});
	}

	// --- Flags / lifecycle ---

	pi.registerFlag("fff-frecency-db", {
		description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
		type: "string",
	});

	pi.registerFlag("fff-history-db", {
		description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
		type: "string",
	});

	pi.registerFlag("fff-enable-root-scan", {
		description:
			"Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
		type: "boolean",
	});

	pi.registerFlag("fff-external-allow", {
		description:
			"Allow grep/find to search the auto-detected @earendil-works/pi-coding-agent package directory via the ./pi-coding-agent alias (also: FFF_EXTERNAL_ALLOW env; default: true)",
		type: "boolean",
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			activeCwd = ctx.cwd;
			registerAutocompleteProvider(ctx);
			await ensureFinder(activeCwd);
		} catch (e: unknown) {
			ctx.ui.notify(
				`FFF init failed: ${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		destroyFinder();
		destroyExternalFinder();
	});

	// --- bash grep → ripgrep rewrite ---

	/**
	 * Rewrite a bash grep command to an equivalent rg (ripgrep) command.
	 * Returns the rewritten command, or undefined if the command is not a
	 * simple grep invocation that can be safely converted.
	 */
	function rewriteGrepToRg(command: string): string | undefined {
		const cdMatch = /^(\s*cd\s+([^\s&]+)\s*&&\s*)(.*)$/.exec(command);
		const prefix = cdMatch?.[1] ?? "";
		const body = cdMatch?.[3] ?? command;
		if (!/^\s*grep\b/.test(body)) return undefined;
		const beforePipe = body.split(/\s+\|/)[0].trim();
		const afterGrep = beforePipe.replace(/^\s*grep\s+/, "");
		// Strip stderr redirects (2>/dev/null, 2>&1, etc.) so they don't
		// become false path arguments.
		const cleaned = afterGrep.replace(/\s+2>(?:&\d+|\/dev\/null|\S+)/g, "").trim();
		const tokens = cleaned.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
		if (!tokens) return undefined;

		const rgArgs: string[] = ["rg"];
		let pattern: string | undefined;
		let paths: string[] = [];
		let includeGlobs: string[] = [];
		let excludeGlobs: string[] = [];
		let caseInsensitive = false;
		let fixedStrings = false;
		let wordRegex = false;
		let countOnly = false;
		let filesOnly = false;
		let invertMatch = false;
		let contextAfter = 0;
		let contextBefore = 0;
		let contextBoth = 0;
		let lineNumber = false;
		let noFilename = false;

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			if (tok === "-i" || tok === "--ignore-case") { caseInsensitive = true; continue; }
			if (tok === "-F" || tok === "--fixed-strings") { fixedStrings = true; continue; }
			if (tok === "-w" || tok === "--word-regexp") { wordRegex = true; continue; }
			if (tok === "-c" || tok === "--count") { countOnly = true; continue; }
			if (tok === "-l" || tok === "--files-with-matches") { filesOnly = true; continue; }
			if (tok === "-v" || tok === "--invert-match") { invertMatch = true; continue; }
			if (tok === "-n" || tok === "--line-number") { lineNumber = true; continue; }
			if (tok === "-h" || tok === "--no-filename") { noFilename = true; continue; }
			if (tok === "-E" || tok === "--extended-regexp") { continue; }
			if (tok === "-r" || tok === "-R" || tok === "--recursive") { continue; }
			if (tok === "-s" || tok === "--no-messages") { continue; }
			if (tok === "-A") { contextAfter = parseInt(tokens[++i] ?? "0", 10) || 0; continue; }
			if (tok === "-B") { contextBefore = parseInt(tokens[++i] ?? "0", 10) || 0; continue; }
			if (tok === "-C") { contextBoth = parseInt(tokens[++i] ?? "0", 10) || 0; continue; }
			if (tok.startsWith("-A")) { contextAfter = parseInt(tok.slice(2), 10) || 0; continue; }
			if (tok.startsWith("-B")) { contextBefore = parseInt(tok.slice(2), 10) || 0; continue; }
			if (tok.startsWith("-C")) { contextBoth = parseInt(tok.slice(2), 10) || 0; continue; }
			if (tok === "--include") { includeGlobs.push(tokens[++i] ?? ""); continue; }
			if (tok.startsWith("--include=")) { includeGlobs.push(tok.slice(10)); continue; }
			if (tok === "--exclude") { excludeGlobs.push(tokens[++i] ?? ""); continue; }
			if (tok.startsWith("--exclude=")) { excludeGlobs.push(tok.slice(10)); continue; }
			if (tok === "--exclude-dir") { excludeGlobs.push(`${tokens[++i] ?? ""}/`); continue; }
			if (tok.startsWith("--exclude-dir=")) { excludeGlobs.push(`${tok.slice(13)}/`); continue; }
			// Handle combined short flags like -rn, -in, -rnI, etc.
			if (/^-[a-zA-Z]{2,}$/.test(tok)) {
				let bail = false;
				for (const ch of tok.slice(1)) {
					switch (ch) {
						case "i": caseInsensitive = true; break;
						case "F": fixedStrings = true; break;
						case "w": wordRegex = true; break;
						case "c": countOnly = true; break;
						case "l": filesOnly = true; break;
						case "v": invertMatch = true; break;
						case "n": lineNumber = true; break;
						case "h": noFilename = true; break;
						case "E": case "r": case "R": case "s": break;
						default: bail = true; break;
					}
					if (bail) break;
					}
				if (bail) return undefined;
					continue;
			}
			if (tok.startsWith("-")) {
				// Unknown flag — bail to be safe.
				return undefined;
			}
			if (pattern === undefined) {
				pattern = tok.replace(/^["']|["']$/g, "");
			} else {
				paths.push(tok.replace(/^["']|["']$/g, ""));
			}
		}
		if (pattern === undefined) return undefined;

		if (caseInsensitive) rgArgs.push("-i");
		if (fixedStrings) rgArgs.push("-F");
		if (wordRegex) rgArgs.push("-w");
		if (countOnly) rgArgs.push("-c");
		if (filesOnly) rgArgs.push("-l");
		if (invertMatch) rgArgs.push("-v");
		if (lineNumber || noFilename) rgArgs.push("-n");
		if (noFilename) rgArgs.push("--no-filename");
		if (contextAfter > 0) rgArgs.push("-A", String(contextAfter));
		if (contextBefore > 0) rgArgs.push("-B", String(contextBefore));
		if (contextBoth > 0) rgArgs.push("-C", String(contextBoth));
		for (const g of includeGlobs) rgArgs.push("-g", g);
		for (const g of excludeGlobs) rgArgs.push("-g", `!${g}`);
		// rg is recursive by default; add -- to separate pattern from paths.
		rgArgs.push("--", pattern);
		for (const p of paths) rgArgs.push(p);

		const rgCmd = rgArgs.map((a) => {
			return /[\s'"!]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
		}).join(" ");
		return prefix + rgCmd;
	}

	pi.on("tool_call", (event: any) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!bashGrepInfo(command)) return;
		const rewritten = rewriteGrepToRg(command);
		if (rewritten) event.input.command = rewritten;
	});

	// --- grep tool ---

	const grepSchema = Type.Object({
		pattern: Type.String({
			description: "Search pattern (literal text or regex)",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Repo-relative path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Use ./pi-coding-agent to search the installed @earendil-works/pi-coding-agent package docs and examples.",
			}),
		),
		exclude: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description:
					"Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
			}),
		),
		caseSensitive: Type.Optional(
			Type.Boolean({
				description:
					"Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
			}),
		),
		context: Type.Optional(
			Type.Number({ description: "Context lines before+after each match" }),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
			}),
		),
		cursor: Type.Optional(
			Type.String({ description: "Pagination cursor from previous result" }),
		),
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
		promptSnippet: "Grep contents",
		promptGuidelines: [
			"Prefer bare identifiers as patterns. Literal queries are most efficient.",
			"Use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
			"caseSensitive: true when you need exact case (smart-case otherwise).",
			"After 1-2 greps, read the top match instead of more greps.",
		],
		parameters: grepSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const cachedGrepCursor = params.cursor ? getCursor(params.cursor) : undefined;
			let f: FileFinder;
			let query: string;
			if (cachedGrepCursor) {
				f = cachedGrepCursor.externalDir
					? await ensureExternalFinder(cachedGrepCursor.externalDir)
					: await ensureFinder(activeCwd);
				query = buildQuery(params.path, params.pattern, params.exclude, activeCwd, externalAllowlist);
			} else {
				const resolved = await resolveFinderAndQuery(
					params.path,
					params.pattern,
					params.exclude,
				);
				f = resolved.finder;
				query = resolved.query;
			}
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
			const hasRegexSyntax =
				params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
			if (mode === "regex") {
				try {
					new RegExp(params.pattern);
				} catch {
					mode = "plain";
				}
			}

			const p = params.pattern.trim();
			const isWildcardOnly =
				hasRegexSyntax &&
				/^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
					p,
				);

			if (isWildcardOnly) {
				return {
					content: [
						{
							type: "text",
							text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
						},
					],
					details: { totalMatched: 0, totalFiles: 0 },
				};
			}

			const smartCase = params.caseSensitive !== true;

			const grepResult = f.grep(query, {
				mode,
				smartCase,
				maxMatchesPerFile: Math.min(effectiveLimit, 50),
				cursor: cachedGrepCursor?.cursor ?? null,
				beforeContext: params.context ?? 0,
				afterContext: params.context ?? 0,
				classifyDefinitions: true,
			});

			if (!grepResult.ok) throw new Error(grepResult.error);

			let result = grepResult.value;
			let fuzzyNotice: string | null = null;

			if (result.items.length === 0 && !params.cursor && mode !== "regex") {
				const fuzzy = f.grep(params.pattern, {
					mode: "fuzzy",
					smartCase,
					maxMatchesPerFile: Math.min(effectiveLimit, 50),
					cursor: null,
					beforeContext: 0,
					afterContext: 0,
					classifyDefinitions: true,
				});

				if (fuzzy.ok && fuzzy.value.items.length > 0) {
					fuzzyNotice = `0 exact matches. Maybe you meant this?`;
					result = fuzzy.value;
				}
			}

			let output = formatGrepOutput(result);
			const notices: string[] = [];
			if (result.regexFallbackError) {
				notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
			}
			if (result.nextCursor) {
				notices.push(`Continue with cursor="${storeCursor(result.nextCursor, f === externalFinder ? externalFinderDir ?? undefined : undefined)}"`);
			}

			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
				},
			};
		},

		renderCall(args: any, theme: any, context: any) {
			return renderer.renderCall("grep", args, theme, context);
		},

		renderResult(result: any, options: any, theme: any, context: any) {
			return renderer.renderResult("grep", context.args, result, options, theme, context);
		},
	});

	// --- find tool ---

	const findSchema = Type.Object({
		pattern: Type.String({
			description:
				"Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Repo-relative path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Use ./pi-coding-agent to search the installed @earendil-works/pi-coding-agent package docs and examples.",
			}),
		),
		exclude: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], {
				description:
					"Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
			}),
		),
		cursor: Type.Optional(
			Type.String({ description: "Pagination cursor from previous result" }),
		),
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
		promptSnippet: "Find files by path or glob",
		promptGuidelines: [
			"Matches the WHOLE path, not just the filename — `profile` hits `chrome/browser/profiles/x.cc` too.",
			"Keep queries to 1-2 terms; extra words narrow.",
			"Use for paths, not content. Use grep for content.",
			"For exact path matches use a glob in `path` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.",
			"To list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.",
			"Use exclude: 'test/,*.min.js' to cut noise in large repos.",
		],
		parameters: findSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");

			const resumed = params.cursor ? getFindCursor(params.cursor) : undefined;
			const effectiveLimit = resumed
				? resumed.pageSize
				: Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);

			let f: FileFinder;
			let query: string;
			if (resumed) {
				f = resumed.externalDir
					? await ensureExternalFinder(resumed.externalDir)
					: await ensureFinder(activeCwd);
				query = resumed.query;
			} else {
				const resolved = await resolveFinderAndQuery(
					params.path,
					params.pattern,
					params.exclude,
				);
				f = resolved.finder;
				query = resolved.query;
			}
			const pattern = resumed ? resumed.pattern : params.pattern;
			const pageIndex = resumed?.nextPageIndex ?? 0;

			const searchResult = f.fileSearch(query, {
				pageIndex,
				pageSize: effectiveLimit,
			});
			if (!searchResult.ok) throw new Error(searchResult.error);

			const result = searchResult.value;
			const formatted = formatFindOutput(result, effectiveLimit, pattern);
			let output = formatted.output;

			const shownSoFar = pageIndex * effectiveLimit + result.items.length;
			const hasMore =
				result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

			const notices: string[] = [];
			if (formatted.weak && formatted.shownCount > 0)
				notices.push(
					`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
				);

			if (!formatted.weak && hasMore) {
				const remaining = result.totalMatched - shownSoFar;
				const cursorId = storeFindCursor({
					query,
					pattern,
					pageSize: effectiveLimit,
					nextPageIndex: pageIndex + 1,
					externalDir: f === externalFinder ? externalFinderDir ?? undefined : undefined,
				});
				notices.push(
					`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
				);
			}

			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
			return {
				content: [{ type: "text", text: output }],
				details: {
					totalMatched: result.totalMatched,
					totalFiles: result.totalFiles,
					pageIndex,
					hasMore,
				},
			};
		},

		renderCall(args: any, theme: any, context: any) {
			return renderer.renderCall("find", args, theme, context);
		},

		renderResult(result: any, options: any, theme: any, context: any) {
			return renderer.renderResult("find", context.args, result, options, theme, context);
		},
	});

	// --- commands ---

	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and status",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const health = finder.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`Health check failed: ${health.error}`, "error");
				return;
			}

			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
			];

			const progress = finder.getScanProgress();
			if (progress.ok) {
				lines.push(
					`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args, ctx) => {
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const result = finder.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
