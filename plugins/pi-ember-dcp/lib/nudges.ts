/**
 * System-prompt nudges that encourage the model to call `compress`.
 *
 * Three independent nudge surfaces:
 *   - SOFT / STRONG   appended when usage crosses minContextLimit
 *   - HARD            appended when usage crosses maxContextLimit
 *   - ITERATION       after iterationNudgeThreshold non-user messages
 *
 * Manual mode (config OR runtime) suppresses ALL nudges.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolve_model_limit } from "./config.ts";
import { PROMPTS, type PromptName } from "./prompts/index.ts";
import type { DcpRuntime } from "./runtime.ts";

/**
 * Count non-user messages back to the most recent user message in the branch.
 * Returns 0 if no user message is found within `max_scan` entries.
 */
function messages_since_last_user(
	branch: ReadonlyArray<unknown>,
	max_scan: number,
): number {
	const limit = Math.max(0, Math.min(max_scan, branch.length));
	let count = 0;
	for (
		let i = branch.length - 1, scanned = 0;
		i >= 0 && scanned < limit;
		i--, scanned++
	) {
		const entry = branch[i] as { type?: string; message?: { role?: string } };
		if (entry?.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") return count;
		count++;
	}
	return count;
}

export function make_nudge_handler(runtime: DcpRuntime) {
	return async (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<BeforeAgentStartEventResult | void> => {
		const { config, state, prompts } = runtime;
		if (config.compress.permission === "deny") return;
		if (config.manualMode.enabled || state.manualMode) return;

		state.nudgeFetchCount++;

		const usage = ctx.getContextUsage();
		const window =
			usage?.contextWindow && usage.contextWindow > 0
				? usage.contextWindow
				: undefined;
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		const min_limit = resolve_model_limit(
			config.compress.minContextLimit,
			config.compress.modelMinLimits,
			model,
			window,
		);
		const max_limit = resolve_model_limit(
			config.compress.maxContextLimit,
			config.compress.modelMaxLimits,
			model,
			window,
		);

		// Cache last non-null token count — after compaction usage.tokens is null.
		if (usage?.tokens !== null && usage?.tokens !== undefined) {
			state.lastKnownTokens = usage.tokens;
		}
		const tokens = usage?.tokens ?? state.lastKnownTokens;
		const is_hard = tokens !== null && tokens >= max_limit;
		const is_soft = !is_hard && tokens !== null && tokens >= min_limit;

		let iteration_fired = false;
		if (config.compress.iterationNudgeThreshold > 0) {
			let branch: ReadonlyArray<unknown> = [];
			try {
				branch = ctx.sessionManager.getBranch();
			} catch {
				branch = [];
			}
			const scan_cap = Math.max(64, config.compress.iterationNudgeThreshold * 4);
			const since = messages_since_last_user(branch, scan_cap);
			if (since >= config.compress.iterationNudgeThreshold) {
				if (
					since - state.lastIterationNudgeAt >=
					config.compress.iterationNudgeThreshold
				) {
					state.lastIterationNudgeAt = since;
					iteration_fired = true;
				}
			} else {
				state.lastIterationNudgeAt = 0;
			}
		}

		const parts: PromptName[] = [];

		if (is_soft) {
			const freq = Math.max(1, config.compress.nudgeFrequency);
			const turn_gate = state.turnIndex - state.lastSoftNudgeTurn;
			const every_n = Math.max(1, config.compress.nudgeEveryTurns);
			const fire_soft = state.nudgeFetchCount % freq === 0 && turn_gate >= every_n;
			if (fire_soft) {
				state.lastSoftNudgeTurn = state.turnIndex;
				parts.push(
					config.compress.nudgeForce === "strong"
						? PROMPTS.strongNudge
						: PROMPTS.softNudge,
				);
			}
		}

		if (iteration_fired) parts.push(PROMPTS.iterationNudge);
		if (is_hard) parts.push(PROMPTS.hardNudge);

		if (parts.length === 0) return;

		const base = event.systemPrompt ?? "";
		const addendum = parts.map((p) => prompts.read(p)).join("\n");
		return { systemPrompt: `${base}\n${addendum}` };
	};
}
