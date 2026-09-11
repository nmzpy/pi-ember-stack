/**
 * Ember-owned compaction runner — uses vendored prompts from compaction-prompts.ts.
 * Ported from pi-mono packages/coding-agent/src/core/compaction/compaction.ts.
 */
import type {
	AgentMessage,
	StreamFn,
	ThinkingLevel as AgentThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	completeSimple,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import {
	type compact,
	type CompactionResult,
	type FileOperations,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { select_summarization_prompt, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction-prompts.ts";
import { count_tokens, trim_to_token_budget } from "./stack-compaction-tokens.ts";
import { begin_aux_stream, end_aux_stream, note_aux_delta } from "../pi-ember-tps/index.ts";

const PROMPT_SAFETY_TOKENS = 200;

type CompactionPreparation = Parameters<typeof compact>[0];

export type StackCompactionAuth = {
	apiKey: string | undefined;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

function compute_file_lists(fileOps: FileOperations): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = Array.from(fileOps.read)
		.filter((f) => !modified.has(f))
		.sort();
	const modifiedFiles = Array.from(modified).sort();
	return { readFiles: readOnly, modifiedFiles };
}

function format_file_operations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`### Read files\n${readFiles.map((f) => `- ${f}`).join("\n")}`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`### Modified files\n${modifiedFiles.map((f) => `- ${f}`).join("\n")}`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

function create_summarization_options(
	model: Model<Api>,
	auth: StackCompactionAuth,
	signal: AbortSignal | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
): {
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reasoning?: ThinkingLevel;
} {
	// No explicit output cap: the request omits the field unless the model
	// declares its own limit, which is the only ceiling Ember accepts.
	const maxTokens = summarization_max_output_tokens(model);
	const options: {
		maxTokens?: number;
		signal?: AbortSignal;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		reasoning?: ThinkingLevel;
	} = {
		signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	if (maxTokens !== undefined) {
		options.maxTokens = maxTokens;
	}
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel as ThinkingLevel;
	}
	return options;
}

async function complete_summarization(
	model: Model<Api>,
	context: { systemPrompt: string; messages: Message[] },
	options: ReturnType<typeof create_summarization_options>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Drive the shared TPS meter so the footer shows the summarizer's live
	// output rate. The summarization call emits no transcript `message_*`
	// events, so the streaming branch observes the deltas directly. The meter
	// is render-free — the footer reads it on the 20 FPS renders the compaction
	// status indicator already triggers via the shared gradient clock.
	begin_aux_stream();
	try {
		if (!streamFn) {
			// Legacy Pi (no ModelRuntime facade to stream through): the deltas are
			// unavailable, so no live TPS for this summarization.
			return await completeSimple(model, context, options);
		}
		const stream = await streamFn(model, context, options);
		// Consume the stream so every delta reaches the meter. The final result
		// promise is resolved by the terminal event (done/error) or by `end()`,
		// independently of iteration, so `result()` still resolves — iterating is
		// non-destructive here and avoids an unbounded unread event queue.
		for await (const evt of stream) {
			if (evt.type === "text_delta") note_aux_delta(evt.delta, false);
			else if (evt.type === "thinking_delta") note_aux_delta(evt.delta, true);
		}
		return await stream.result();
	} finally {
		end_aux_stream();
	}
}

function extract_text_content(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function build_history_summarization_prompt(
	conversationText: string,
	previousSummary?: string,
): string {
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += select_summarization_prompt(previousSummary);
	return promptText;
}

export function trim_llm_messages_for_summary(
	messages: AgentMessage[],
	model: Model<Api>,
	responseMaxTokens: number,
	emptyConversationPromptText: string,
): Message[] {
	const llmMessages = convertToLlm(messages);
	const systemTokens = count_tokens(SUMMARIZATION_SYSTEM_PROMPT);
	const fixedTokens = count_tokens(emptyConversationPromptText);

	// The summarizer must see the ENTIRE history being discarded — that is the
	// whole point of the checkpoint. Pi's trigger math (compact when
	// context > window - reserve) guarantees the full history fits the model
	// window, so the default is to send everything untrimmed, exactly like Pi
	// native compact(). The trim below is only a last-resort guard for
	// pathological cases (estimator drift, tiny windows) and keeps the OLDEST
	// messages — the discarded history — never the recent tail, which is
	// retained verbatim after the cut point anyway.
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const promptTokenBudget =
		contextWindow - responseMaxTokens - PROMPT_SAFETY_TOKENS - systemTokens - fixedTokens;
	if (!Number.isFinite(promptTokenBudget) || promptTokenBudget <= 0) {
		// Unknown or degenerate window: send everything and let the provider
		// fail loudly rather than silently produce an empty summary.
		return llmMessages;
	}
	return trim_to_token_budget(llmMessages, promptTokenBudget, serializeConversation, {
		keepHead: true,
	});
}

/**
 * Output cap for the summarization request.
 *
 * Ember never imposes an output cap of its own and never caps the summarizer
 * below the model's own output limit. Pi's vendored formula
 * (`min(0.8 * reserveTokens, model.maxTokens)`) stops generation mid-section on
 * a long history: the checkpoint loses `## Next Steps` / `## Critical
 * Context`. `undefined` means "no explicit cap" — the request omits the field
 * and the provider applies its own default (never `Infinity`, which would
 * serialize to JSON `null` in an OpenAI-compatible body).
 */
export function summarization_max_output_tokens(model: Model<Api>): number | undefined {
	return model.maxTokens > 0 ? model.maxTokens : undefined;
}

/**
 * Output room reserved while budgeting the summarizer's INPUT. This is never
 * the request cap (see `summarization_max_output_tokens`): it only decides how
 * much discarded history fits, and matches the allowance Pi native compact()
 * used so the summarizer still sees the same history.
 */
export function summarization_output_reserve_tokens(model: Model<Api>, reserveTokens: number): number {
	const pi_allowance = Math.floor(0.8 * reserveTokens);
	const model_cap = summarization_max_output_tokens(model);
	return model_cap === undefined ? pi_allowance : Math.min(pi_allowance, model_cap);
}

/**
 * Failure message for a summarization response that must not become a
 * checkpoint. `generate_history_summary` only consults this AFTER the
 * continuation budget is used up (or a pass added no text): a `length` stop
 * carries partial text, so it is resumed first and never persisted truncated
 * (same contract as Pi's own compaction).
 */
export function summarization_failure(response: AssistantMessage): string | undefined {
	if (response.stopReason === "error") {
		return `Summarization failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return "Summarization failed: generation hit the token cap and the summary is incomplete";
	}
	return undefined;
}

/**
 * Continuation passes allowed after the summarizer is cut off by the model's
 * output limit. The checkpoint is a long structured document and the provider
 * clamps the request to the model's own output ceiling (pi-ai's window clamp
 * can shrink it further), so one generation window is not always enough.
 */
export const SUMMARIZATION_CONTINUE_MAX = 5;

/**
 * Prompt for a continuation pass. Only the partial checkpoint is resent — the
 * discarded history is already folded into it — so the continuation keeps the
 * maximum possible output room.
 */
export const SUMMARIZATION_CONTINUE_PROMPT =
	"Your checkpoint was cut off by the model's output token cap. Continue it from the exact point where it stopped. Do not repeat text you already wrote, do not restart or re-title a section, and do not comment on being cut off — resume the current section mid-stream as if the limit never happened.";

async function generate_history_summary(
	messages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	auth: StackCompactionAuth,
	signal: AbortSignal | undefined,
	previousSummary: string | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
	streamFn?: StreamFn,
): Promise<string> {
	const llmMessages = trim_llm_messages_for_summary(
		messages,
		model,
		summarization_output_reserve_tokens(model, reserveTokens),
		build_history_summarization_prompt("", previousSummary),
	);
	const conversationText = serializeConversation(llmMessages);
	const options = create_summarization_options(model, auth, signal, thinkingLevel);
	// The checkpoint is unbounded output: a `length` stop is resumed with a
	// continuation pass instead of failing /compact. Only an exhausted budget (or
	// a pass that adds nothing) reaches `summarization_failure`, so a truncated
	// checkpoint is still never persisted.
	let summary = "";
	let summarizationMessages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: build_history_summarization_prompt(conversationText, previousSummary) },
			],
			timestamp: Date.now(),
		},
	];
	for (let pass = 0; ; pass++) {
		const response = await complete_summarization(
			model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
			options,
			streamFn,
		);
		const text = extract_text_content(response);
		summary += text;
		const truncated = response.stopReason === "length";
		if (!truncated || pass >= SUMMARIZATION_CONTINUE_MAX || text.trim().length === 0) {
			const failure = summarization_failure(response);
			if (failure) {
				throw new Error(failure);
			}
			return summary;
		}
		// Drop the discarded history: the partial checkpoint carries it, and a
		// small context leaves the continuation the largest available output room.
		summarizationMessages = [
			// Reuse the response's own message metadata: only role/content matter
			// to a provider, and carrying the real assistant turn keeps the
			// continuation a valid `Message` without fabricating usage/stopReason.
			{ ...response, content: [{ type: "text", text: summary }] },
			{
				role: "user",
				content: [{ type: "text", text: SUMMARIZATION_CONTINUE_PROMPT }],
				timestamp: Date.now(),
			},
		];
	}
}

export async function run_stack_compaction(
	preparation: CompactionPreparation,
	model: Model<Api>,
	auth: StackCompactionAuth,
	signal?: AbortSignal,
	thinkingLevel?: AgentThinkingLevel,
	streamFn?: StreamFn,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Single summary pass. Pi's native split-turn concept (a second LLM call
	// producing a "Turn Context (split turn) / Original Request" block) adds no
	// value: our structured checkpoint's ## Progress / ## Next Steps already
	// tells the model what's left to do. Fold any turn-prefix messages into
	// the main pass so one Ember summary covers everything — no duplicate
	// call, no split-turn block, never fall back to Pi's compact().
	const summaryMessages =
		isSplitTurn && turnPrefixMessages.length > 0
			? [...messagesToSummarize, ...turnPrefixMessages]
			: messagesToSummarize;

	let summary = await generate_history_summary(
		summaryMessages,
		model,
		settings.reserveTokens,
		auth,
		signal,
		previousSummary,
		thinkingLevel,
		streamFn,
	);

	const { readFiles, modifiedFiles } = compute_file_lists(fileOps);
	summary += format_file_operations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles },
	};
}
