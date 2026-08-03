/**
 * CrofAI model catalog + usage discovery.
 *
 * The `/v1/models` endpoint is OpenAI-compatible and public (no auth required),
 * but we still pass the bearer token when one is available so the catalog can
 * be refreshed after login. `/usage_api/` requires the token.
 */
import { CROF_MODELS_URL, CROF_USAGE_URL } from "./constants.js";

export interface CrofModelPricing {
	prompt?: string;
	completion?: string;
	cache_prompt?: string;
}

export interface CrofModelInfo {
	id: string;
	name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	reasoning_effort?: boolean;
	custom_reasoning?: boolean;
	pricing?: CrofModelPricing;
}

export interface CrofModelsResponse {
	data: CrofModelInfo[];
}

export interface CrofUsage {
	usable_requests: number | null;
	credits: number | null;
}

let cached_models: readonly CrofModelInfo[] | null = null;

const FETCH_TIMEOUT_MS = 15_000;

async function crof_fetch(url: string, api_key?: string): Promise<Response> {
	return fetch(url, {
		headers: api_key ? { Authorization: `Bearer ${api_key}` } : undefined,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
}

async function error_text(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.trim().slice(0, 200) || res.statusText;
	} catch {
		return res.statusText;
	}
}

export async function discover_crof_models(
	api_key?: string,
	options: { force?: boolean } = {},
): Promise<readonly CrofModelInfo[]> {
	if (!options.force && cached_models) return cached_models;

	const res = await crof_fetch(CROF_MODELS_URL, api_key);
	if (!res.ok) {
		throw new Error(`CrofAI /v1/models failed: ${res.status} ${await error_text(res)}`);
	}
	const payload = (await res.json()) as CrofModelsResponse;
	const models = Array.isArray(payload.data) ? payload.data : [];

	// Only pin the cache on a successful, non-empty response.
	if (models.length > 0) cached_models = models;
	return models;
}

export async function discover_crof_models_with_key(
	api_key: string,
	options: { force?: boolean } = {},
): Promise<readonly CrofModelInfo[]> {
	return discover_crof_models(api_key, options);
}

export async function fetch_crof_usage(api_key: string): Promise<CrofUsage> {
	const res = await crof_fetch(CROF_USAGE_URL, api_key);
	if (!res.ok) {
		throw new Error(`CrofAI /usage_api/ failed: ${res.status} ${await error_text(res)}`);
	}
	const data = (await res.json()) as {
		usable_requests?: number | null;
		credits?: number | null;
	};
	return {
		usable_requests: typeof data.usable_requests === "number" ? data.usable_requests : null,
		credits: typeof data.credits === "number" ? data.credits : null,
	};
}

export function clear_cached_crof_models(): void {
	cached_models = null;
}
