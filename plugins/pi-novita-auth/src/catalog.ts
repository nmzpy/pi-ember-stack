/**
 * Novita model catalog discovery.
 *
 * The OpenAI-compatible `/v3/openai/models` endpoint returns an array of model
 * objects with `id`, `title`, `description`, `context_size`, and per-million
 * token prices (`input_token_price_per_m` / `output_token_price_per_m`). We
 * pass the bearer token when available so the catalog can be refreshed after
 * login. The result is cached; `clear_cached_novita_models()` resets it on
 * login/refresh/logout.
 */
import { NOVITA_MODELS_URL } from "./constants.js";

export interface NovitaModelInfo {
	id: string;
	title?: string;
	description?: string;
	context_size?: number;
	input_token_price_per_m?: number;
	output_token_price_per_m?: number;
}

export interface NovitaModelsResponse {
	data: NovitaModelInfo[];
}

let cached_models: readonly NovitaModelInfo[] | null = null;

const FETCH_TIMEOUT_MS = 15_000;

async function novita_fetch(url: string, api_key?: string): Promise<Response> {
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

export async function discover_novita_models(
	api_key?: string,
	options: { force?: boolean } = {},
): Promise<readonly NovitaModelInfo[]> {
	if (!options.force && cached_models) return cached_models;

	const res = await novita_fetch(NOVITA_MODELS_URL, api_key);
	if (!res.ok) {
		throw new Error(`Novita /v3/openai/models failed: ${res.status} ${await error_text(res)}`);
	}
	const payload = (await res.json()) as NovitaModelsResponse;
	const models = Array.isArray(payload.data) ? payload.data : [];

	// Only pin the cache on a successful, non-empty response.
	if (models.length > 0) cached_models = models;
	return models;
}

export async function discover_novita_models_with_key(
	api_key: string,
	options: { force?: boolean } = {},
): Promise<readonly NovitaModelInfo[]> {
	return discover_novita_models(api_key, options);
}

export function clear_cached_novita_models(): void {
	cached_models = null;
}
