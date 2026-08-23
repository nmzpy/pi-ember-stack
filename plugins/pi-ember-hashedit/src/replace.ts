import { constants } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { resolveTarget, writeAtomic } from "./fs-write.ts";
import { findSnapshotPaths, type HashStore, loadHashStore } from "./hash-store.ts";
import {
	AnchorMismatchError,
	applyEdit,
	type HEdit,
	lineHashes,
	MAX_HASH_LINES,
	type NEdit,
	parseHashRef,
	RangeStaleError,
	resEdit,
} from "./hashline/index.ts";
import { toCwd } from "./paths.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { genDiff, type LineEnding, restoreEndings } from "./replace-diff.ts";
import { normReq } from "./replace-normalize.ts";
import type { RPreview } from "./replace-render.ts";
import { buildChanged, buildNoop, type RMeta, type RMetrics } from "./replace-response.ts";
import { saveUndo } from "./replace-undo.ts";
import { getServed, recordServedDiffSafe, recordServedSafe } from "./served.ts";
import {
	abortIf,
	isRec,
	makePrepareArguments,
	rejectUnknownFields,
	requireArrayItem,
} from "./utils.ts";

const replacementLinesSchema = Type.Array(
	Type.String({
		description:
			"One replacement line. Each element is exactly one line; do not embed \\n inside an element — use separate elements.",
	}),
	{
		description:
			"Replacement lines as an array of strings, one element per line. Use [] to delete the range.",
	},
);

const removeFromSchema = Type.String({
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the FIRST line to remove (inclusive)',
});

const removeToSchema = Type.String({
	description:
		'Bare 3-char HASH only (e.g. "aB3") — copy just the hash from the leftmost column of a read row like `aB3│content`; never the line content. Marks the LAST line to remove (inclusive)',
});

export const editToolSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description:
					"Path to edit. Required — always provide it explicitly; it is only auto-resolved from the anchors as a fallback when omitted by mistake.",
			}),
		),
		remove_from: removeFromSchema,
		remove_to: removeToSchema,
		replacement_lines: replacementLinesSchema,
	},
	{ additionalProperties: false },
);
export type ReqParams = {
	path: string;
	remove_from: string;
	remove_to: string;
	replacement_lines: string[];
};

export type ReplaceDetails = {
	diff: string;
	firstChangedLine?: number;
	snapshotId?: string;
	classification?: "noop";
	metrics?: RMetrics;
};

interface PipelineResult {
	path: string;
	originalNormalized: string;
	result: string;
	bom: string;
	originalEnding: LineEnding;
	hadUtf8DecodeErrors: boolean;
	warnings: string[];
	noopEdit?: NEdit;
	firstChangedLine?: number;
	lastChangedLine?: number;
	originalHashes: string[];
	resultHashes: string[];
	totalAddedLines: number;
	totalRemovedLines: number;
}

const ROOT_KS = new Set(["path", "remove_from", "remove_to", "replacement_lines"]);

export function assertReq(request: unknown): asserts request is ReqParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	const record = request as Record<string, unknown>;
	rejectUnknownFields(record, ROOT_KS, "Edit request");

	if (typeof record.path !== "string" || record.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
	}

	const replacementLines = record.replacement_lines;
	if (
		typeof record.remove_from !== "string" ||
		typeof record.remove_to !== "string" ||
		!Array.isArray(replacementLines) ||
		replacementLines.some((line: unknown) => typeof line !== "string")
	) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires "remove_from", "remove_to", and "replacement_lines" at the top level. replacement_lines must be an array of strings, one element per line (use [] to delete).',
		);
	}
}

async function resolveMissingPath(
	request: Record<string, unknown>,
): Promise<{ path: string; warning: string } | undefined> {
	if (typeof request.path === "string") return undefined;
	const from = request.remove_from;
	const to = request.remove_to;
	if (typeof from !== "string" || typeof to !== "string") return undefined;
	const hashes: string[] = [];
	for (const ref of [from, to]) {
		try {
			hashes.push(parseHashRef(ref).hash);
		} catch {
			return undefined;
		}
	}
	let store: HashStore;
	try {
		store = await loadHashStore();
	} catch {
		return undefined;
	}
	const matches = findSnapshotPaths(store, hashes);
	if (matches.length === 1) {
		return {
			path: requireArrayItem(matches, 0),
			warning: `[E_BAD_SHAPE] Autocorrected: missing "path" resolved to ${matches[0]} — the only file whose stored hashes contain both anchors.`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`[E_BAD_SHAPE] Edit request requires a non-empty "path" string; the anchors match multiple known files: ${matches.join(", ")}. Include the intended path.`,
		);
	}
	return undefined;
}

export interface ExecPipelineOptions {
	accessMode?: number;
	signal?: AbortSignal;
	store?: HashStore;
	noPersist?: boolean;
}

function collectRemovedHashes(edit: HEdit, originalHashes: string[]): Set<string> {
	const removedHashes = new Set<string>();
	const startHash = edit.hash_bounds[0].hash;
	const endHash = edit.hash_bounds[1].hash;
	const startLine = originalHashes.indexOf(startHash);
	const endLine = originalHashes.indexOf(endHash);
	if (startLine >= 0 && endLine >= 0) {
		const firstLine = Math.min(startLine, endLine);
		const lastLine = Math.max(startLine, endLine);
		for (let i = firstLine; i <= lastLine; i++) {
			removedHashes.add(requireArrayItem(originalHashes, i));
		}
	}
	return removedHashes;
}

function countLineChanges(
	edit: HEdit,
	originalHashes: string[],
	isNoop: boolean,
	removedAutoFixes: number,
): { totalAddedLines: number; totalRemovedLines: number } {
	if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 };
	let totalRemovedLines = 0;
	const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash);
	const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash);
	if (startLine >= 0 && endLine >= 0) {
		totalRemovedLines = Math.abs(endLine - startLine) + 1;
	}
	return {
		totalAddedLines: Math.max(0, edit.content_lines.length - removedAutoFixes),
		totalRemovedLines,
	};
}

export async function execPipeline(
	params: ReqParams,
	cwd: string,
	options?: ExecPipelineOptions,
): Promise<PipelineResult> {
	const path = params.path;

	const editWarnings: string[] = [];
	const edit = resEdit(
		{
			remove_from: params.remove_from,
			remove_to: params.remove_to,
			replacement_lines: params.replacement_lines,
		},
		editWarnings,
	);

	const hashStore = options?.store ?? (await loadHashStore());
	const {
		normalized: originalNormalized,
		bom,
		originalEnding,
		fileHashes: originalHashes,
		hadUtf8DecodeErrors,
		absolutePath,
	} = await readNormFile(path, cwd, {
		signal: options?.signal,
		accessMode: options?.accessMode,
		maxLines: MAX_HASH_LINES,
		store: hashStore,
		noPersist: options?.noPersist,
	});

	const served = await getServed(hashStore, absolutePath);
	let anchorResult: ReturnType<typeof applyEdit>;
	try {
		anchorResult = applyEdit(
			originalNormalized,
			edit,
			options?.signal,
			originalHashes,
			path,
			served,
		);
	} catch (error) {
		if (options?.noPersist !== true) {
			if (error instanceof RangeStaleError) {
				await recordServedSafe(absolutePath, error.rangeHashes, "range-stale feedback");
			} else if (error instanceof AnchorMismatchError) {
				await recordServedSafe(absolutePath, error.feedbackHashes, "anchor-mismatch feedback");
			}
		}
		throw error;
	}

	const result = anchorResult.content;
	const isNoop = result === originalNormalized;

	const noPersist = options?.noPersist;
	const removedHashes = isNoop ? undefined : collectRemovedHashes(edit, originalHashes);
	const resultHashes = isNoop
		? originalHashes
		: await lineHashes(
				result,
				absolutePath,
				{
					content: originalNormalized,
					hashes: originalHashes,
					removedHashes,
				},
				hashStore,
				noPersist !== true,
			);
	const warnings = [...editWarnings, ...(anchorResult.warnings ?? [])];
	const { totalAddedLines, totalRemovedLines } = countLineChanges(
		edit,
		originalHashes,
		isNoop,
		anchorResult.autoFixes?.length ?? 0,
	);

	return {
		path,
		originalNormalized,
		result,
		bom,
		originalEnding,
		hadUtf8DecodeErrors,
		warnings,
		noopEdit: anchorResult.noopEdit,
		firstChangedLine: anchorResult.firstChangedLine,
		lastChangedLine: anchorResult.lastChangedLine,
		resultHashes,
		originalHashes,
		totalAddedLines,
		totalRemovedLines,
	};
}

export async function compPreview(request: unknown, cwd: string): Promise<RPreview> {
	try {
		const normalized = normReq(request);
		assertReq(normalized);
		const { path, originalNormalized, result, resultHashes, originalHashes } = await execPipeline(
			normalized,
			cwd,
			{ accessMode: constants.R_OK, noPersist: true },
		);
		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edit produced identical content.`,
			};
		}

		return { diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes).diff };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

type ToolDef = ToolDefinition<typeof editToolSchema, ReplaceDetails>;

export function buildToolDef(): ToolDef {
	const E_DESC = loadP("../prompts/replace.md");
	const E_SNIPPET = loadP("../prompts/replace-snippet.md");
	const E_GUIDE = loadGuide("../prompts/replace-guidelines.md");
	const renderer = getSharedRenderer();

	const parameters = editToolSchema;
	return {
		name: "replace",
		label: "Replace",
		description: E_DESC,
		parameters,
		promptSnippet: E_SNIPPET,
		promptGuidelines: E_GUIDE,
		prepareArguments: makePrepareArguments(),
		renderShell: "self",
		renderCall(args, theme, context) {
			return renderer.renderCall("replace", args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderer.renderResult(
				"replace",
				context.args,
				result as unknown as Parameters<typeof renderer.renderResult>[2],
				options,
				theme,
				context,
			);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const canonical = normReq(params);
			const resolution = isRec(canonical) ? await resolveMissingPath(canonical) : undefined;
			if (resolution && isRec(canonical)) {
				canonical.path = resolution.path;
			}
			assertReq(canonical);

			const normalizedParams = canonical;
			const path = normalizedParams.path;
			const absolutePath = toCwd(path, ctx.cwd);
			const mutationTargetPath = await resolveTarget(absolutePath);
			return withFileMutationQueue(mutationTargetPath, async () => {
				abortIf(signal);

				const {
					originalNormalized,
					originalHashes,
					result,
					bom,
					originalEnding,
					hadUtf8DecodeErrors,
					warnings,
					noopEdit,
					firstChangedLine,
					lastChangedLine,
					resultHashes,
					totalAddedLines,
					totalRemovedLines,
				} = await execPipeline(normalizedParams, ctx.cwd, {
					accessMode: constants.R_OK | constants.W_OK,
					signal,
				});

				if (resolution) {
					warnings.unshift(resolution.warning);
				}

				const editsAttempted = 1;
				if (originalNormalized === result) {
					const noopSnapshotId = await safeSnapId(absolutePath, "noop edit");
					return buildNoop({
						path,
						noopEdit,
						snapshotId: noopSnapshotId,
						editMeta: {
							editsAttempted,
							noopEditsCount: noopEdit ? 1 : 0,
							addedLines: 0,
							removedLines: 0,
						},
						warnings,
					});
				}

				if (hadUtf8DecodeErrors) {
					warnings.push(
						"Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.",
					);
				}

				abortIf(signal);
				const undo = await saveUndo(mutationTargetPath, {
					content: originalNormalized,
					bom,
					originalEnding,
					hashes: originalHashes,
					resultContent: result,
				});
				if (!undo.persisted) {
					throw new Error(
						`[E_UNDO_UNAVAILABLE] Cannot persist undo history to the hash store; the edit was NOT applied and ${path} is unchanged. Retry the replace, or use write if the store cannot be recovered.`,
					);
				}
				try {
					abortIf(signal);
					await writeAtomic(absolutePath, bom + restoreEndings(result, originalEnding));
				} catch (error) {
					await undo.restore();
					throw error;
				}
				const updatedSnapshotId = await safeSnapId(absolutePath, "post-edit");

				const editMeta: RMeta = {
					editsAttempted,
					noopEditsCount: noopEdit ? 1 : 0,
					firstChangedLine,
					lastChangedLine,
					addedLines: totalAddedLines,
					removedLines: totalRemovedLines,
				};

				const successInput = {
					path,
					originalNormalized,
					originalHashes,
					result,
					resultHashes,
					warnings,
					snapshotId: updatedSnapshotId,
					editMeta,
				};
				const changed = buildChanged(successInput);
				if (changed.details.diff) {
					await recordServedDiffSafe(mutationTargetPath, changed.details.diff, "post-edit diff");
				}
				return changed;
			});
		},
	};
}

export function regReplace(pi: ExtensionAPI): void {
	pi.registerTool(buildToolDef());
}
