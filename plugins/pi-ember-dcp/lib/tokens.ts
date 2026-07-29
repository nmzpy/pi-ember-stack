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

/**
 * Trim a suffix of `items` (newest at the end) so `serialize(items.slice)` fits
 * inside `budget` tokens. We keep the latest items and drop oldest-first.
 *
 * Returns the largest suffix that fits; if even one item exceeds the budget
 * an empty array is returned so the caller can decide how to proceed.
 */
export function trim_to_token_budget<T>(
	items: T[],
	budget: number,
	serialize: (slice: T[]) => string,
): T[] {
	if (!Number.isFinite(budget) || budget <= 0 || items.length === 0) {
		return [];
	}
	const full = serialize(items);
	if (count_tokens(full) <= budget) {
		return items;
	}
	let lo = 1;
	let hi = items.length;
	let best = 0;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const start = items.length - mid;
		const text = serialize(items.slice(start));
		const tokens = count_tokens(text);
		if (tokens <= budget) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best > 0 ? items.slice(items.length - best) : [];
}
