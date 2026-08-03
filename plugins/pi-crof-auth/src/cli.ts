/**
 * CrofAI login / status / logout helpers.
 *
 * CrofAI authenticates with a plain API key over the OpenAI-compatible
 * endpoint. `/login crof` prompts for the key and persists it through Pi's
 * OAuth credential plumbing (as OAuthCredentials with `access` = key), so the
 * standard `/login` path gives API-key sign-in without a refresh flow.
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { clear_cached_crof_models, discover_crof_models, fetch_crof_usage } from "./catalog.js";
import { CROF_PROVIDER_ID } from "./constants.js";

export function resolve_crof_api_key(): string | undefined {
	const env_key = process.env.CROF_API_KEY ?? process.env.CROFAI_API_KEY;
	if (env_key) return env_key.trim() || undefined;
	const stored = readStoredCredential(CROF_PROVIDER_ID);
	if (stored?.type === "api_key" && stored.key) return stored.key;
	if (stored?.type === "oauth" && stored.access) return stored.access;
	return undefined;
}

export async function login_crof(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const existing = resolve_crof_api_key();
	if (existing) {
		return { access: existing, refresh: existing, expires: 0 };
	}

	callbacks.onProgress?.("Paste your CrofAI API key (from https://crof.ai → Settings).");
	const entered = await callbacks.onPrompt({ message: "Paste your CrofAI API key:" });
	const key = entered.trim();
	if (!key) throw new Error("CrofAI API key required — /login crof cancelled.");
	return { access: key, refresh: key, expires: 0 };
}

export async function get_crof_status(api_key?: string): Promise<{
	authenticated: boolean;
	detail: string;
}> {
	if (!api_key) {
		return { authenticated: false, detail: "not signed in — run /login crof" };
	}
	try {
		const models = await discover_crof_models(api_key, { force: true });
		let usage_suffix = "";
		try {
			const usage = await fetch_crof_usage(api_key);
			const parts: string[] = [];
			if (usage.usable_requests !== null) parts.push(`${usage.usable_requests} requests left`);
			if (usage.credits !== null) parts.push(`$${usage.credits.toFixed(2)} credits`);
			if (parts.length > 0) usage_suffix = ` · ${parts.join(" · ")}`;
		} catch {
			// Usage probe is optional; status still reports auth + catalog.
		}
		return {
			authenticated: true,
			detail: `authenticated (${models.length} models)${usage_suffix}`,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { authenticated: false, detail };
	}
}

export async function logout_crof(): Promise<void> {
	clear_cached_crof_models();
}
