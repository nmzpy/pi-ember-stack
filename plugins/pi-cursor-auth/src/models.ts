import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_API_IDENTIFIER,
	CURSOR_DEFAULT_CONTEXT_WINDOW,
	CURSOR_DEFAULT_MAX_TOKENS,
} from "./constants.js";
import type { DiscoveredCursorModel } from "./cli.js";

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
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: CURSOR_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CURSOR_DEFAULT_MAX_TOKENS,
	}));
}
