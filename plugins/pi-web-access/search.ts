import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import type { SearchOptions, SearchResponse } from "./search-types.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export type SearchProvider = "auto" | "openai" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
}

const CONFIG_PATH = getWebSearchConfigPath();

let cached_search_config: { searchProvider: SearchProvider } | null = null;

function get_search_config(): { searchProvider: SearchProvider } {
	if (cached_search_config) return cached_search_config;
	if (!existsSync(CONFIG_PATH)) {
		cached_search_config = { searchProvider: "auto" };
		return cached_search_config;
	}

	const raw_text = readFileSync(CONFIG_PATH, "utf-8");
	let raw: {
		searchProvider?: unknown;
		provider?: unknown;
	};
	try {
		raw = JSON.parse(raw_text) as {
			searchProvider?: unknown;
			provider?: unknown;
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cached_search_config = {
		searchProvider: normalize_search_provider(raw.searchProvider ?? raw.provider),
	};
	return cached_search_config;
}

function normalize_search_provider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	const valid: SearchProvider[] = ["auto", "openai", "exa"];
	return valid.includes(normalized as SearchProvider) ? (normalized as SearchProvider) : "auto";
}

function error_message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function is_abort_error(err: unknown): boolean {
	return error_message(err).toLowerCase().includes("abort");
}

function should_try_openai_in_auto(options: SearchOptions): boolean {
	if (options.recencyFilter) return false;
	if (
		typeof options.numResults === "number" &&
		Number.isFinite(options.numResults) &&
		Math.floor(options.numResults) !== 5
	) {
		return false;
	}
	return true;
}

export async function search(
	query: string,
	options: FullSearchOptions = {},
): Promise<AttributedSearchResponse> {
	const config = get_search_config();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "openai") {
		const result = await searchWithOpenAI(query, options, options.extensionContext);
		return { ...result, provider: "openai" };
	}

	if (provider === "exa") {
		const result = await searchWithExa(query, options);
		if (!result) {
			throw new Error("Exa search returned no results.");
		}
		return { ...result, provider: "exa" };
	}

	const fallback_errors: string[] = [];

	if (should_try_openai_in_auto(options)) {
		try {
			if (await isOpenAISearchAvailable(options.extensionContext)) {
				const result = await searchWithOpenAI(query, options, options.extensionContext);
				return { ...result, provider: "openai" };
			}
		} catch (err) {
			if (is_abort_error(err)) throw err;
			fallback_errors.push(`OpenAI: ${error_message(err)}`);
		}
	}

	if (isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result) return { ...result, provider: "exa" };
		} catch (err) {
			if (is_abort_error(err)) throw err;
			fallback_errors.push(`Exa: ${error_message(err)}`);
		}
	}

	if (fallback_errors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallback_errors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
			"  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
			`  2. Set openaiApiKey or exaApiKey in ${CONFIG_PATH}\n` +
			"  3. Set OPENAI_API_KEY or EXA_API_KEY environment variables",
	);
}
