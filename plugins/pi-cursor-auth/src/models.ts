import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_API_IDENTIFIER,
	CURSOR_DEFAULT_CONTEXT_WINDOW,
	CURSOR_DEFAULT_MAX_TOKENS,
} from "./constants.js";
import type { DiscoveredCursorModel } from "./cloud-direct/catalog.js";

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} as const;

export function build_cursor_models(
	models: readonly DiscoveredCursorModel[],
): ProviderModelConfig[] {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		api: CURSOR_API_IDENTIFIER,
		reasoning: model.reasoning,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: model.context_window ?? CURSOR_DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.max_tokens ?? CURSOR_DEFAULT_MAX_TOKENS,
	}));
}
