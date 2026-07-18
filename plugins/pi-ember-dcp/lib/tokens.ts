/**
 * Approximate token accounting for DCP pipeline stats and placeholders.
 *
 * Upstream `@davecodes/pi-dcp@0.2.0` depends on `@anthropic-ai/tokenizer`.
 * This Ember-owned adaptation intentionally avoids that runtime dependency
 * and uses a conservative ~4-chars-per-token estimate instead. Counts are
 * used only for budgeting, nudge thresholds (via Pi context usage when
 * available), and savings stats — not for billing-critical metering.
 */

function char_fallback(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Estimate tokens in a string via the conservative char heuristic. */
export function count_tokens(text: string): number {
	if (!text) return 0;
	return char_fallback(text);
}

/**
 * Estimate tokens for a batch of texts. Joining is close enough for
 * budgeting and avoids N separate passes.
 */
export function estimate_tokens_batch(texts: string[]): number {
	if (texts.length === 0) return 0;
	return count_tokens(texts.join(" "));
}

/** Alias used by messages.ts and strategies. */
export function approx_tokens(text: string): number {
	return count_tokens(text);
}
