/**
 * Cursor OAuth PKCE login and token refresh.
 * Adapted from ephraimduncan/opencode-cursor (BSD-3-Clause).
 */
import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	login_url: string;
}

async function generate_pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier_bytes = randomBytes(96);
	const verifier = Buffer.from(verifier_bytes).toString("base64url");
	const hash = createHash("sha256").update(verifier).digest();
	const challenge = hash.toString("base64url");
	return { verifier, challenge };
}

export async function generate_cursor_auth_params(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generate_pkce();
	const uuid = crypto.randomUUID();
	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});
	const login_url = `${CURSOR_LOGIN_URL}?${params.toString()}`;
	return { verifier, challenge, uuid, login_url };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function poll_cursor_auth(
	uuid: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token: string }> {
	let delay = POLL_BASE_DELAY_MS;
	let consecutive_errors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw new Error("Cursor authentication cancelled");
		await sleep(delay);

		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, {
				signal,
			});

			if (response.status === 404) {
				consecutive_errors = 0;
				delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					access_token: data.accessToken,
					refresh_token: data.refreshToken,
				};
			}

			throw new Error(`Cursor auth poll failed: HTTP ${response.status}`);
		} catch (error) {
			if (signal?.aborted) throw new Error("Cursor authentication cancelled");
			consecutive_errors++;
			if (consecutive_errors >= 3) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`Cursor authentication polling failed: ${detail}`);
			}
		}
	}

	throw new Error("Cursor authentication polling timed out");
}

export function get_token_expiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3 || !parts[1]) return Date.now() + 3600 * 1000;
		const decoded = JSON.parse(
			Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		) as { exp?: number };
		if (typeof decoded.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
	} catch {
		// fall through
	}
	return Date.now() + 3600 * 1000;
}

export async function refresh_cursor_token(refresh_token: string): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${refresh_token}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Cursor token refresh failed: ${error.slice(0, 400)}`);
	}

	const data = (await response.json()) as {
		accessToken: string;
		refreshToken: string;
	};

	return {
		access: data.accessToken,
		refresh: data.refreshToken || refresh_token,
		expires: get_token_expiry(data.accessToken),
	};
}

export async function ensure_cursor_access_token(
	credentials: OAuthCredentials,
): Promise<string> {
	if (credentials.access && credentials.expires > Date.now()) {
		return credentials.access;
	}
	const refreshed = await refresh_cursor_token(credentials.refresh);
	credentials.access = refreshed.access;
	credentials.refresh = refreshed.refresh;
	credentials.expires = refreshed.expires;
	return refreshed.access;
}
