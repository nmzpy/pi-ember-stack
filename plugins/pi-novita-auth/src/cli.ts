/**
 * Novita login / status / logout helpers.
 *
 * Novita authenticates with a plain API key over the OpenAI-compatible
 * endpoint. `/login novita` prompts for the key and persists it through Pi's
 * OAuth credential plumbing (as OAuthCredentials with `access` = key), so the
 * standard `/login` path gives API-key sign-in without a refresh flow.
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { clear_cached_novita_models, discover_novita_models } from "./catalog.js";
import { NOVITA_PROVIDER_ID } from "./constants.js";

export function resolve_novita_api_key(): string | undefined {
	const env_key = process.env.NOVITA_API_KEY;
	if (env_key) return env_key.trim() || undefined;
	const stored = readStoredCredential(NOVITA_PROVIDER_ID);
	if (stored?.type === "api_key" && stored.key) return stored.key;
	if (stored?.type === "oauth" && stored.access) return stored.access;
	return undefined;
}

export async function login_novita(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const existing = resolve_novita_api_key();
	if (existing) {
		return { access: existing, refresh: existing, expires: 0 };
	}

	callbacks.onProgress?.(
		"Paste your Novita API key (from https://novita.ai → Settings → API Keys).",
	);
	const entered = await callbacks.onPrompt({ message: "Paste your Novita API key:" });
	const key = entered.trim();
	if (!key) throw new Error("Novita API key required — /login novita cancelled.");
	return { access: key, refresh: key, expires: 0 };
}

export async function get_novita_status(api_key?: string): Promise<{
	authenticated: boolean;
	detail: string;
}> {
	if (!api_key) {
		return { authenticated: false, detail: "not signed in — run /login novita" };
	}
	try {
		const models = await discover_novita_models(api_key, { force: true });
		return {
			authenticated: true,
			detail: `authenticated (${models.length} models)`,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { authenticated: false, detail };
	}
}

export async function logout_novita(): Promise<void> {
	clear_cached_novita_models();
}
