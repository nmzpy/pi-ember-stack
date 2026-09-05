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
	opts?: { keepHead?: boolean },
): T[] {
	if (!Number.isFinite(budget) || budget <= 0 || items.length === 0) {
		return [];
	}
	const full = serialize(items);
	if (count_tokens(full) <= budget) {
		return items;
	}
	// Default keeps the TAIL (most recent items). keepHead keeps the HEAD
	// (oldest items) — the summarizer needs the discarded history, not the
	// recent tail that is retained verbatim after the cut point.
	let lo = 1;
	let hi = items.length;
	let best = 0;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const slice = opts?.keepHead ? items.slice(0, mid) : items.slice(items.length - mid);
		const text = serialize(slice);
		const tokens = count_tokens(text);
		if (tokens <= budget) {
			best = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best > 0 ? (opts?.keepHead ? items.slice(0, best) : items.slice(items.length - best)) : [];
}
