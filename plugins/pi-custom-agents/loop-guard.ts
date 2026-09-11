/**
 * Repeated Tool-Call Guard — pure logic (SSOT).
 *
 * The guard tracks consecutive identical tool-call signatures within a single
 * agent run.  On the first detection (3 consecutive identical calls) it
 * auto-injects the hidden ``pi-agents-loop-retry`` message so the model gets
 * one automatic nudge to break out of the loop.  The signature that triggered
 * the retry is recorded in ``retried_loop_signatures`` so that a *persisting*
 * loop is caught immediately (threshold 1) on the next turn, at which point
 * the user-facing quiz is shown.
 *
 * ``retried_loop_signatures`` is **not** cleared by ``reset_run_state`` (which
 * runs on ``agent_start``) — it persists across turns within a session and is
 * only cleared by ``reset_session_state`` (``session_shutdown``) or when the
 * user chooses "End stream" in the quiz.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopGuardState {
	/** Current consecutive count for the active signature. */
	count: number;
	/** The active signature string. */
	signature: string | undefined;
	/** True once the threshold has been reached and the run was aborted. */
	detected: boolean;
	/** Prevents re-entrancy while the quiz / retry message is in flight. */
	prompt_active: boolean;
	/** Signatures that already triggered an auto-retry this session. */
	retried_signatures: Set<string>;
}

export const LOOP_TOOL_CALL_LIMIT = 3;
export const PERSISTENT_LOOP_THRESHOLD = 1;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function create_loop_guard_state(): LoopGuardState {
	return {
		count: 0,
		signature: undefined,
		detected: false,
		prompt_active: false,
		retried_signatures: new Set<string>(),
	};
}

// ---------------------------------------------------------------------------
// Serialization helpers (must match index.ts stable_serialize)
// ---------------------------------------------------------------------------

export function stable_serialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stable_serialize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stable_serialize(entry)}`)
		.join(",")}}`;
}

export function tool_call_signature(tool_name: string, input: unknown): string {
	return `${tool_name}:${stable_serialize(input)}`;
}

// ---------------------------------------------------------------------------
// Per-run reset (agent_start)
// ---------------------------------------------------------------------------

/**
 * Resets per-run tracking state.  Does **not** clear
 * ``retried_signatures`` — those persist across turns so a retry turn that
 * repeats the same signature is caught at threshold 1.
 */
export function reset_run_state(state: LoopGuardState): void {
	state.count = 0;
	state.signature = undefined;
	state.detected = false;
}

// ---------------------------------------------------------------------------
// Full session reset (session_shutdown)
// ---------------------------------------------------------------------------

export function reset_session_state(state: LoopGuardState): void {
	reset_run_state(state);
	state.prompt_active = false;
	state.retried_signatures.clear();
}

// ---------------------------------------------------------------------------
// Tool-call evaluation
// ---------------------------------------------------------------------------

export type LoopDetectionResult = {
	/** The tool call should be blocked. */
	block: boolean;
	/** True when the guard has just tripped (threshold reached). */
	tripped: boolean;
	/** ``"first"`` — first detection, auto-retry.  ``"persistent"`` — repeat, show quiz. */
	kind: "first" | "persistent" | undefined;
	/** Human-readable block reason (when ``block`` is true). */
	reason?: string;
};

/**
 * Evaluates an incoming tool call against the loop guard.
 *
 * - If the guard already tripped this run (``detected`` or ``prompt_active``),
 *   the call is blocked unconditionally.
 * - If the signature matches the active signature, the counter increments.
 * - If the signature is already in ``retried_signatures`` the threshold is
 *   ``PERSISTENT_LOOP_THRESHOLD`` (1); otherwise it is
 *   ``LOOP_TOOL_CALL_LIMIT`` (3).
 * - On trip, ``detected`` is set true and the result indicates whether this
 *   is a first detection or a persistent repeat.
 */
export function evaluate_tool_call(
	state: LoopGuardState,
	tool_name: string,
	input: unknown,
): LoopDetectionResult {
	if (state.detected || state.prompt_active) {
		return {
			block: true,
			tripped: false,
			kind: undefined,
			reason: "Tool loop detected; blocking further tool calls.",
		};
	}

	const sig = tool_call_signature(tool_name, input);

	if (sig === state.signature) {
		state.count++;
	} else {
		state.signature = sig;
		state.count = 1;
	}

	const is_persistent = state.retried_signatures.has(sig);
	const threshold = is_persistent ? PERSISTENT_LOOP_THRESHOLD : LOOP_TOOL_CALL_LIMIT;

	if (state.count >= threshold) {
		state.detected = true;
		return {
			block: true,
			tripped: true,
			kind: is_persistent ? "persistent" : "first",
			reason: `Tool '${tool_name}' has been called ${state.count} times with identical arguments.`,
		};
	}

	return { block: false, tripped: false, kind: undefined };
}

// ---------------------------------------------------------------------------
// Agent-settled resolution
// ---------------------------------------------------------------------------

export type LoopSettledAction =
	| { type: "auto_retry"; signature: string | undefined }
	| { type: "show_quiz"; signature: string | undefined }
	| { type: "none"; signature: undefined };

/**
 * Determines what to do when the agent settles after a loop detection.
 *
 * - First detection: record the signature in ``retried_signatures``, reset
 *   the per-run counter, and return ``auto_retry``.
 * - Persistent detection: return ``show_quiz``.
 * - No detection: return ``none``.
 */
export function resolve_settled_action(state: LoopGuardState): LoopSettledAction {
	if (!state.detected || state.prompt_active) {
		return { type: "none", signature: undefined };
	}

	const sig = state.signature;

	if (sig && state.retried_signatures.has(sig)) {
		return { type: "show_quiz", signature: sig };
	}

	// First detection: record the signature so the next repeat is caught fast.
	if (sig) {
		state.retried_signatures.add(sig);
	}
	reset_run_state(state);
	return { type: "auto_retry", signature: sig };
}

// ---------------------------------------------------------------------------
// Retry message content (SSOT)
// ---------------------------------------------------------------------------

/**
 * Builds the hidden ``pi-agents-loop-retry`` message content injected on
 * auto-retry and on a manual quiz Retry.  The message names the looping tool
 * (parsed out of the ``tool_name:{…}`` signature when available) and gives
 * the model a concrete escape route: stop repeating the call, take a
 * different approach, and say so if it is stuck — a bare "call a different
 * tool" reads as "call any other tool" and the model often just resumes
 * the same loop.
 */
export function build_loop_retry_content(signature: string | undefined): string {
	const tool_name = signature ? signature.split(":", 1)[0] : undefined;
	const subject = tool_name ? `the '${tool_name}' tool` : "that tool";
	return (
		`You are stuck in a loop: you have called ${subject} repeatedly with identical ` +
		"arguments and it is not making progress. Do NOT call it again with the same " +
		"arguments. Stop, reconsider your approach, and either use a different tool, " +
		"different arguments, or answer the user directly with what you have. If you " +
		'are blocked, say so instead of retrying.'
	);
}
// ---------------------------------------------------------------------------
// Quiz outcome handling
// ---------------------------------------------------------------------------

/**
 * Applies the user's quiz choice to the guard state.
 *
 * - ``end``: removes the signature from ``retried_signatures`` and resets.
 * - ``retry`` / ``custom``: keeps the signature so the next repeat is still
 *   caught at threshold 1, and resets per-run state.
 */
export function apply_quiz_outcome(
	state: LoopGuardState,
	action: "end" | "retry" | "custom",
	signature: string | undefined,
): void {
	if (action === "end" && signature) {
		state.retried_signatures.delete(signature);
	}
	reset_run_state(state);
	state.prompt_active = false;
}
