/**
 * SSOT transient-transport classification and retry policy.
 *
 * One canonical classifier, retry budget, backoff schedule, and abort-aware
 * generic retry helper. The subagent runner and future transport consumers
 * (e.g. webtools) import from this module — no second retry/backoff
 * implementation or duplicate classifier may exist elsewhere.
 *
 * ## Classification
 *
 * `is_transient_transport_death(error)` traverses Error.cause chains and
 * error codes to detect:
 *  - WebSocket-class transport errors (socket reset / hang up / websocket)
 *  - Raw `fetch failed` (Node `TypeError` hiding a cause code)
 *  - Common Node/Bun network codes (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`,
 *    `ENOTFOUND`, `EAI_AGAIN`) and messages (socket hangup/reset, network
 *    request failed)
 *  - Parser stream closures (provider closed the SSE stream early)
 *  - Provider transient internal errors ("an internal error occurred")
 *  - pi-ai's resolved OpenAI-compat finish reason `network_error`
 *    ("Provider finish_reason: network_error")
 *  - Aggregator/gateway upstream-outage envelopes (`"type":"server_error"` +
 *    "Upstream request failed" body)
 *  - Explicit abort phrases (safe because decision functions gate
 *    abort/timeout BEFORE classification)
 *  - Bare process/stream terminal form `Terminated` (and unambiguous
 *    SIGTERM/SIGKILL process-exit wording)
 *
 * It does NOT treat ordinary provider/model errors (401, 403, 429, billing,
 * invalid model, permission-denied) as retryable.
 */

// ---------------------------------------------------------------------------
// Retry constants — the one authority
// ---------------------------------------------------------------------------

/** Maximum transient-transport retry attempts shared by all consumers. */
export const MAX_TRANSPORT_RETRIES = 5;

/** Abortable backoff schedule (ms) indexed by retry attempt. */
export const TRANSPORT_RETRY_BACKOFF_MS = [2000, 5000, 10_000, 30_000, 60_000] as const;
// ---------------------------------------------------------------------------
// Sub-predicates
// ---------------------------------------------------------------------------

const WEBSOCKET_PATTERNS: readonly RegExp[] = [
	/websocket/i,
	/socket hang up/i,
	/ECONNRESET/i,
	/connection was reset/i,
];

function is_websocket_error(message: string | undefined): boolean {
	if (!message) return false;
	return WEBSOCKET_PATTERNS.some((pattern) => pattern.test(message));
}

const GENERIC_ABORT_PHRASES = [
	"this operation was aborted",
	"the operation was aborted",
	"request was aborted",
	"request aborted",
	"the signal was aborted",
	"operation was aborted",
	"operation aborted",
];

/** True for a generic abort/empty message. */
export function isGenericAbortMessage(message: string | undefined): boolean {
	if (!message) return true;
	const lower = message.toLowerCase();
	return (
		GENERIC_ABORT_PHRASES.some((phrase) => lower.includes(phrase)) ||
		lower === "aborted" ||
		lower === "abort"
	);
}

/**
 * True when the message is one of pi-ai's generic stream-parser failures
 * ("Stream ended without finish_reason", "<provider> stream ended without a
 * terminal event", "Anthropic stream ended before message_stop", "OpenAI
 * Responses stream ended before a terminal response event").
 */
export function is_parser_stream_error(message: string | undefined): boolean {
	if (!message) return false;
	return (
		/stream ended without finish_reason/i.test(message) ||
		/stream ended without a terminal event/i.test(message) ||
		/stream ended before message_stop/i.test(message) ||
		/stream ended before a terminal response event/i.test(message)
	);
}

const PROVIDER_INTERNAL_ERROR_PATTERNS: readonly RegExp[] = [/^an internal error occurred/i];

/** True for a raw provider-side internal-error message (transient 500-class). */
function is_provider_internal_error(message: string | undefined): boolean {
	if (!message) return false;
	return PROVIDER_INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const NO_BODY_5XX_PATTERNS: readonly RegExp[] = [
	/^503 status code \(no body\)$/,
	/^GetChatMessage HTTP 503:\s*$/,
];

/** True for an empty-body 503 (service unavailable) from the provider.
 *  Safe to replay because there is no actionable body to distinguish a
 *  temporary outage from a permanent one; all other 5xx with bodies remain
 *  non-retryable.
 */
function is_transient_5xx_no_body_error(message: string | undefined): boolean {
	if (!message) return false;
	const trimmed = message.trim();
	return NO_BODY_5XX_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * pi-ai's OpenAI-compatible stream resolves an upstream terminal
 * `finish_reason: "network_error"` event into the assistant error
 * "Provider finish_reason: network_error". The provider itself reported a
 * transport-class connection death, so this is transient even though no raw
 * socket Error object reaches us.
 */
const PROVIDER_FINISH_NETWORK_ERROR_RE = /^provider finish_reason:\s*network_error$/i;

/** True for pi-ai's resolved `Provider finish_reason: network_error` form. */
function is_provider_network_finish_reason(message: string | undefined): boolean {
	if (!message) return false;
	return PROVIDER_FINISH_NETWORK_ERROR_RE.test(message.trim());
}

/**
 * Aggregator/gateway upstream-outage envelope: a JSON body reporting
 * `"type":"server_error"` together with an "Upstream request failed"
 * message. Some aggregators surface a dead upstream as HTTP 4xx with a
 * misleading "[1210] Invalid API parameter" note inside that envelope.
 * BOTH markers are required, so ordinary client-side 400 validation errors
 * never match.
 */
function is_upstream_server_error(message: string | undefined): boolean {
	if (!message) return false;
	return /"type"\s*:\s*"server_error"/i.test(message) && /upstream request failed/i.test(message);
}

// ---------------------------------------------------------------------------
// Network / fetch-failed / process-terminated patterns
// ---------------------------------------------------------------------------

/**
 * Common Node/Bun network error codes that indicate a transient transport
 * failure. Checked against `Error.code` and also matched case-insensitively
 * inside error messages.
 */
const NETWORK_ERROR_CODES: readonly string[] = [
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ECONNABORTED",
];

const NETWORK_MESSAGE_PATTERNS: readonly RegExp[] = [
	/fetch failed/i,
	/network request failed/i,
	/socket hang up/i,
	/socket reset/i,
	/connection reset/i,
	/connection refused/i,
	/connection timed out/i,
	/connection terminated/i,
	/network error/i,
];

/** Bare process/stream terminal forms. */
const PROCESS_TERMINATED_PATTERNS: readonly RegExp[] = [
	/^terminated$/i,
	/sigterm/i,
	/sigkill/i,
	/process terminated/i,
	/process exited/i,
];

function is_network_error_message(message: string | undefined): boolean {
	if (!message) return false;
	return NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function is_process_terminated_message(message: string | undefined): boolean {
	if (!message) return false;
	return PROCESS_TERMINATED_PATTERNS.some((pattern) => pattern.test(message));
}

function has_network_error_code(error: unknown): boolean {
	if (error === null || error === undefined) return false;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") {
		return NETWORK_ERROR_CODES.includes(code.toUpperCase());
	}
	return false;
}

// ---------------------------------------------------------------------------
// Cause-chain traversal
// ---------------------------------------------------------------------------

const MAX_CAUSE_CHAIN_DEPTH = 8;

/** Generic wrappers (aborts and parser-stream failures) add no provider detail. */
function is_wrapper_generic(message: string | undefined): boolean {
	return isGenericAbortMessage(message) || is_parser_stream_error(message);
}

/**
 * Extract the most useful failure message from a thrown error. Walks the full
 * Error.cause chain root-cause-first: a specific (non-generic, non-parser)
 * message anywhere in the chain wins, so a real provider/transport error
 * buried under a generic wrapper surfaces instead of the wrapper. When the
 * whole chain is generic, keeps the outermost Error text (never degrades to a
 * stringified non-Error cause).
 */
export function extractFailureMessage(error: unknown): string {
	if (error === null || error === undefined) return "Unknown error";
	const chain: unknown[] = [];
	let current: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CAUSE_CHAIN_DEPTH && current !== null && current !== undefined;
		depth++
	) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	for (let i = chain.length - 1; i >= 0; i--) {
		const node = chain[i];
		if (node instanceof Error && node.message && !is_wrapper_generic(node.message)) {
			return node.message;
		}
	}
	for (const node of chain) {
		if (node instanceof Error && node.message) return node.message;
	}
	if (!(error instanceof Error)) return String(error);
	return "Unknown error";
}

/**
 * Traverse an Error.cause chain and check whether any node carries a
 * transient network error code (`ECONNRESET`, `ECONNREFUSED`, …). Node's
 * `TypeError('fetch failed')` frequently hides a cause with a useful code.
 */
function chain_has_network_code(error: unknown): boolean {
	let current: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CAUSE_CHAIN_DEPTH && current !== null && current !== undefined;
		depth++
	) {
		if (has_network_error_code(current)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Traverse an Error.cause chain and check whether any node's message matches
 * a transient transport pattern. This catches cases where the outer error is
 * a generic wrapper (e.g. `TypeError: fetch failed`) but an inner cause
 * carries a specific transport message (e.g. `socket hang up`).
 */
function chain_has_transient_message(error: unknown): boolean {
	let current: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CAUSE_CHAIN_DEPTH && current !== null && current !== undefined;
		depth++
	) {
		if (current instanceof Error && current.message) {
			const msg = current.message;
			if (
				is_websocket_error(msg) ||
				is_network_error_message(msg) ||
				is_process_terminated_message(msg) ||
				is_parser_stream_error(msg) ||
				is_provider_internal_error(msg) ||
				is_provider_network_finish_reason(msg) ||
				is_upstream_server_error(msg)
			) {
				return true;
			}
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

// ---------------------------------------------------------------------------
// SSOT classifier
// ---------------------------------------------------------------------------

/**
 * SSOT predicate for a transient transport death. Accepts either a string
 * message or a thrown Error (traverses `.cause` chains and `.code` fields).
 *
 * A failure is retry-eligible when it matches any of:
 *  - WebSocket-class transport error (socket reset / hang up / websocket)
 *  - Raw `fetch failed` or common network message patterns
 *  - Node/Bun network error codes (`ECONNRESET`, `ECONNREFUSED`, …) on any
 *    cause-chain node
 *  - Parser stream closure (provider closed the SSE stream early)
 *  - Provider transient internal error ("an internal error occurred")
 *  - pi-ai's resolved OpenAI-compat finish reason `network_error`
 *  - Aggregator/gateway upstream-outage envelope (`"type":"server_error"` +
 *    "Upstream request failed")
 *  - Explicit abort phrase (safe — decision functions gate abort/timeout first)
 *  - Bare process/stream terminal form (`Terminated`, SIGTERM, SIGKILL)
 *
 * Empty/undefined messages are NOT transport deaths.
 * Ordinary provider/model errors (401, 403, 429, billing, invalid model,
 * permission-denied) are NOT retryable.
 */
export function is_transient_transport_death(error: unknown): boolean {
	if (error === null || error === undefined) return false;

	// Fast path: string message
	if (typeof error === "string") {
		return classify_message_transient(error);
	}

	// Error object: check message, code, and full cause chain
	const message = error instanceof Error ? error.message : undefined;
	if (message && classify_message_transient(message)) return true;
	if (has_network_error_code(error)) return true;
	if (chain_has_network_code(error)) return true;
	if (chain_has_transient_message(error)) return true;

	return false;
}

/** Classify a plain string message as transient transport death. */
function classify_message_transient(message: string): boolean {
	if (!message) return false;
	return (
		is_websocket_error(message) ||
		is_network_error_message(message) ||
		is_process_terminated_message(message) ||
		is_parser_stream_error(message) ||
		isGenericAbortMessage(message) ||
		is_provider_internal_error(message) ||
		is_transient_5xx_no_body_error(message) ||
		is_provider_network_finish_reason(message) ||
		is_upstream_server_error(message)
	);
}

// ---------------------------------------------------------------------------
// Backoff helper
// ---------------------------------------------------------------------------

/** Backoff (ms) for the given retry attempt index, or 0 when exhausted. */
export function transport_retry_backoff_ms(retry: number): number {
	return TRANSPORT_RETRY_BACKOFF_MS[retry] ?? 0;
}

/**
 * Abortable sleep: resolves after `ms` or rejects immediately when `signal`
 * aborts. Used by the retry helper and re-exported for runner-specific
 * backoff paths that need the same semantics.
 */
export async function sleep_abortable(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("Operation aborted"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// Abort-aware generic retry helper
// ---------------------------------------------------------------------------

/**
 * Retry a transient-transport operation with the canonical budget and backoff.
 *
 * Calls `operation(attempt)` up to `MAX_TRANSPORT_RETRIES + 1` times (initial
 * attempt + retries). Only errors classified by `is_transient_transport_death`
 * are retried; all other errors propagate immediately. Aborts (via `signal`)
 * propagate immediately without consuming a retry slot.
 *
 * The `shouldRetry` option lets callers add a post-classification gate
 * (e.g. the runner's pre-response vs mid-stream distinction). When provided
 * and returning `false`, the error propagates without retry.
 *
 * @param operation - async function receiving the 0-based attempt index
 * @param signal - abort signal; abort propagates immediately
 * @param shouldRetry - optional extra gate after transient classification
 * @param backoffMs - optional override for the per-attempt backoff (testing)
 * @returns the resolved value of `operation`
 */
export async function retry_transient_transport_operation<T>(
	operation: (attempt: number) => Promise<T>,
	options: {
		signal?: AbortSignal;
		shouldRetry?: (error: unknown, attempt: number) => boolean;
		backoffMs?: number;
	},
): Promise<T> {
	const { signal, shouldRetry, backoffMs } = options;
	let last_error: unknown;
	for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
		if (signal?.aborted) throw last_error ?? new Error("Operation aborted");
		try {
			return await operation(attempt);
		} catch (error) {
			last_error = error;
			if (signal?.aborted) throw error;
			if (!is_transient_transport_death(error)) throw error;
			if (shouldRetry && !shouldRetry(error, attempt)) throw error;
			if (attempt >= MAX_TRANSPORT_RETRIES) throw error;
			const backoff = backoffMs ?? transport_retry_backoff_ms(attempt);
			if (backoff > 0) {
				try {
					await sleep_abortable(backoff, signal);
				} catch {
					// Aborted during backoff
					throw error;
				}
			}
		}
	}
	throw last_error;
}
