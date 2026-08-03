/**
 * Minimal token accounting for Ember-owned compaction.
 *
 * DCP was removed from the stack; this keeps the same conservative
 * ~4-chars-per-token estimate the compaction runner relied on.
 */

function char_fallback(text: string): number {
	return Math.ceil(text.length / 4);
}

export function count_tokens(text: string): number {
	if (!text) return 0;
	return char_fallback(text);
}

export function estimate_tokens_batch(texts: string[]): number {
	if (texts.length === 0) return 0;
	return count_tokens(texts.join(" "));
}

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
