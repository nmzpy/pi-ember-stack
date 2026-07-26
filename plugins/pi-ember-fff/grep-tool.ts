import type {
	AgentToolResult,
	ExtensionAPI,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { GrepMode, FileFinder } from "@ff-labs/fff-node";
import { Type } from "@sinclair/typebox";
import type { CompactRenderer } from "../pi-compact-tools/renderer.ts";
import { buildQuery, type ExternalAllowlist } from "./query.ts";
import { getCursor, storeCursor } from "./cursor-store.ts";
import { formatGrepOutput } from "./format.ts";
import type { FinderManager } from "./finder.ts";

const DEFAULT_GREP_LIMIT = 20;

/** Minimal structural theme type for render callbacks. */
interface RenderTheme {
	fg(tag: string, text: string): string;
	bold(text: string): string;
}

/** Minimal structural context type for render callbacks. */
interface RenderContext {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	expanded?: boolean;
	isError?: boolean;
}

export type GrepToolDeps = {
	renderer: CompactRenderer;
	finder: FinderManager;
	externalAllowlist: ExternalAllowlist;
};

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

export function registerGrepTool(pi: ExtensionAPI, deps: GrepToolDeps): void {
	const { renderer, finder, externalAllowlist } = deps;

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
					? await finder.ensureExternalFinder(cachedGrepCursor.externalDir)
					: await finder.ensureFinder(finder.getActiveCwd());
				query = buildQuery(
					params.path,
					params.pattern,
					params.exclude,
					finder.getActiveCwd(),
					externalAllowlist,
				);
			} else {
				const resolved = await finder.resolveFinderAndQuery(
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
				notices.push(
					`Continue with cursor="${storeCursor(result.nextCursor, finder.externalDirForFinder(f))}"`,
				);
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

		renderCall(args: unknown, theme: RenderTheme, context: RenderContext) {
			return renderer.renderCall("grep", args, theme, { ...context, isError: false });
		},

		renderResult(
			result: AgentToolResult<unknown>,
			options: ToolRenderResultOptions,
			theme: RenderTheme,
			context: RenderContext,
		) {
			return renderer.renderResult(
				"grep",
				context.args,
				result as Parameters<typeof renderer.renderResult>[2],
				options,
				theme,
				{ ...context, isError: context.isError ?? false },
			);
		},
	});
}
