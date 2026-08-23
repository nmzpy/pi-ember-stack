/**
 * SSOT for provider failures that are safe to treat as transient UI noise.
 *
 * These are the failures Pi/provider retry paths can recover from. They are
 * kept visible only while they are the current attempt; once a newer
 * assistant attempt exists, the old error-only row is removed from the live
 * component output. Auth, validation, model-selection, and other client
 * errors intentionally do not match this predicate.
 */
const TRANSIENT_PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
	/\b429\b/i,
	/\b5\d{2}\b/i,
	/5xx/i,
	/resource[\s_-]*exhausted/i,
	/too[\s_-]+many[\s_-]+requests/i,
	/rate[\s_-]*limit(?:ed|ing)?/i,
	/quota[\s_-]+(?:exceeded|exhausted)/i,
	/throttl(?:ed|ing)?/i,
	/temporarily[\s_-]+unavailable/i,
	/service[\s_-]+unavailable/i,
	/internal[\s_-]+server[\s_-]+error/i,
	/bad[\s_-]+gateway/i,
	/gateway[\s_-]+timeout/i,
	/try[\s_-]+again[\s_-]+later/i,
	/over[\s_-]+capacity/i,
	/overloaded/i,
];

export function is_transient_provider_error(error_message: string | undefined): boolean {
	if (!error_message?.trim()) return false;
	return TRANSIENT_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(error_message));
}
