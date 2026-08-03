/**
 * pi-crof-auth — CrofAI provider for Pi.
 *
 * CrofAI is an OpenAI-compatible API (`https://crof.ai/v1`), so the built-in
 * `openai-completions` stream handles chat, tool calls, structured outputs, and
 * `reasoning_content` (extended thinking) natively. Auth is a plain API key;
 * `/login crof` prompts for it through Pi's standard OAuth credential plumbing
 * and Pi resolves `getApiKey` → `Authorization: Bearer <key>`.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	clear_cached_crof_models,
	discover_crof_models,
	fetch_crof_usage,
} from "../src/catalog.js";
import { get_crof_status, login_crof, logout_crof, resolve_crof_api_key } from "../src/cli.js";
import { CROF_BASE_URL, CROF_PROVIDER_ID, CROF_PROVIDER_NAME } from "../src/constants.js";
import { build_crof_models } from "../src/models.js";

let active_pi: ExtensionAPI | null = null;

async function prime_catalog_from_stored_auth(): Promise<ProviderModelConfig[]> {
	const api_key = resolve_crof_api_key();
	if (!api_key) return [];
	try {
		const models = await discover_crof_models(api_key);
		return build_crof_models(models);
	} catch {
		return [];
	}
}

function register_crof_provider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(CROF_PROVIDER_ID, {
		name: CROF_PROVIDER_NAME,
		baseUrl: CROF_BASE_URL,
		api: "openai-completions",
		models,
		oauth: {
			name: "CrofAI (API key)",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const credentials = await login_crof(callbacks);
				if (active_pi) {
					clear_cached_crof_models();
					try {
						const discovered = await discover_crof_models(credentials.access, {
							force: true,
						});
						register_crof_provider(active_pi, build_crof_models(discovered));
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

export default async function pi_crof_auth(pi: ExtensionAPI): Promise<void> {
	active_pi = pi;

	register_crof_provider(pi, []);
	const primed = await prime_catalog_from_stored_auth();
	if (primed.length > 0) register_crof_provider(pi, primed);

	pi.on("session_start", async (_event, ctx) => {
		active_pi = pi;
		try {
			// Cover /login and catalog-TTL expiry by re-priming each session.
			const api_key = await ctx.modelRegistry.getApiKeyForProvider(CROF_PROVIDER_ID);
			const key = api_key ?? resolve_crof_api_key();
			if (key && active_pi) {
				const models = await discover_crof_models(key);
				if (models.length > 0) register_crof_provider(active_pi, build_crof_models(models));
			}
		} catch {
			// keep current catalog
		}
	});

	pi.registerCommand("crof-status", {
		description: "Show CrofAI authentication and catalog status",
		handler: async (_args, ctx) => {
			try {
				const api_key = resolve_crof_api_key();
				const status = await get_crof_status(api_key);
				ctx.ui.notify(`CrofAI: ${status.detail}`, status.authenticated ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(`CrofAI: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("crof-refresh-models", {
		description: "Refresh models available through CrofAI",
		handler: async (_args, ctx) => {
			try {
				const api_key = resolve_crof_api_key();
				if (!api_key) {
					ctx.ui.notify("CrofAI: not signed in. Run /login crof", "warning");
					return;
				}
				clear_cached_crof_models();
				const discovered = await discover_crof_models(api_key, { force: true });
				const models = build_crof_models(discovered);
				register_crof_provider(pi, models);
				ctx.ui.notify(`CrofAI: refreshed ${models.length} models.`, "info");
			} catch (error) {
				ctx.ui.notify(
					`CrofAI model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("crof-usage", {
		description: "Show your CrofAI remaining requests and credit balance",
		handler: async (_args, ctx) => {
			try {
				const api_key = resolve_crof_api_key();
				if (!api_key) {
					ctx.ui.notify("CrofAI: not signed in. Run /login crof", "warning");
					return;
				}
				const usage = await fetch_crof_usage(api_key);
				const parts: string[] = [];
				if (usage.usable_requests !== null) parts.push(`${usage.usable_requests} requests left`);
				if (usage.credits !== null) parts.push(`$${usage.credits.toFixed(2)} credits`);
				const detail = parts.length > 0 ? parts.join(" · ") : "no usage reported";
				ctx.ui.notify(`CrofAI: ${detail}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`CrofAI usage failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("crof-logout", {
		description: "Log out of CrofAI and clear cached catalog state",
		handler: async (_args, ctx) => {
			try {
				await logout_crof();
				const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
				const model_runtime = await ModelRuntime.create();
				await model_runtime.logout(CROF_PROVIDER_ID);
				ctx.ui.notify("CrofAI: logged out.", "info");
			} catch (error) {
				ctx.ui.notify(
					`CrofAI logout failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", () => {
		clear_cached_crof_models();
		active_pi = null;
	});
}

// Re-export for tests / import compatibility.
export { resolve_crof_api_key };
