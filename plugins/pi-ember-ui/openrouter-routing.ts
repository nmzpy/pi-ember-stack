/**
 * OpenRouter upstream-provider routing — SSOT.
 *
 * OpenRouter is a marketplace: a single model id (e.g. `anthropic/claude-haiku-4.5`)
 * is served by multiple upstream providers (Anthropic, Google Vertex, Azure, Amazon
 * Bedrock, …), each with its own pricing, latency, and region. OpenRouter's
 * `provider` request field (`compat.openRouterRouting`) lets a request pin one or
 * order several of these upstreams. Pi sends `model.compat.openRouterRouting`
 * as-is in the request body, so a provider choice has to be baked into the model
 * entry's `compat` to take effect — there is no per-request routing argument on
 * `pi.setModel`.
 *
 * This module owns:
 * - parsing an OpenRouter model id into the `author/slug` path used by the
 *   `/api/v1/models/{author}/{slug}/endpoints` endpoint
 * - fetching and normalizing the live endpoint list (provider slug, display name,
 *   pricing, quantization) for a model
 * - building the `OpenRouterRouting` config for a chosen upstream
 * - cloning a registry `Model` with the routing applied to its `compat`
 * - the per-mode persisted provider preference (stored alongside `ModelIdentity`)
 *
 * Network access is the only async surface; everything else is pure and
 * side-effect free so it can be unit-tested without a live OpenRouter key.
 */

import type { Api, Model, OpenRouterRouting } from "@earendil-works/pi-ai";

/** Sentinel for "let OpenRouter pick the best upstream" (no routing override). */
export const OPENROUTER_PROVIDER_AUTO = "__auto__";

const OPENROUTER_ENDPOINTS_BASE = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 12_000;

/** One upstream provider serving an OpenRouter model. */
export interface OpenRouterUpstream {
	/** Provider slug used in `openRouterRouting.only`/`order` (e.g. `anthropic`, `amazon-bedrock/us`). */
	tag: string;
	/** Human-readable provider name from the endpoints response (e.g. `Anthropic`, `Amazon Bedrock`). */
	providerName: string;
	/** Quantization label (e.g. `fp16`, `bf16`, `unknown`). */
	quantization?: string;
	/** Per-token prompt price (USD per token, as OpenRouter reports it). */
	promptPrice?: string;
	/** Per-token completion price (USD per token, as OpenRouter reports it). */
	completionPrice?: string;
}

/** Minimal shape of the OpenRouter `/endpoints` response we consume. */
interface OpenRouterEndpointRaw {
	tag?: string;
	provider_name?: string;
	quantization?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
	};
}

interface OpenRouterEndpointsResponse {
	data?: {
		endpoints?: OpenRouterEndpointRaw[];
	};
}

/**
 * Split an OpenRouter model id into the `{author}/{slug}` path the endpoints
 * endpoint expects. OpenRouter ids are always `author/slug` with optional
 * `:variant` suffixes (`:free`, `:nitro`, `:batch`, …) that are part of the id
 * and accepted by the endpoints URL. The first slash is the author boundary;
 * everything after it (including further slashes, though OpenRouter does not
 * use them today) is the slug. Returns `undefined` for ids without a slash.
 */
export function openrouter_endpoints_path(modelId: string): string | undefined {
	const trimmed = modelId.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0) return undefined;
	const author = trimmed.slice(0, slashIndex).trim();
	const slug = trimmed.slice(slashIndex + 1).trim();
	if (!author || !slug) return undefined;
	return `${author}/${slug}`;
}

/** True when a registry model is served by the OpenRouter marketplace provider. */
export function is_openrouter_model(model: { provider?: string } | undefined | null): boolean {
	return !!model && model.provider === "openrouter";
}

function normalize_upstream(raw: OpenRouterEndpointRaw): OpenRouterUpstream | undefined {
	const tag = raw.tag?.trim();
	if (!tag) return undefined;
	return {
		tag,
		providerName: raw.provider_name?.trim() || tag,
		quantization: raw.quantization?.trim() || undefined,
		promptPrice: raw.pricing?.prompt?.trim() || undefined,
		completionPrice: raw.pricing?.completion?.trim() || undefined,
	};
}

/** Deduplicate upstreams by tag, keeping the first occurrence (stable order). */
function dedupe_upstreams(upstreams: OpenRouterUpstream[]): OpenRouterUpstream[] {
	const seen = new Set<string>();
	const out: OpenRouterUpstream[] = [];
	for (const upstream of upstreams) {
		if (seen.has(upstream.tag)) continue;
		seen.add(upstream.tag);
		out.push(upstream);
	}
	return out;
}

/**
 * Fetch the live upstream providers for an OpenRouter model id.
 * Returns an empty array when the model has no `author/slug` path, the network
 * call fails, or the response carries no endpoints. Never throws — caller
 * treats an empty result as "no provider choice available, use Auto".
 *
 * The OpenRouter API key is optional for the public endpoints endpoint; when
 * supplied it is sent as a bearer token so private/account-scoped models
 * resolve too.
 */
export async function fetch_openrouter_upstreams(
	modelId: string,
	options?: { apiKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<OpenRouterUpstream[]> {
	const path = openrouter_endpoints_path(modelId);
	if (!path) return [];
	const url = `${OPENROUTER_ENDPOINTS_BASE}/${encodeURIComponent_author_slash(path)}/endpoints`;
	const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
	const signal = options?.signal;
	try {
		const response = await fetchImpl(url, {
			headers: options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
			signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return [];
		const json = (await response.json()) as OpenRouterEndpointsResponse;
		const endpoints = json?.data?.endpoints ?? [];
		const upstreams = endpoints
			.map(normalize_upstream)
			.filter((u): u is OpenRouterUpstream => u !== undefined);
		return dedupe_upstreams(upstreams);
	} catch {
		return [];
	}
}

/**
 * `encodeURIComponent` would encode the `/` in `author/slug`; the endpoints
 * path needs the slash literal. Encode each segment independently instead.
 */
function encodeURIComponent_author_slash(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

/**
 * Build the `OpenRouterRouting` config that pins a request to a single upstream
 * provider. `only` is used (with `allow_fallbacks: false`) so OpenRouter does
 * not silently fall back to a different upstream if the chosen one is
 * unavailable — the upstream error surfaces instead, which is what an explicit
 * provider choice should produce. Returns `undefined` for the Auto sentinel
 * (no routing override).
 */
export function build_openrouter_routing(providerTag: string): OpenRouterRouting | undefined {
	if (!providerTag || providerTag === OPENROUTER_PROVIDER_AUTO) return undefined;
	return {
		only: [providerTag],
		allow_fallbacks: false,
	};
}

/**
 * Clone a registry `Model` with an OpenRouter upstream routing preference
 * applied to its `compat.openRouterRouting`. Returns the original model when
 * the routing is `undefined` (Auto) so no-op selections never churn the
 * registry reference. The clone is shallow except for `compat`, which is
 * shallow-merged so existing compat fields are preserved.
 */
export function apply_openrouter_routing<TApi extends Api>(
	model: Model<TApi>,
	routing: OpenRouterRouting | undefined,
): Model<TApi> {
	if (!routing) return model;
	const existingCompat = (model.compat ?? {}) as Record<string, unknown>;
	const merged = { ...existingCompat, openRouterRouting: routing } as Model<TApi>["compat"];
	return { ...model, compat: merged };
}

/**
 * Format an upstream as a single-line picker label: `ProviderName  tag  $prompt/$completion`.
 * Prices are OpenRouter's per-token USD strings, shown verbatim when present.
 * The Auto option is formatted separately by the caller.
 */
export function format_upstream_label(upstream: OpenRouterUpstream): string {
	const parts: string[] = [upstream.providerName];
	if (upstream.tag !== upstream.providerName) parts.push(`(${upstream.tag})`);
	const priceParts: string[] = [];
	if (upstream.promptPrice) priceParts.push(`in ${upstream.promptPrice}`);
	if (upstream.completionPrice) priceParts.push(`out ${upstream.completionPrice}`);
	if (priceParts.length > 0) parts.push(priceParts.join(" "));
	if (upstream.quantization && upstream.quantization !== "unknown") {
		parts.push(upstream.quantization);
	}
	return parts.join("  ");
}

/**
 * Resolve the OpenRouter API key for the endpoints fetch. Reads the live
 * registry's stored credential for the `openrouter` provider. Returns
 * `undefined` when no key is available (the endpoints endpoint is public for
 * most models, so this is a best-effort enrichment).
 */
export async function resolve_openrouter_api_key(
	modelRegistry: {
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	} | undefined,
): Promise<string | undefined> {
	try {
		return (await modelRegistry?.getApiKeyForProvider?.("openrouter")) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Read the persisted per-mode OpenRouter provider preference, if any. */
export function get_mode_openrouter_provider(
	modeModels: Readonly<Partial<Record<string, { openRouterProvider?: string }>>>,
	modeId: string | undefined,
): string | undefined {
	if (!modeId) return undefined;
	const entry = modeModels[modeId];
	if (!entry) return undefined;
	const tag = entry.openRouterProvider;
	return typeof tag === "string" && tag ? tag : undefined;
}

/**
 * Read the upstream provider slug currently baked into a live model's
 * `compat.openRouterRouting.only`. Returns `undefined` when the model has no
 * routing override (Auto) or is not an OpenRouter model. This is the live
 * counterpart to the persisted `ModelIdentity.openRouterProvider`.
 */
export function live_openrouter_provider(model: { provider?: string; compat?: unknown } | undefined): string | undefined {
	if (!is_openrouter_model(model)) return undefined;
	const compat = (model?.compat ?? {}) as { openRouterRouting?: OpenRouterRouting };
	const routing = compat.openRouterRouting;
	const only = routing?.only;
	if (!Array.isArray(only) || only.length === 0) return undefined;
	const tag = typeof only[0] === "string" ? only[0].trim() : undefined;
	return tag && tag !== OPENROUTER_PROVIDER_AUTO ? tag : undefined;
}
