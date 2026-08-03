/** Provider identity and endpoint constants for the CrofAI OpenAI-compatible provider. */

export const CROF_PROVIDER_ID = "crof";
export const CROF_PROVIDER_NAME = "CrofAI";
export const CROF_API_IDENTIFIER = "openai-completions" as const;
export const CROF_BASE_URL = "https://crof.ai/v1";
export const CROF_MODELS_URL = "https://crof.ai/v1/models";
export const CROF_USAGE_URL = "https://crof.ai/usage_api/";

export const CROF_DEFAULT_CONTEXT_WINDOW = 200_000;
export const CROF_DEFAULT_MAX_TOKENS = 32_000;

/**
 * Map pi thinking levels to CrofAI `reasoning_effort` values.
 * CrofAI accepts "low" | "medium" | "high" | "none" (see crof.ai/docs).
 */
export const CROF_REASONING_EFFORT_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
} as const;
