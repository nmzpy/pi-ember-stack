/**
 * Context-matching ladder for apply_patch hunks.
 * Rung 1: exact byte match
 * Rung 2: trailing whitespace ignored per line
 * Rung 3: NFKC + smart quotes/dashes/spaces normalized (Pi edit-style fuzzy)
 */

export type MatchRung = "exact" | "trim_trailing" | "fuzzy";

const MATCH_RUNGS: readonly MatchRung[] = ["exact", "trim_trailing", "fuzzy"];

const FUZZY_CHAR_MAP: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u2013": "-",
	"\u2014": "-",
	"\u00a0": " ",
	"\u2003": " ",
	"\u2002": " ",
	"\u2009": " ",
	"\ufeff": "",
};

export function trim_trailing_whitespace_line(line: string): string {
	return line.replace(/[ \t]+$/, "");
}

export function normalize_for_fuzzy_match(text: string): string {
	let normalized = text.normalize("NFKC");
	for (const [from, to] of Object.entries(FUZZY_CHAR_MAP)) {
		if (normalized.includes(from)) {
			normalized = normalized.split(from).join(to);
		}
	}
	return trim_trailing_whitespace_line(normalized);
}

export function line_matches_at_rung(file_line: string, pattern_line: string, rung: MatchRung): boolean {
	if (rung === "exact") return file_line === pattern_line;
	const left = rung === "fuzzy" ? normalize_for_fuzzy_match(file_line) : trim_trailing_whitespace_line(file_line);
	const right =
		rung === "fuzzy" ? normalize_for_fuzzy_match(pattern_line) : trim_trailing_whitespace_line(pattern_line);
	return left === right;
}

function sequence_matches_at_rung(
	lines: string[],
	start: number,
	pattern: string[],
	rung: MatchRung,
): boolean {
	for (let p = 0; p < pattern.length; p++) {
		if (!line_matches_at_rung(lines[start + p], pattern[p], rung)) return false;
	}
	return true;
}

function find_matches_at_rung(
	lines: string[],
	pattern: string[],
	start: number,
	prefer_eof: boolean,
	rung: MatchRung,
): number[] {
	if (pattern.length === 0) return [start];
	if (pattern.length > lines.length) return [];

	const matches: number[] = [];
	const last_start = lines.length - pattern.length;

	if (prefer_eof && last_start >= start) {
		if (sequence_matches_at_rung(lines, last_start, pattern, rung)) {
			return [last_start];
		}
	}

	for (let i = start; i <= last_start; i++) {
		if (sequence_matches_at_rung(lines, i, pattern, rung)) matches.push(i);
	}
	return matches;
}

/**
 * Find context start indices using the fuzzy ladder. Returns on the first rung
 * that yields at least one match (exact preferred over trim over fuzzy).
 */
export function find_context_matches(
	lines: string[],
	pattern: string[],
	start = 0,
	prefer_eof = false,
): number[] {
	for (const rung of MATCH_RUNGS) {
		const matches = find_matches_at_rung(lines, pattern, start, prefer_eof, rung);
		if (matches.length > 0) return matches;
	}
	return [];
}

/** Exact-only matching — kept for tests and explicit callers. */
export function find_exact_matches(
	lines: string[],
	pattern: string[],
	start = 0,
	prefer_eof = false,
): number[] {
	return find_matches_at_rung(lines, pattern, start, prefer_eof, "exact");
}
