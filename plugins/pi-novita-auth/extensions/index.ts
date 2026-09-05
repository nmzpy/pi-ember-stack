/**
 * pi-novita-auth — Novita provider for Pi.
 *
 * Novita is an OpenAI-compatible API (`https://api.novita.ai/v3/openai`), so the
 * built-in `openai-completions` stream handles chat, tool calls, structured
 * outputs, and extended thinking (`reasoning_content`) natively. Auth is a
 * plain API key; `/login novita` prompts for it through Pi's standard OAuth
 * credential plumbing and Pi resolves `getApiKey` → `Authorization: Bearer <key>`.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { clear_cached_novita_models, discover_novita_models } from "../src/catalog.js";
import {
	get_novita_status,
	login_novita,
	logout_novita,
	resolve_novita_api_key,
} from "../src/cli.js";
import { NOVITA_BASE_URL, NOVITA_PROVIDER_ID, NOVITA_PROVIDER_NAME } from "../src/constants.js";
import { build_novita_models } from "../src/models.js";

let active_pi: ExtensionAPI | null = null;

async function prime_catalog_from_stored_auth(): Promise<ProviderModelConfig[]> {
	const api_key = resolve_novita_api_key();
	if (!api_key) return [];
	try {
		const models = await discover_novita_models(api_key);
		return build_novita_models(models);
	} catch {
		return [];
	}
}

function register_novita_provider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(NOVITA_PROVIDER_ID, {
		name: NOVITA_PROVIDER_NAME,
		baseUrl: NOVITA_BASE_URL,
		api: "openai-completions",
		models,
		oauth: {
			name: "Novita (API key)",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const credentials = await login_novita(callbacks);
				if (active_pi) {
					clear_cached_novita_models();
					try {
						const discovered = await discover_novita_models(credentials.access, {
							force: true,
						});
						register_novita_provider(active_pi, build_novita_models(discovered));
					} catch {
						// keep current catalog
					}
				}
				return credentials;
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				// API keys don't expire; return unchanged.
				return credentials;
			},
			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},
	});
}

export default async function pi_novita_auth(pi: ExtensionAPI): Promise<void> {
	active_pi = pi;

	register_novita_provider(pi, []);
	const primed = await prime_catalog_from_stored_auth();
	if (primed.length > 0) register_novita_provider(pi, primed);

	pi.on("session_start", async (_event, ctx) => {
		active_pi = pi;
		try {
			// Cover /login and catalog-TTL expiry by re-priming each session.
			const api_key = await ctx.modelRegistry.getApiKeyForProvider(NOVITA_PROVIDER_ID);
			const key = api_key ?? resolve_novita_api_key();
			if (key && active_pi) {
				const models = await discover_novita_models(key);
				if (models.length > 0) register_novita_provider(active_pi, build_novita_models(models));
			}
		} catch {
			// keep current catalog
		}
	});

	pi.registerCommand("novita-status", {
		description: "Show Novita authentication and catalog status",
		handler: async (_args, ctx) => {
			try {
				const api_key = resolve_novita_api_key();
				const status = await get_novita_status(api_key);
				ctx.ui.notify(`Novita: ${status.detail}`, status.authenticated ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`Novita: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("novita-refresh-models", {
		description: "Refresh models available through Novita",
		handler: async (_args, ctx) => {
			try {
				const api_key = resolve_novita_api_key();
				if (!api_key) {
					ctx.ui.notify("Novita: not signed in. Run /login novita", "warning");
					return;
				}
				clear_cached_novita_models();
				const discovered = await discover_novita_models(api_key, { force: true });
				const models = build_novita_models(discovered);
				register_novita_provider(pi, models);
				ctx.ui.notify(`Novita: refreshed ${models.length} models.`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Novita model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("novita-logout", {
		description: "Log out of Novita and clear cached catalog state",
		handler: async (_args, ctx) => {
			try {
				await logout_novita();
				const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
				const model_runtime = await ModelRuntime.create();
				await model_runtime.logout(NOVITA_PROVIDER_ID);
				ctx.ui.notify("Novita: logged out.", "info");
			} catch (error) {
				ctx.ui.notify(
					`Novita logout failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", () => {
		clear_cached_novita_models();
		active_pi = null;
	});
}

// Re-export for tests / import compatibility.
export { resolve_novita_api_key };
