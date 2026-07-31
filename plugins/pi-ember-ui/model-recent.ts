/**
 * Recent-model ranking for the /model picker.
 * Builds a ranked list from per-mode saved bindings, then falls back to the
 * normal catalog ordering. No persistence beyond existing modeModels.
 */

import type { ModelFamily } from "./model-families.ts";
import { family_contains_model } from "./model-families.ts";

type RecentIdentity = {
	readonly provider: string;
	readonly id: string;
};

/**
 * Normalize the per-mode saved model map (modeId → { provider, modelId }) into
 * a list of recent unique identities, most-recent first. A mode's model is
 * considered "more recent" when it appears later in the key iteration.
 */
export function recent_identities_from_mode_models(
	modeModels: Readonly<Partial<Record<string, { readonly provider: string; readonly modelId: string }>>> | undefined,
	currentMode?: string,
): RecentIdentity[] {
	const entries: { mode: string; index: number; identity: RecentIdentity }[] = [];
	let idx = 0;
	for (const [mode, value] of Object.entries(modeModels ?? {})) {
		if (!value || typeof value.provider !== "string" || typeof value.modelId !== "string") {
			continue;
		}
		entries.push({
			mode,
			index: idx++,
			identity: { provider: value.provider, id: value.modelId },
		});
	}
	// The active mode floats to the top; remaining modes are newest-first by
	// insertion order of the object, which JSON parse preserves for explicit keys.
	entries.sort((a, b) => {
		const aCurrent = a.mode === currentMode ? -1 : 0;
		const bCurrent = b.mode === currentMode ? -1 : 0;
		if (aCurrent !== bCurrent) return aCurrent - bCurrent;
		return b.index - a.index;
	});

	const seen = new Set<string>();
	const out: RecentIdentity[] = [];
	for (const { identity } of entries) {
		const key = `${identity.provider.toLowerCase()}/${identity.id.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(identity);
	}
	return out;
}

/**
 * Reorder families so the most recently selected families appear first when the
 * picker has no filter. The current model is handled separately; this keeps the
 * recent list independent of that pin.
 */
export function rank_families_by_recents(
	families: readonly ModelFamily[],
	recent: readonly RecentIdentity[],
): ModelFamily[] {
	const out = [...families];
	const recentFirst = [...recent].reverse();
	const recentKeys = new Set<string>();
	const recentFamilies: ModelFamily[] = [];

	for (const identity of recentFirst) {
		const match = out.find((family) =>
			family_contains_model(family, identity.provider, identity.id),
		);
		if (!match) continue;
		const key = match.key;
		if (recentKeys.has(key)) continue;
		recentKeys.add(key);
		const idx = out.indexOf(match);
		out.splice(idx, 1);
		recentFamilies.push(match);
	}

	return [...recentFamilies, ...out];
}
