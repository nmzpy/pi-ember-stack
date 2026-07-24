/**
 * SSOT for apply_patch compact display: per-file rows and +/- stats.
 */

import type { OpResult } from "./apply.ts";
import type { FileOp } from "./parse.ts";
import { parse_patch } from "./parse.ts";

export type ApplyPatchDetails = {
	ok: boolean;
	results: OpResult[];
	parseError?: string;
	fileCount: number;
};

type ThemeLike = {
	fg(tag: string, text: string): string;
	bold(text: string): string;
};

export type PatchFileRow = {
	path: string;
	additions: number;
	removals: number;
};

function content_line_count(text: string): number {
	if (!text) return 0;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length > 1 && text.endsWith("\n")) lines.pop();
	let count = 0;
	for (const line of lines) {
		if (line.length > 0) count++;
	}
	return count;
}

export function stats_from_op(op: FileOp): { additions: number; removals: number } {
	if (op.op === "add") {
		return { additions: content_line_count(op.contents), removals: 0 };
	}
	if (op.op === "delete") {
		return { additions: 0, removals: 0 };
	}
	let additions = 0;
	let removals = 0;
	for (const hunk of op.hunks) {
		for (const line of hunk.lines) {
			if (line.kind === "add") additions++;
			if (line.kind === "remove") removals++;
		}
	}
	return { additions, removals };
}

const FILE_OP_RE = /^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/gm;

/** Best-effort extraction while the model is still streaming a patch. */
function best_effort_patch_files(input: string): PatchFileRow[] {
	const raw = String(input ?? "");
	const headers: Array<{ path: string; start: number }> = [];
	for (const match of raw.matchAll(FILE_OP_RE)) {
		const path = match[1]?.trim();
		if (!path || match.index === undefined) continue;
		headers.push({ path, start: match.index });
	}
	if (headers.length === 0) return [];

	const rows: PatchFileRow[] = [];
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i] as { path: string; start: number };
		const end = i + 1 < headers.length ? (headers[i + 1] as { start: number }).start : raw.length;
		const section = raw.slice(header.start, end);
		let additions = 0;
		let removals = 0;
		for (const line of section.split("\n")) {
			const trimmed = line.trimEnd();
			if (trimmed.startsWith("***")) continue;
			if (line.startsWith("+")) additions++;
			else if (line.startsWith("-")) removals++;
		}
		rows.push({ path: header.path, additions, removals });
	}
	return rows;
}

/** Authoritative file rows for compact rendering (parse-first, streaming fallback). */
export function patch_files_from_input(input: string): PatchFileRow[] {
	const parsed = parse_patch(input);
	if (parsed.ok && parsed.ops.length > 0) {
		return parsed.ops.map((op) => ({
			path: op.path,
			...stats_from_op(op),
		}));
	}
	return best_effort_patch_files(input);
}

export function compact_patch_failure_reason(details: ApplyPatchDetails): string | undefined {
	if (details.parseError) {
		return details.parseError.split("\n")[0]?.trim() || details.parseError;
	}
	const failed = details.results.find((r) => r.status === "error");
	if (!failed) return undefined;
	const msg = failed.error ?? failed.hint ?? "unknown error";
	return msg.split("\n")[0]?.trim() || msg;
}

/** Compact header row for parse failures (no per-file children). */
export function format_patch_error_row(
	details: ApplyPatchDetails,
	theme: ThemeLike,
	is_error: boolean,
): string {
	const bullet = is_error
		? theme.fg("error", "• ")
		: details.ok
			? theme.fg("success", "• ")
			: theme.fg("warning", "• ");

	if (details.parseError) {
		return `${bullet}${theme.fg("error", "Patch failed")} ${theme.fg("error", compact_patch_failure_reason(details) ?? details.parseError)}`;
	}

	const ok_n = details.results.filter((r) => r.status === "ok").length;
	const fail_n = details.results.length - ok_n;
	const total = details.results.length || details.fileCount;
	const failure_reason = compact_patch_failure_reason(details);

	if (fail_n === 0) {
		return `${bullet}${theme.fg("muted", theme.bold("Patched"))} ${theme.fg("text", `${ok_n} file${ok_n === 1 ? "" : "s"}`)}`;
	}
	const summary = `${bullet}${theme.fg("muted", theme.bold("Patched"))} ${theme.fg("text", `${ok_n}/${total} ok`)} ${theme.fg("error", `${fail_n} failed`)}`;
	if (!failure_reason) return summary;
	return `${summary} ${theme.fg("error", failure_reason)}`;
}

/** @deprecated Use format_patch_error_row — kept for tests. */
export const format_result_row = format_patch_error_row;

function normalize_patch_path(file_path: string): string {
	return file_path.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
}

/** Per-path first-line error messages from apply_patch details. */
export function patch_file_errors_by_path(
	details: ApplyPatchDetails | undefined,
): Map<string, string> {
	const map = new Map<string, string>();
	if (!details) return map;
	for (const result of details.results) {
		if (result.status !== "error") continue;
		const msg = (result.error ?? result.hint ?? "failed").split("\n")[0]?.trim() || "failed";
		map.set(normalize_patch_path(result.path), msg);
	}
	return map;
}

export function patch_has_file_errors(details: ApplyPatchDetails | undefined): boolean {
	return patch_file_errors_by_path(details).size > 0;
}
