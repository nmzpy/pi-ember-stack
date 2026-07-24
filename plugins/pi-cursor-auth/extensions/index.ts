import {
	type ExtensionAPI,
	ModelRuntime,
	type ProviderModelConfig,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	CURSOR_API_IDENTIFIER,
	CURSOR_PLACEHOLDER_BASE_URL,
	CURSOR_PROVIDER_ID,
	CURSOR_PROVIDER_NAME,
} from "../src/constants.js";
import {
	discover_cursor_models_with_token,
	get_cursor_status,
	login_cursor,
	logout_cursor,
	ensure_fresh_cursor_credentials,
} from "../src/cli.js";
import { build_cursor_models } from "../src/models.js";
import {
	clear_all_conversation_states,
	clear_cached_cursor_models,
} from "../src/cloud-direct/index.js";
import {
	reset_cursor_session,
	set_cursor_pi_mode,
	set_cursor_session_key,
	get_cursor_session_key,
	set_cursor_workspace_path,
	stream_cursor,
} from "../src/stream.js";
import { clear_conversation_state } from "../src/cloud-direct/session.js";

let active_pi: ExtensionAPI | null = null;

async function prime_catalog_from_stored_auth(): Promise<ProviderModelConfig[]> {
	if (!active_pi) return [];
	try {
		const credential = readStoredCredential(CURSOR_PROVIDER_ID);
		if (credential?.type !== "oauth" || !credential.access) return [];
		const fresh = await ensure_fresh_cursor_credentials(credential);
		const models = await discover_cursor_models_with_token(fresh.access);
		return build_cursor_models(models);
	} catch {
		return [];
	}
}

function register_cursor_provider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(CURSOR_PROVIDER_ID, {
		name: CURSOR_PROVIDER_NAME,
		baseUrl: CURSOR_PLACEHOLDER_BASE_URL,
		api: CURSOR_API_IDENTIFIER,
		models,
		streamSimple: stream_cursor,
		oauth: {
			name: "Cursor subscription (browser login)",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				const credentials = await login_cursor(callbacks);
				if (active_pi) {
					clear_cached_cursor_models();
					const discovered = await discover_cursor_models_with_token(credentials.access, {
						force: true,
					});
					register_cursor_provider(active_pi, build_cursor_models(discovered));
				}
				return credentials;
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return ensure_fresh_cursor_credentials(credentials);
			},
			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},
		},
	});
}

export default async function pi_cursor_auth(pi: ExtensionAPI): Promise<void> {
	active_pi = pi;

	const abort_rejection_handler = (reason: unknown): void => {
		const reason_name =
			typeof reason === "object" && reason !== null
				? (reason as { name?: unknown }).name
				: undefined;
		if (reason_name === "AbortError") return;
		queueMicrotask(() => {
			throw reason;
		});
	};
	process.on("unhandledRejection", abort_rejection_handler);

	register_cursor_provider(pi, []);
	const primed = await prime_catalog_from_stored_auth();
	if (primed.length > 0) register_cursor_provider(pi, primed);

	pi.on("session_start", async (event, ctx) => {
		active_pi = pi;
		const session_id = ctx.sessionManager.getSessionId?.() ?? ctx.cwd ?? "default";
		set_cursor_session_key(session_id);
		set_cursor_workspace_path(ctx.cwd);
		if (event.reason === "fork" || event.reason === "new" || event.reason === "startup") {
			reset_cursor_session();
			clear_all_conversation_states();
		} else if (event.reason === "resume") {
			reset_cursor_session();
		}

		try {
			const api_key = await ctx.modelRegistry.getApiKeyForProvider(CURSOR_PROVIDER_ID);
			if (api_key && active_pi) {
				const models = await discover_cursor_models_with_token(api_key);
				register_cursor_provider(active_pi, build_cursor_models(models));
			}
		} catch {
			// keep current catalog
		}
	});

	pi.events.on("pi-ember-ui:mode-change", (event: unknown) => {
		const mode_event = event as { mode?: string } | undefined;
		set_cursor_pi_mode(typeof mode_event?.mode === "string" ? mode_event.mode : undefined);
	});

	pi.registerCommand("cursor-status", {
		description: "Show Cursor cloud-direct authentication status",
		handler: async (_args, ctx) => {
			try {
				const api_key = await ctx.modelRegistry.getApiKeyForProvider(CURSOR_PROVIDER_ID);
				const status = await get_cursor_status(api_key);
				ctx.ui.notify(
					status.authenticated ? `Cursor: ${status.detail}` : `Cursor: ${status.detail}`,
					status.authenticated ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(`Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh models available through Cursor cloud-direct",
		handler: async (_args, ctx) => {
			try {
				const api_key = await ctx.modelRegistry.getApiKeyForProvider(CURSOR_PROVIDER_ID);
				if (!api_key) {
					ctx.ui.notify("Cursor: not signed in. Run /login cursor", "warning");
					return;
				}
				clear_cached_cursor_models();
				const refreshed = build_cursor_models(
					await discover_cursor_models_with_token(api_key, { force: true }),
				);
				register_cursor_provider(pi, refreshed);
				ctx.ui.notify(`Cursor: refreshed ${refreshed.length} models.`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Cursor model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("cursor-logout", {
		description: "Log out of Cursor and clear cached cloud state",
		handler: async (_args, ctx) => {
			try {
				await logout_cursor();
				clear_all_conversation_states();
				const model_runtime = await ModelRuntime.create();
				await model_runtime.logout(CURSOR_PROVIDER_ID);
				ctx.ui.notify("Cursor: logged out.", "info");
			} catch (error) {
				ctx.ui.notify(
					`Cursor logout failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", () => {
		reset_cursor_session();
		clear_conversation_state(get_cursor_session_key());
		clear_cached_cursor_models();
		active_pi = null;
		process.off("unhandledRejection", abort_rejection_handler);
	});
}
