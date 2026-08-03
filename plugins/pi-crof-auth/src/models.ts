import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { CrofModelInfo } from "./catalog.js";
import {
	CROF_API_IDENTIFIER,
	CROF_DEFAULT_CONTEXT_WINDOW,
	CROF_DEFAULT_MAX_TOKENS,
	CROF_REASONING_EFFORT_MAP,
} from "./constants.js";

// CrofAI returns cost per million tokens as decimal strings (e.g. "0.80" = $0.80/M).
function parse_cost(value: string | undefined): number {
	if (!value) return 0;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

export function build_crof_models(models: readonly CrofModelInfo[]): ProviderModelConfig[] {
	return models.map((model) => {
		const reasoning = model.reasoning_effort === true || model.custom_reasoning === true;
		return {
			id: model.id,
			name: model.name ?? model.id,
			api: CROF_API_IDENTIFIER,
			reasoning,
			...(reasoning ? { thinkingLevelMap: CROF_REASONING_EFFORT_MAP } : {}),
			input: ["text"],
			cost: {
				input: parse_cost(model.pricing?.prompt),
				output: parse_cost(model.pricing?.completion),
				cacheRead: parse_cost(model.pricing?.cache_prompt),
				cacheWrite: 0,
			},
			contextWindow: model.context_length ?? CROF_DEFAULT_CONTEXT_WINDOW,
			maxTokens: model.max_completion_tokens ?? CROF_DEFAULT_MAX_TOKENS,
			compat: {
				// CrofAI lists `max_tokens` (not `max_completion_tokens`) as a supported
				// parameter and supports `reasoning_effort` for reasoning models.
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		};
	});
}

export const __test_only = { parse_cost };
