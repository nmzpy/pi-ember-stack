/**
 * Ember-owned compaction runner — uses vendored prompts from compaction-prompts.ts.
 * Ported from pi-mono packages/coding-agent/src/core/compaction/compaction.ts.
 */
import type { AgentMessage, StreamFn, ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	completeSimple,
	type AssistantMessage,
	type Message,
	type Model,
	type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import {
	compact,
	type CompactionResult,
	type FileOperations,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	merge_split_turn_summaries,
	select_summarization_prompt,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
} from "./compaction-prompts.ts";

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
	const readOnly = Array.from(fileOps.read).filter((f) => !modified.has(f)).sort();
	const modifiedFiles = Array.from(modified).sort();
	return { readFiles: readOnly, modifiedFiles };
}

function format_file_operations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

function create_summarization_options(
	model: Model<any>,
	maxTokens: number,
	auth: StackCompactionAuth,
	signal: AbortSignal | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
): {
	maxTokens: number;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reasoning?: ThinkingLevel;
} {
	const options: {
		maxTokens: number;
		signal?: AbortSignal;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		reasoning?: ThinkingLevel;
	} = {
		maxTokens,
		signal,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
	};
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel as ThinkingLevel;
	}
	return options;
}

async function complete_summarization(
	model: Model<any>,
	context: { systemPrompt: string; messages: Message[] },
	options: ReturnType<typeof create_summarization_options>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
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

async function generate_history_summary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	auth: StackCompactionAuth,
	signal: AbortSignal | undefined,
	previousSummary: string | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = build_history_summarization_prompt(conversationText, previousSummary);
	const summarizationMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: promptText }],
			timestamp: Date.now(),
		},
	];
	const response = await complete_summarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		create_summarization_options(model, maxTokens, auth, signal, thinkingLevel),
		streamFn,
	);
	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}
	return extract_text_content(response);
}

async function generate_turn_prefix_summary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	auth: StackCompactionAuth,
	signal: AbortSignal | undefined,
	thinkingLevel: AgentThinkingLevel | undefined,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: promptText }],
			timestamp: Date.now(),
		},
	];
	const response = await complete_summarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		create_summarization_options(model, maxTokens, auth, signal, thinkingLevel),
		streamFn,
	);
	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}
	return extract_text_content(response);
}

export async function run_stack_compaction(
	preparation: CompactionPreparation,
	model: Model<any>,
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

	let summary: string;
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const historyResult =
			messagesToSummarize.length > 0
				? await generate_history_summary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						auth,
						signal,
						previousSummary,
						thinkingLevel,
						streamFn,
					)
				: (previousSummary ?? "");
		const turnPrefixResult = await generate_turn_prefix_summary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			auth,
			signal,
			thinkingLevel,
			streamFn,
		);
		summary = merge_split_turn_summaries(historyResult, turnPrefixResult);
	} else {
		summary = await generate_history_summary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			auth,
			signal,
			previousSummary,
			thinkingLevel,
			streamFn,
		);
	}

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
