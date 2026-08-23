import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReadTool,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSharedRenderer } from "../../pi-compact-tools/shared-renderer.ts";
import { MAX_READ_LINE_BYTES } from "./constants.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { readNormFile, safeSnapId } from "./file-reader.ts";
import { fmtRegion, HASH_SEP, lineHashes, MAX_HASH_LINES } from "./hashline/index.ts";
import { toCwd } from "./paths.ts";
import { loadGuide, loadP } from "./prompts.ts";
import { recordServedSafe } from "./served.ts";
import { abortIf, makePrepareArguments, visLines } from "./utils.ts";
import { valAccess } from "./validation.ts";

const R_DESC = loadP("../prompts/read.md");

const R_SNIPPET = loadP("../prompts/read-snippet.md");

interface RowSize {
	lineNumber: number;
	bytes: number;
}

function readGuide(): string[] {
	return loadGuide("../prompts/read-guidelines.md");
}

function normPosInt(value: number | undefined, name: "offset" | "limit"): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`[E_BAD_SHAPE] Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

export function formatPaginationHint(
	startLine: number,
	endLine: number,
	totalLines: number,
	nextOffset: number,
	byteLimit?: number,
): string {
	const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
	return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
	precomputedHashes?: string[],
	path?: string,
	maxLineBytes = MAX_READ_LINE_BYTES,
	maxTruncLines = DEFAULT_MAX_LINES,
): Promise<{
	text: string;
	truncation?: TruncationResult;
	nextOffset?: number;
	servedHashes: string[];
}> {
	const allLines = visLines(text);
	const totalLines = allLines.length;
	const startLine = normPosInt(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
			const allHashes =
				precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
			const emptyLineHash = allHashes[0] ?? "";
			return {
				text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]`,
				servedHashes: emptyLineHash ? [emptyLineHash] : [],
			};
		}
		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use replace to insert content.`,
			servedHashes: [],
		};
	}
	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
			servedHashes: [],
		};
	}

	const limit = normPosInt(options.limit, "limit");
	const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const allHashes = precomputedHashes ?? (await (path ? lineHashes(text, path) : lineHashes(text)));
	const selectedHashes = allHashes.slice(startLine - 1, endIdx);
	const formatted = fmtRegion(selectedHashes, selected);
	const maxBytes = maxLineBytes;
	const rowSizes: RowSize[] = selected.map(
		(line: string, index: number): RowSize => ({
			lineNumber: startLine + index,
			bytes: Buffer.byteLength(`${selectedHashes[index]}${HASH_SEP}${line}`, "utf-8"),
		}),
	);
	if (rowSizes.some((row: RowSize): boolean => row.bytes > maxBytes)) {
		const oversized = rowSizes.filter((row: RowSize): boolean => row.bytes > maxBytes);
		const rows = rowSizes.map((row: RowSize, index: number): string =>
			row.bytes > maxBytes
				? `[Line ${row.lineNumber} is ${formatSize(row.bytes)}, exceeds ${formatSize(maxBytes)}; content not shown. Use bash: sed -n '${row.lineNumber}p' <path> | head -c ${maxBytes}]`
				: fmtRegion([selectedHashes[index] ?? ""], [selected[index] ?? ""]),
		);
		const skippedTruncation = truncateHead(rows.join("\n"), {
			maxBytes,
			maxLines: maxTruncLines,
		});
		const shownRowCount =
			skippedTruncation.content === "" ? 0 : skippedTruncation.content.split("\n").length;
		const lastShownLine = shownRowCount > 0 ? startLine + shownRowCount - 1 : startLine - 1;
		const oversizedIndexes = new Set(
			rowSizes
				.map((row: RowSize, index: number): number => (row.bytes > maxBytes ? index : -1))
				.filter((index: number): boolean => index >= 0),
		);
		const servedHashes: string[] = [];
		for (let index = 0; index < Math.min(shownRowCount, rows.length); index++) {
			if (!oversizedIndexes.has(index)) {
				const hash = selectedHashes[index];
				if (hash !== undefined) servedHashes.push(hash);
			}
		}
		const firstOversized = oversized[0];
		const lineLabel =
			firstOversized !== undefined && oversized.length === 1
				? `Line ${firstOversized.lineNumber}`
				: `Lines ${oversized.map((row: RowSize): number => row.lineNumber).join(", ")}`;
		const verb = oversized.length === 1 ? "exceeds" : "exceed";
		const addresses = oversized.map((row: RowSize): string => `${row.lineNumber}p`).join(";");
		const warning = `[${lineLabel} ${verb} ${formatSize(maxBytes)}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${addresses}' <path> | head -c ${maxBytes}]`;
		let preview = skippedTruncation.content;
		let nextOffset: number | undefined;
		if (shownRowCount > 0 && (skippedTruncation.truncated || lastShownLine < totalLines)) {
			const continuationOffset = lastShownLine + 1;
			nextOffset = continuationOffset;
			preview += `\n\n${warning}\n${formatPaginationHint(startLine, lastShownLine, totalLines, continuationOffset, skippedTruncation.truncated ? skippedTruncation.maxBytes : undefined)}`;
		} else {
			preview += `\n\n${warning}`;
		}
		return {
			text: preview,
			truncation: skippedTruncation.truncated ? skippedTruncation : undefined,
			...(nextOffset !== undefined ? { nextOffset } : {}),
			servedHashes,
		};
	}

	const truncation = truncateHead(formatted, {
		maxBytes,
		maxLines: maxTruncLines,
	});

	let preview = truncation.content;
	let nextOffset: number | undefined;
	const shownCount = truncation.content === "" ? 0 : truncation.content.split("\n").length;
	const servedHashes = selectedHashes.slice(0, shownCount);
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		const continuationOffset = endLineDisplay + 1;
		nextOffset = continuationOffset;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, continuationOffset)}`;
		} else {
			preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, continuationOffset, truncation.maxBytes ?? maxBytes)}`;
		}
	} else if (endIdx < totalLines) {
		const continuationOffset = endIdx + 1;
		nextOffset = continuationOffset;
		preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, continuationOffset)}`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
		servedHashes,
	};
}

export function regRead(pi: ExtensionAPI): void {
	const renderer = getSharedRenderer();
	pi.registerTool({
		name: "read",
		label: "Read",
		description: R_DESC,
		promptSnippet: R_SNIPPET,
		promptGuidelines: readGuide(),
		prepareArguments: makePrepareArguments(),
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read",
				}),
			),
		}),
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderer.renderCall("read", args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderer.renderResult(
				"read",
				context.args,
				result as unknown as Parameters<typeof renderer.renderResult>[2],
				options,
				theme,
				context,
			);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path;
			const absolutePath = toCwd(rawPath, ctx.cwd);

			abortIf(signal);
			await valAccess(absolutePath, rawPath);

			abortIf(signal);
			const file = await loadFileKindAndText(absolutePath, {
				maxLines: MAX_HASH_LINES,
				displayPath: rawPath,
			});
			if (file.kind === "image") {
				const builtinRead = createReadTool(ctx.cwd);
				const executeBuiltinRead = builtinRead.execute as unknown as (
					toolCallId: string,
					input: typeof params,
					abortSignal: typeof signal,
					onUpdate: typeof _onUpdate,
					context: typeof ctx,
				) => ReturnType<typeof builtinRead.execute>;
				return executeBuiltinRead(_toolCallId, params, signal, _onUpdate, ctx);
			}
			const {
				normalized,
				fileHashes,
				hadUtf8DecodeErrors,
				absolutePath: resolvedPath,
			} = await readNormFile(rawPath, ctx.cwd, {
				signal,
				preloadedFile: file,
				maxLines: MAX_HASH_LINES,
			});
			const preview = await fmtReadPreview(
				normalized,
				{
					offset: params.offset,
					limit: params.limit,
				},
				fileHashes,
				resolvedPath,
			);
			await recordServedSafe(resolvedPath, preview.servedHashes, "read");
			const snapshotId = await safeSnapId(absolutePath, "read");
			const previewText = hadUtf8DecodeErrors
				? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
				: preview.text;

			return {
				content: [{ type: "text", text: previewText }],
				details: {
					truncation: preview.truncation,
					snapshotId,
					...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
					metrics: {
						truncated: !!preview.truncation,
						...(preview.nextOffset !== undefined ? { next_offset: preview.nextOffset } : {}),
					},
				},
			};
		},
	});
}
