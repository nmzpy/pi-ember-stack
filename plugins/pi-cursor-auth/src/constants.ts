export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_PROVIDER_NAME = "Cursor Subscription";
export const CURSOR_API_IDENTIFIER = "cursor-cloud";
export const CURSOR_PLACEHOLDER_BASE_URL = "https://api2.cursor.sh";

export const CURSOR_DEFAULT_CONTEXT_WINDOW = 200_000;
export const CURSOR_DEFAULT_MAX_TOKENS = 32_000;

/** Cursor model id substrings/regexes that indicate a reasoning model. */
export const CURSOR_REASONING_MODEL_PATTERNS = [
	/thinking/i,
	/o1/i,
	/o3/i,
	/codex/i,
] as const;

export const CURSOR_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
