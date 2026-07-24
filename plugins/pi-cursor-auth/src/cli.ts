/**
 * Cursor OAuth login and cloud-direct status helpers.
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	discover_cursor_models_cloud,
	clear_cached_cursor_models,
} from "./cloud-direct/catalog.js";
import {
	generate_cursor_auth_params,
	poll_cursor_auth,
	refresh_cursor_token,
	get_token_expiry,
} from "./cloud-direct/auth.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function login_cursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, uuid, login_url } = await generate_cursor_auth_params();
	callbacks.onProgress?.("Opening Cursor browser authentication...");
	callbacks.onAuth({ url: login_url });

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
	try {
		const { access_token, refresh_token } = await poll_cursor_auth(uuid, verifier, controller.signal);
		return {
			access: access_token,
			refresh: refresh_token,
			expires: get_token_expiry(access_token),
		};
	} finally {
		clearTimeout(timeout);
	}
}

export async function discover_cursor_models_with_token(
	access_token: string,
	options: { force?: boolean } = {},
) {
	return discover_cursor_models_cloud(access_token, options);
}

export async function get_cursor_status(access_token?: string): Promise<{
	authenticated: boolean;
	detail: string;
}> {
	if (!access_token) {
		return { authenticated: false, detail: "not signed in — run /login cursor" };
	}
	try {
		const models = await discover_cursor_models_cloud(access_token, { force: true });
		return {
			authenticated: true,
			detail: `authenticated (${models.length} models)`,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { authenticated: false, detail };
	}
}

export async function logout_cursor(): Promise<void> {
	clear_cached_cursor_models();
}

export async function ensure_fresh_cursor_credentials(
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (credentials.access && credentials.expires > Date.now()) return credentials;
	return refresh_cursor_token(credentials.refresh);
}
