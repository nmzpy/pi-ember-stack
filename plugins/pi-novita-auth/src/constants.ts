/** Provider identity and endpoint constants for the Novita OpenAI-compatible provider. */

export const NOVITA_PROVIDER_ID = "novita";
export const NOVITA_PROVIDER_NAME = "Novita";
export const NOVITA_API_IDENTIFIER = "openai-completions" as const;
export const NOVITA_BASE_URL = "https://api.novita.ai/v3/openai";
export const NOVITA_MODELS_URL = "https://api.novita.ai/v3/openai/models";

export const NOVITA_DEFAULT_CONTEXT_WINDOW = 128_000;
export const NOVITA_DEFAULT_MAX_TOKENS = 32_768;

/**
 * Novita reports per-million-token prices as integers in 1/10,000 of a US
 * dollar. Multiply by this factor to get dollars-per-million (e.g. 3900 → 0.39).
 */
export const NOVITA_PRICE_UNIT = 0.0001;

/**
 * Map pi thinking levels to Novita `reasoning_effort` values.
 * Novita exposes reasoning models (deepseek-r1, qwq, qwen3-thinking, …) through
 * the OpenAI-compatible `reasoning_effort` request parameter.
 */
export const NOVITA_REASONING_EFFORT_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
} as const;

/** Id substrings identifying Novita reasoning models (emit `reasoning_content`). */
export const NOVITA_REASONING_ID_MARKERS = [
	"r1",
	"qwq",
	"qvq",
	"qwen3",
	"thinking",
	"glm-z1",
	"hunyuan",
] as const;
