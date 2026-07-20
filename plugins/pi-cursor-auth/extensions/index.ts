import {
	type ExtensionAPI,
	ModelRuntime,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	CURSOR_API_IDENTIFIER,
	CURSOR_AUTH_MARKER,
	CURSOR_PLACEHOLDER_BASE_URL,
	CURSOR_PROVIDER_ID,
	CURSOR_PROVIDER_NAME,
} from "../src/constants.js";
import {
	discover_cursor_models,
	get_cursor_status,
	login_cursor,
	logout_cursor,
} from "../src/cli.js";
import { build_cursor_models } from "../src/models.js";
import {
	set_cursor_cwd,
	stream_cursor_subscription,
	terminate_cursor_processes,
} from "../src/stream.js";

let active_pi: ExtensionAPI | null = null;

function register_cursor_provider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(CURSOR_PROVIDER_ID, {
		name: CURSOR_PROVIDER_NAME,
		baseUrl: CURSOR_PLACEHOLDER_BASE_URL,
		api: CURSOR_API_IDENTIFIER,
		models,
		streamSimple: stream_cursor_subscription,
		oauth: {
			name: "Cursor subscription (browser login)",
			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				await login_cursor(callbacks);
				if (active_pi) {
					const discovered = await discover_cursor_models();
					register_cursor_provider(active_pi, build_cursor_models(discovered));
				}
				return {
					access: CURSOR_AUTH_MARKER,
					refresh: "",
					expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
				};
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return { ...credentials, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
			},
			getApiKey(): string {
				return CURSOR_AUTH_MARKER;
			},
		},
	});
}

export default async function pi_cursor_auth(pi: ExtensionAPI): Promise<void> {
	active_pi = pi;

	// Register with an empty catalog first so a missing/unauthenticated
	// cursor-agent CLI cannot take down the whole pi-ember-stack load.
	// Live discovery fills the list when the CLI is available; otherwise
	// /login cursor and /cursor-refresh-models remain the recovery path.
	register_cursor_provider(pi, []);
	try {
		// Do not auto-install during factory load — only probe an existing CLI.
		const discovered = await discover_cursor_models({ ensure: false });
		const models = build_cursor_models(discovered);
		if (models.length > 0) {
			register_cursor_provider(pi, models);
		}
	} catch {
		// CLI missing, not logged in, or empty model list — keep empty catalog.
	}

	pi.on("session_start", (_event, ctx) => {
		set_cursor_cwd(ctx.cwd);
	});

	pi.registerCommand("cursor-status", {
		description: "Show Cursor CLI subscription authentication status",
		handler: async (_args, ctx) => {
			try {
				const status = await get_cursor_status();
				ctx.ui.notify(
					status.authenticated ? "Cursor: authenticated" : `Cursor: ${status.detail}`,
					status.authenticated ? "info" : "warning",
				);
			} catch (error) {
				ctx.ui.notify(`Cursor: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("cursor-refresh-models", {
		description: "Refresh models available through the Cursor subscription",
		handler: async (_args, ctx) => {
			try {
				const refreshed = build_cursor_models(await discover_cursor_models());
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
		description: "Log out of Cursor CLI and remove Pi's Cursor auth marker",
		handler: async (_args, ctx) => {
			try {
				await logout_cursor();
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
		terminate_cursor_processes();
		set_cursor_cwd(undefined);
		active_pi = null;
	});
}
