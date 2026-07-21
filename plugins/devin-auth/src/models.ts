/**
 * Model list for the Devin (Cognition) provider.
 *
 * Fully live-catalog driven. {@link buildLiveModels} pulls every model from
 * Cognition's `GetCascadeModelConfigs` catalog and surfaces it directly —
 * no hardcoded family list, no hardcoded pricing/metadata. The catalog's
 * `label` is used as the display name (with optional overrides below).
 *
 * Before login (or if the catalog fetch fails) we return an empty list so
 * pi shows no models until the live catalog arrives.
 */

import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import type { CacheEntry } from './cloud-direct/index.js';

/** Default Cognition/Codeium host. */
const DEFAULT_HOST = 'https://server.codeium.com';

/**
 * Per-family variant allow-list. If a family prefix is present, only UIDs
 * whose suffix (the part after `prefix-`) is in the set are kept. A UID that
 * exactly equals the prefix is always allowed (suffix = empty string).
 *
 * Families not listed here keep all variants.
 */
const VARIANT_ALLOW: Map<string, Set<string>> = new Map([
    ['glm-5-2', new Set(['high', 'max'])],
]);

function matchesVariantFilter(uid: string): boolean {
    let bestPrefix: string | null = null;
    for (const prefix of VARIANT_ALLOW.keys()) {
        if (uid === prefix || uid.startsWith(`${prefix}-`) || uid.startsWith(`${prefix}_`)) {
            if (bestPrefix === null || prefix.length > bestPrefix.length) {
                bestPrefix = prefix;
            }
        }
    }
    if (bestPrefix === null) return true;
    if (uid === bestPrefix) return true;
    const suffix = uid.slice(bestPrefix.length + 1);
    return VARIANT_ALLOW.get(bestPrefix)?.has(suffix) ?? false;
}

/** Display-name overrides for catalog UIDs whose live label is undesired. */
const NAME_OVERRIDES = new Map<string, string>([
    ['glm-5-2', 'GLM-5.2'],
]);

/**
 * Build the model list from a live catalog response.
 *
 * Surfaces every non-disabled model the catalog returns, applying the variant
 * filter and name overrides above. Returns an empty array before login or
 * when the catalog fetch fails — pi will show no models until the live list
 * arrives.
 */
export function buildLiveModels(catalog: CacheEntry | null): ProviderModelConfig[] {
    if (!catalog || catalog.byUid.size === 0) {
        return [];
    }

    const models: ProviderModelConfig[] = [];
    for (const entry of catalog.byUid.values()) {
        if (entry.disabled) continue;
        if (!matchesVariantFilter(entry.modelUid)) continue;
        const name = NAME_OVERRIDES.get(entry.modelUid) ?? entry.label ?? entry.modelUid;
        models.push({
            id: entry.modelUid,
            name,
            reasoning: true,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256_000,
            maxTokens: 128_000,
        });
    }

    return models;
}

export { DEFAULT_HOST };
