import type { GrepResult, SearchResult } from "@ff-labs/fff-node";

const GREP_MAX_LINE_LENGTH = 500;
const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;
const FIND_WEAK_SAMPLE_SIZE = 5;

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
	const trimmed = line.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

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

export function formatGrepOutput(result: GrepResult): string {
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
			const lineNum = match.lineNumber - (match.contextBefore?.length ?? 0) + i;
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

function weakScoreThreshold(pattern: string): number {
	const perfect = pattern.length * 12;
	return Math.floor((perfect * 50) / 100);
}

export interface FormattedFind {
	output: string;
	weak: boolean;
	shownCount: number;
}

export function formatFindOutput(
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
