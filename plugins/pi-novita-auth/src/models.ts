import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { NovitaModelInfo } from "./catalog.js";
import {
	NOVITA_API_IDENTIFIER,
	NOVITA_DEFAULT_CONTEXT_WINDOW,
	NOVITA_DEFAULT_MAX_TOKENS,
	NOVITA_PRICE_UNIT,
	NOVITA_REASONING_EFFORT_MAP,
	NOVITA_REASONING_ID_MARKERS,
} from "./constants.js";

// Novita prices are integers in 1/10,000 USD per million tokens.
function parse_cost(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return value * NOVITA_PRICE_UNIT;
}

function is_reasoning_model(info: NovitaModelInfo): boolean {
	const id = info.id.toLowerCase();
	return NOVITA_REASONING_ID_MARKERS.some((marker) => id.includes(marker));
}

export function build_novita_models(models: readonly NovitaModelInfo[]): ProviderModelConfig[] {
	return models.map((model) => {
		const reasoning = is_reasoning_model(model);
		const contextWindow = model.context_size ?? NOVITA_DEFAULT_CONTEXT_WINDOW;
		return {
			id: model.id,
			name: model.title ?? model.id,
			api: NOVITA_API_IDENTIFIER,
			reasoning,
			...(reasoning ? { thinkingLevelMap: NOVITA_REASONING_EFFORT_MAP } : {}),
			input: ["text"],
			cost: {
				input: parse_cost(model.input_token_price_per_m),
				output: parse_cost(model.output_token_price_per_m),
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow,
			maxTokens: Math.min(contextWindow, NOVITA_DEFAULT_MAX_TOKENS),
			...(reasoning
				? {
						compat: {
							supportsReasoningEffort: true,
							maxTokensField: "max_tokens",
						},
					}
				: {}),
		};
	});
}

export const __test_only = { parse_cost, is_reasoning_model };
