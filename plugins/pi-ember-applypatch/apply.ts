/**
 * Hunk apply on strings + filesystem runner for apply_patch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pLimit from "p-limit";
import { find_context_matches, find_exact_matches } from "./match.ts";
import type { FileOp, Hunk, HunkLine } from "./parse.ts";
import { resolve_under_root } from "./safety.ts";

const CONCURRENCY = 16;

export type OpStatus = "ok" | "error";

export type OpResult = {
	path: string;
	op: "add" | "delete" | "update" | "move";
	status: OpStatus;
	error?: string;
	hint?: string;
	/** Present when Move to was used (display path of destination). */
	moved_to?: string;
};

export type ApplySummary = {
	ok: boolean;
	results: OpResult[];
};

/**
 * Apply update hunks to file content (LF-normalized lines in, original EOL out).
 */
export function apply_hunks_to_content(original: string, hunks: Hunk[]): string {
	const eol = detect_eol(original);
	const { lines } = split_content_lines(original);
	const working = [...lines];
	let search_from = 0;

	for (const hunk of hunks) {
		if (hunk.header) {
			const anchor = find_context_matches(working, [hunk.header], search_from);
			if (anchor.length === 0) {
				throw Object.assign(new Error(`Invalid Context: @@ ${hunk.header}`), {
					code: "invalid_context",
					hint: "Re-read the file and use an @@ anchor line that exists once, or omit @@.",
				});
			}
			if (anchor.length > 1) {
				throw Object.assign(new Error(`Ambiguous Context: @@ ${hunk.header}`), {
					code: "ambiguous_context",
					hint: "Provide a more unique @@ header or more surrounding context lines.",
				});
			}
			search_from = anchor[0] + 1;
		}

		const old_lines = context_old_lines(hunk.lines);
		const new_lines = context_new_lines(hunk.lines);

		if (old_lines.length === 0) {
			// Pure addition
			if (hunk.end_of_file) {
				working.push(...new_lines);
				search_from = working.length;
			} else {
				const insert_at = search_from;
				working.splice(insert_at, 0, ...new_lines);
				search_from = insert_at + new_lines.length;
			}
			continue;
		}

		const window_start = search_from;
		const matches = find_context_matches(working, old_lines, window_start, hunk.end_of_file);

		if (matches.length === 0) {
			throw Object.assign(
				new Error(`Invalid Context:\n${old_lines.map((l) => ` ${l}`).join("\n")}`),
				{
					code: "invalid_context",
					hint: "Re-read the file with read and copy lines into space/-/+ context lines.",
				},
			);
		}
		if (matches.length > 1) {
			throw Object.assign(
				new Error(`Ambiguous Context:\n${old_lines.map((l) => ` ${l}`).join("\n")}`),
				{
					code: "ambiguous_context",
					hint: "Add more unique context lines or an @@ soft anchor.",
				},
			);
		}

		const start = matches[0];
		const replacement = context_replacement_lines(hunk.lines, working, start);
		working.splice(start, old_lines.length, ...replacement);
		search_from = start + replacement.length;
	}

	return join_lines(working, eol);
}

export async function apply_ops(
	workspace_root: string,
	ops: FileOp[],
	signal?: AbortSignal,
): Promise<ApplySummary> {
	const limit = pLimit(CONCURRENCY);
	const results = await Promise.all(
		ops.map((op) =>
			limit(async (): Promise<OpResult> => {
				if (signal?.aborted) {
					return {
						path: op.path,
						op: op.op === "update" && op.move_to ? "move" : op.op,
						status: "error",
						error: "Aborted",
					};
				}
				try {
					return await apply_one(workspace_root, op);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const hint =
						err && typeof err === "object" && "hint" in err
							? String((err as { hint?: string }).hint ?? "")
							: undefined;
					return {
						path: op.path,
						op: op.op === "update" && "move_to" in op && op.move_to ? "move" : op.op,
						status: "error",
						error: message,
						...(hint ? { hint } : {}),
					};
				}
			}),
		),
	);

	const ok = results.every((r) => r.status === "ok");
	return { ok, results };
}

async function apply_one(workspace_root: string, op: FileOp): Promise<OpResult> {
	switch (op.op) {
		case "add":
			return apply_add(workspace_root, op.path, op.contents);
		case "delete":
			return apply_delete(workspace_root, op.path);
		case "update":
			return apply_update(workspace_root, op.path, op.hunks, op.move_to);
	}
}

function apply_add(workspace_root: string, raw_path: string, contents: string): OpResult {
	const resolved = resolve_under_root(workspace_root, raw_path);
	if (fs.existsSync(resolved.absolute)) {
		return {
			path: resolved.relative,
			op: "add",
			status: "error",
			error: "File already exists",
			hint: "Use Update File for existing paths, or Delete File first.",
		};
	}
	fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
	atomic_write(resolved.absolute, contents);
	return { path: resolved.relative, op: "add", status: "ok" };
}

function apply_delete(workspace_root: string, raw_path: string): OpResult {
	const resolved = resolve_under_root(workspace_root, raw_path);
	if (!fs.existsSync(resolved.absolute)) {
		return {
			path: resolved.relative,
			op: "delete",
			status: "error",
			error: "File does not exist",
		};
	}
	const stat = fs.lstatSync(resolved.absolute);
	if (stat.isDirectory()) {
		return {
			path: resolved.relative,
			op: "delete",
			status: "error",
			error: "Refusing to delete a directory",
		};
	}
	fs.unlinkSync(resolved.absolute);
	return { path: resolved.relative, op: "delete", status: "ok" };
}

function apply_update(
	workspace_root: string,
	raw_path: string,
	hunks: Hunk[],
	move_to?: string,
): OpResult {
	const resolved = resolve_under_root(workspace_root, raw_path);
	if (!fs.existsSync(resolved.absolute)) {
		return {
			path: resolved.relative,
			op: move_to ? "move" : "update",
			status: "error",
			error: "File does not exist",
			hint: "Re-read the path or use Add File for new files.",
		};
	}

	const original = fs.readFileSync(resolved.absolute, "utf8");
	let next: string;
	try {
		next = apply_hunks_to_content(original, hunks);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const hint =
			err && typeof err === "object" && "hint" in err
				? String((err as { hint?: string }).hint ?? "")
				: undefined;
		return {
			path: resolved.relative,
			op: move_to ? "move" : "update",
			status: "error",
			error: message,
			...(hint ? { hint } : {}),
		};
	}

	atomic_write(resolved.absolute, next);

	if (!move_to) {
		return { path: resolved.relative, op: "update", status: "ok" };
	}

	const dest = resolve_under_root(workspace_root, move_to);
	if (fs.existsSync(dest.absolute)) {
		return {
			path: resolved.relative,
			op: "move",
			status: "error",
			error: `Move destination already exists: ${dest.relative}`,
			moved_to: dest.relative,
		};
	}
	fs.mkdirSync(path.dirname(dest.absolute), { recursive: true });
	fs.renameSync(resolved.absolute, dest.absolute);
	return {
		path: resolved.relative,
		op: "move",
		status: "ok",
		moved_to: dest.relative,
	};
}

function atomic_write(target: string, contents: string): void {
	const dir = path.dirname(target);
	const tmp = path.join(
		dir,
		`.apply_patch_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(tmp, contents, "utf8");
		fs.renameSync(tmp, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// ignore cleanup
		}
		throw err;
	}
}

function context_old_lines(lines: HunkLine[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		if (line.kind === "keep" || line.kind === "remove") out.push(line.text);
	}
	return out;
}

function context_new_lines(lines: HunkLine[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		if (line.kind === "keep" || line.kind === "add") out.push(line.text);
	}
	return out;
}

/** Build replacement lines, preserving original file bytes for matched keep rows. */
function context_replacement_lines(hunk_lines: HunkLine[], file_lines: string[], start: number): string[] {
	const out: string[] = [];
	let file_idx = start;
	for (const line of hunk_lines) {
		if (line.kind === "keep") {
			out.push(file_lines[file_idx]);
			file_idx += 1;
		} else if (line.kind === "remove") {
			file_idx += 1;
		} else if (line.kind === "add") {
			out.push(line.text);
		}
	}
	return out;
}

export { find_context_matches, find_exact_matches };

function detect_eol(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

function split_content_lines(content: string): { lines: string[]; eol: "\r\n" | "\n" } {
	const eol = detect_eol(content);
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const parts = normalized.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return { lines: parts, eol };
}

function join_lines(lines: string[], eol: "\r\n" | "\n"): string {
	if (lines.length === 0) return "";
	return `${lines.join(eol)}${eol}`;
}

/** Test helper: create a temp workspace under os.tmpdir(). */
export function make_temp_workspace(prefix = "pi-ember-applypatch-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
