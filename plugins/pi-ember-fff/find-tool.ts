import type {
	AgentToolResult,
	ExtensionAPI,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { FileFinder } from "@ff-labs/fff-node";
import { Type } from "@sinclair/typebox";
import type { CompactRenderer } from "../pi-compact-tools/renderer.ts";
import { getFindCursor, storeFindCursor } from "./cursor-store.ts";
import { formatFindOutput } from "./format.ts";
import type { FinderManager } from "./finder.ts";

const DEFAULT_FIND_LIMIT = 30;

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

export type FindToolDeps = {
	renderer: CompactRenderer;
	finder: FinderManager;
};

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

export function registerFindTool(pi: ExtensionAPI, deps: FindToolDeps): void {
	const { renderer, finder } = deps;

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
					? await finder.ensureExternalFinder(resumed.externalDir)
					: await finder.ensureFinder(finder.getActiveCwd());
				query = resumed.query;
			} else {
				const resolved = await finder.resolveFinderAndQuery(
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
					externalDir: finder.externalDirForFinder(f),
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

		renderCall(args: unknown, theme: RenderTheme, context: RenderContext) {
			return renderer.renderCall("find", args, theme, { ...context, isError: false });
		},

		renderResult(
			result: AgentToolResult<unknown>,
			options: ToolRenderResultOptions,
			theme: RenderTheme,
			context: RenderContext,
		) {
			return renderer.renderResult(
				"find",
				context.args,
				result as Parameters<typeof renderer.renderResult>[2],
				options,
				theme,
				{ ...context, isError: context.isError ?? false },
			);
		},
	});
}
