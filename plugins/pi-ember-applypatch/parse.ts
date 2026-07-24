/**
 * Codex-style apply_patch envelope parser.
 *
 * Grammar (simplified):
 *   Patch := "*** Begin Patch" { FileOp } "*** End Patch"
 *   FileOp := AddFile | DeleteFile | UpdateFile
 *   AddFile := "*** Add File: " path { "+" line }
 *   DeleteFile := "*** Delete File: " path
 *   UpdateFile := "*** Update File: " path [ "*** Move to: " path ] { Hunk }
 *   Hunk := "@@" [ header ] { (" "|"-"|"+") line } [ "*** End of File" ]
 */

export type HunkLine =
	| { kind: "keep"; text: string }
	| { kind: "remove"; text: string }
	| { kind: "add"; text: string };

export type Hunk = {
	/** Optional @@ soft-anchor header text (without the "@@" marker). */
	header?: string;
	lines: HunkLine[];
	end_of_file: boolean;
};

export type FileOp =
	| { op: "add"; path: string; contents: string }
	| { op: "delete"; path: string }
	| { op: "update"; path: string; move_to?: string; hunks: Hunk[] };

export type ParseOk = { ok: true; ops: FileOp[] };
export type ParseErr = { ok: false; error: string };
export type ParseResult = ParseOk | ParseErr;

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

/** Git unified-diff @@ metadata (e.g. `-33,8 +33,10 @@`) — not a Codex soft anchor. */
const GIT_UNIFIED_DIFF_HEADER_RE = /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s+@@)?$/;

export function is_git_unified_diff_header(header: string): boolean {
	return GIT_UNIFIED_DIFF_HEADER_RE.test(header.trim());
}

export function git_unified_diff_header_error(header: string): string {
	const sample = header.trim().replace(/\s+@@$/, "");
	return (
		`@@ header looks like git unified-diff metadata (${sample}). ` +
		"Omit @@ or use a source-line anchor copied from read (e.g. @@ def foo():)."
	);
}

export function parse_patch(input: string): ParseResult {
	const raw = String(input ?? "");
	if (!raw.trim()) {
		return { ok: false, error: "Patch input is empty" };
	}

	const lines = split_lines(raw);
	let i = 0;

	// Skip leading blank lines
	while (i < lines.length && lines[i].trim() === "") i++;

	if (i >= lines.length || lines[i].trim() !== BEGIN) {
		return { ok: false, error: `Patch must start with "${BEGIN}"` };
	}
	i++;

	const ops: FileOp[] = [];
	const seen_paths = new Set<string>();

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trimEnd();

		if (trimmed === END || trimmed.trim() === END) {
			i++;
			break;
		}
		if (trimmed.trim() === "") {
			i++;
			continue;
		}

		if (trimmed.startsWith(ADD)) {
			const file_path = trimmed.slice(ADD.length).trim();
			if (!file_path) return { ok: false, error: "Add File path is empty" };
			const dup = check_dup(seen_paths, file_path);
			if (dup) return dup;
			i++;
			const content_lines: string[] = [];
			while (i < lines.length) {
				const l = lines[i];
				const t = l.trimEnd();
				if (
					t === END ||
					t.startsWith(ADD) ||
					t.startsWith(DELETE) ||
					t.startsWith(UPDATE) ||
					t.trim() === END
				) {
					break;
				}
				if (!l.startsWith("+")) {
					return {
						ok: false,
						error: `Add File lines must start with '+': ${file_path}`,
					};
				}
				content_lines.push(l.slice(1));
				i++;
			}
			ops.push({
				op: "add",
				path: file_path,
				contents: content_lines.join("\n") + (content_lines.length > 0 ? "\n" : ""),
			});
			continue;
		}

		if (trimmed.startsWith(DELETE)) {
			const file_path = trimmed.slice(DELETE.length).trim();
			if (!file_path) return { ok: false, error: "Delete File path is empty" };
			const dup = check_dup(seen_paths, file_path);
			if (dup) return dup;
			i++;
			ops.push({ op: "delete", path: file_path });
			continue;
		}

		if (trimmed.startsWith(UPDATE)) {
			const file_path = trimmed.slice(UPDATE.length).trim();
			if (!file_path) return { ok: false, error: "Update File path is empty" };
			const dup = check_dup(seen_paths, file_path);
			if (dup) return dup;
			i++;

			let move_to: string | undefined;
			if (i < lines.length && lines[i].trimEnd().startsWith(MOVE)) {
				move_to = lines[i].trimEnd().slice(MOVE.length).trim();
				if (!move_to) return { ok: false, error: "Move to path is empty" };
				i++;
			}

			const hunks: Hunk[] = [];
			while (i < lines.length) {
				const l = lines[i];
				const t = l.trimEnd();
				if (
					t === END ||
					t.trim() === END ||
					t.startsWith(ADD) ||
					t.startsWith(DELETE) ||
					t.startsWith(UPDATE)
				) {
					break;
				}
				if (t.trim() === "") {
					i++;
					continue;
				}

				let header: string | undefined;
				if (t.startsWith("@@")) {
					header = t.slice(2).trim() || undefined;
					// Git unified-diff line ranges are not Codex anchors — strip them
					// and let space/-/+ context lines drive matching (with fuzzy ladder).
					if (header && is_git_unified_diff_header(header)) {
						header = undefined;
					}
					i++;
				} else if (
					t.startsWith(" ") ||
					t.startsWith("-") ||
					t.startsWith("+") ||
					t === EOF
				) {
					// Hunk without @@ header is allowed
				} else {
					return {
						ok: false,
						error: `Unexpected line in Update File ${file_path}: ${t}`,
					};
				}

				const hunk_lines: HunkLine[] = [];
				let end_of_file = false;
				while (i < lines.length) {
					const hl = lines[i];
					const ht = hl.trimEnd();
					if (ht === EOF) {
						end_of_file = true;
						i++;
						break;
					}
					if (
						ht === END ||
						ht.trim() === END ||
						ht.startsWith(ADD) ||
						ht.startsWith(DELETE) ||
						ht.startsWith(UPDATE) ||
						ht.startsWith("@@") ||
						ht.startsWith(MOVE)
					) {
						break;
					}
					if (ht.trim() === "" && hunk_lines.length === 0) {
						i++;
						continue;
					}
					const prefix = hl.charAt(0);
					if (prefix === " ") {
						hunk_lines.push({ kind: "keep", text: hl.slice(1) });
					} else if (prefix === "-") {
						hunk_lines.push({ kind: "remove", text: hl.slice(1) });
					} else if (prefix === "+") {
						hunk_lines.push({ kind: "add", text: hl.slice(1) });
					} else {
						return {
							ok: false,
							error: `Hunk lines must start with ' ', '-', or '+': ${file_path}`,
						};
					}
					i++;
				}

				if (hunk_lines.length === 0 && !header && !end_of_file) {
					continue;
				}
				hunks.push({ header, lines: hunk_lines, end_of_file });
			}

			ops.push({ op: "update", path: file_path, move_to, hunks });
			continue;
		}

		return { ok: false, error: `Unexpected patch line: ${trimmed}` };
	}

	// Verify we saw End Patch (or accepted EOF at end of input after ops)
	const remaining = lines.slice(i).filter((l) => l.trim() !== "");
	if (remaining.length > 0) {
		return { ok: false, error: `Unexpected content after "${END}"` };
	}

	if (ops.length === 0) {
		return { ok: false, error: "Patch contains no file operations" };
	}

	return { ok: true, ops };
}

function check_dup(seen: Set<string>, file_path: string): ParseErr | undefined {
	const key = file_path.replace(/\\/g, "/");
	if (seen.has(key)) {
		return { ok: false, error: `Duplicate path in patch: ${file_path}` };
	}
	seen.add(key);
	return undefined;
}

function split_lines(text: string): string[] {
	const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const parts = normalized.split("\n");
	// Preserve trailing empty element only if the input ended with a newline —
	// trim trailing empties that come from a final newline so markers match.
	if (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}
	return parts;
}
