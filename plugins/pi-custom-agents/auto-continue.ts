/**
 * Pure helpers for output-limit auto-continue recovery decisions.
 *
 * After a stopReason === "length" event, pi-custom-agents needs to decide
 * whether to call ctx.compact() before sending a hidden resume message.
 * These helpers centralise that logic so the caller stays thin.
 */

// ---------------------------------------------------------------------------
// Constants (SSOT)
// ---------------------------------------------------------------------------

export const DEFAULT_AUTO_CONTINUE_MAX_CHARS = 6000;

const BENIGN_COMPACT_SUBSTRINGS: readonly string[] = [
	"Already compacted",
	"Nothing to compact",
];

const COMPACT_FAILED_PREFIX = "Compaction failed: ";

/**
 * SSOT customInstructions passed to ctx.compact() during output-limit
 * recovery. The summarizer must emit only the four labeled lines; no
 * markdown headers, no bullets, no narrative, no split-turn sections.
 */
export const COMPACT_FOCUS_INSTRUCTIONS: string = [
	"Compaction. Output only these four labeled lines and nothing else:",
	"Goal: <what the user asked for>",
	"Files: <file paths that were read or modified, preserving exact paths>",
	"Done: <work already completed in this session>",
	"Left: <remaining work as numbered next steps plus the exact resume point>",
].join("\n");

const RESUME_DIRECTIVE = [
	"Output was cut off by the maximum output token limit.",
	"Continue the interrupted task from Left:. Do not redo work listed in Done:. Use Files: for context.",
].join("\n");

// ---------------------------------------------------------------------------
// is_benign_compact_error
// ---------------------------------------------------------------------------

/**
 * True when an error thrown by ctx.compact() means "nothing more to compact"
 * and the agent should resume anyway rather than surfacing the error.
 */
export function is_benign_compact_error(error: unknown): boolean {
	let message: string;
	if (error instanceof Error) {
		message = error.message;
	} else if (typeof error === "string") {
		message = error;
	} else {
		return false;
	}

	// Strip the "Compaction failed: " prefix if present so the substring
	// check matches Pi's wrapped messages.
	const stripped = message.startsWith(COMPACT_FAILED_PREFIX)
		? message.slice(COMPACT_FAILED_PREFIX.length)
		: message;

	return BENIGN_COMPACT_SUBSTRINGS.some((sub) => stripped.includes(sub));
}

// ---------------------------------------------------------------------------
// should_skip_compact
// ---------------------------------------------------------------------------

/**
 * True when the branch tip is already a compaction entry, so calling
 * session.compact() would throw "Already compacted".
 */
export function should_skip_compact(
	branch_entries: ReadonlyArray<{ type?: string } | null | undefined>,
): boolean {
	if (branch_entries.length === 0) {
		return false;
	}

	// Walk backwards to find the last defined entry.
	for (let i = branch_entries.length - 1; i >= 0; i--) {
		const entry = branch_entries[i];
		if (entry == null) {
			continue;
		}
		return entry.type === "compaction";
	}

	// All entries were null/undefined — let compact try.
	return false;
}

// ---------------------------------------------------------------------------
// build_auto_continue_content
// ---------------------------------------------------------------------------

export type AutoContinueContentInput = {
	/** @deprecated Plan text is kept in the compaction summary; never duplicated here. */
	latest_plan_text?: string | undefined;
	/** Soft cap for total content length (chars). Default 6000. */
	max_chars?: number | undefined;
};

/**
 * Build hidden pi-agents-auto-continue content.
 *
 * The compaction summary (Goal/Files/Done/Left) is already in context after
 * compact(); this returns a short resume directive only. It does NOT paste
 * the plan draft again, avoiding split-turn duplication.
 */
export function build_auto_continue_content(input: AutoContinueContentInput): string {
	const max_chars = input.max_chars ?? DEFAULT_AUTO_CONTINUE_MAX_CHARS;
	let result = RESUME_DIRECTIVE;
	if (result.length > max_chars) {
		result = result.slice(0, max_chars);
	}
	return result;
}
