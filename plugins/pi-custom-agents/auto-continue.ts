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
 * recovery. Steers the summarizer to produce a plain-text checkpoint using
 * exactly four labeled lines (Goal / Done / Left / Files) instead of the
 * default ## markdown template.
 *
 * Pi appends this as "Additional focus:" after its own default template, so
 * the instruction explicitly tells the model to prefer the plain labeled
 * lines as the authoritative checkpoint body when formats conflict.
 */
export const COMPACT_FOCUS_INSTRUCTIONS: string = [
	"The prior assistant turn was cut off by the maximum output token limit.",
	"Produce the checkpoint as plain dense text using exactly these labeled lines:",
	"goal: <what the user asked for>",
	"files: <file paths that were read or modified, preserving exact paths and function names>",
	"done: <work already completed in this session>",
	"left: <remaining work as numbered next steps plus the exact resume point of the truncated turn>",
	"Rules:",
	"- No markdown headers (#, ##, ###), no bold/italics, no decorative bullets.",
	"- Plain short labeled lines or key: value pairs only.",
	"- Preserve exact file paths, function names, and error messages.",
	"- done must list finished work; left must list remaining work as ordered next steps and the resume point.",
	"- Do not invent new goals; do not discard completed work.",
	"- If the default template format conflicts with these labels, prefer the plain",
	"  goal:/files:/done:/left: labeled lines as the authoritative checkpoint body.",
].join("\n");

const RESUME_DIRECTIVE = [
	"Assistant response was cut off by the maximum output token limit.",
	"The session checkpoint already in context uses goal:/files:/done:/left: labeled lines.",
	"Follow the numbered next steps in left. Do not redo work listed in done.",
	"Resume from the resume point in left and continue the interrupted task now.",
].join("\n");

const TRUNCATION_MARKER = "[…truncated — see session transcript for full plan draft…]";

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
	/** Optional plan-mode accumulated plan text (may not be in compaction). */
	latest_plan_text?: string | undefined;
	/** Soft cap for total content length (chars). Default 6000. */
	max_chars?: number | undefined;
};

/**
 * Build hidden pi-agents-auto-continue content.
 *
 * The compaction summary is NOT duplicated here — Pi already injects it into
 * LLM context after compact(). The returned string is a short resume directive
 * that tells the model to follow the Goal/Done/Left/Files checkpoint already
 * in context. An optional plan draft excerpt may be appended when the plan
 * text is not already captured in the goal:/files:/done:/left: checkpoint.
 *
 * Never returns bare "continue".
 */
export function build_auto_continue_content(input: AutoContinueContentInput): string {
	const max_chars = input.max_chars ?? DEFAULT_AUTO_CONTINUE_MAX_CHARS;

	const parts: string[] = [RESUME_DIRECTIVE];

	const plan_excerpt = input.latest_plan_text?.trim();
	if (plan_excerpt && plan_excerpt.length > 0) {
		parts.push(`Plan draft so far:\n${plan_excerpt}`);
	}

	let result = parts.join("\n\n");

	if (result.length > max_chars) {
		result = truncate_plan_to_budget(result, max_chars);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Internal: budget-aware truncation (plan excerpt only)
// ---------------------------------------------------------------------------

/**
 * Truncate *result* so it fits within *max_chars*.
 *
 * The resume directive (head) is always preserved. The plan excerpt tail is
 * kept and the middle is excised with a truncation marker.
 */
function truncate_plan_to_budget(result: string, max_chars: number): string {
	if (result.length <= max_chars) {
		return result;
	}

	// Always keep the resume directive (first paragraph).
	const directive_end = result.indexOf("\n\n");
	const head = directive_end >= 0 ? result.slice(0, directive_end) : result.slice(0, max_chars);

	// Reserve space for the tail + truncation marker + separators.
	const marker_len = TRUNCATION_MARKER.length;
	const sep_len = 2; // "\n\n"
	const tail_budget = Math.min(
		800,
		Math.floor((max_chars - head.length - marker_len - sep_len * 2) / 2),
	);
	const tail = result.slice(result.length - tail_budget);

	return `${head}\n\n${TRUNCATION_MARKER}\n\n${tail}`;
}
