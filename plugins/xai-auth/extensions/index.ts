/**
 * pi extension entry point for the xAI (Grok) OAuth provider.
 *
 * Registers the `xai-auth` provider with pi's ExtensionAPI, wiring up:
 *  - OAuth login via xAI's PKCE flow with local callback server + manual paste
 *  - Automatic token refresh before expiry
 *  - Grok CLI credential reuse from `~/.grok/auth.json`
 *  - Static model catalog (Grok 4.5, 4.3, Build, Composer, 4.20 variants)
 *  - Streaming via xAI Responses API (delegates to pi's OpenAI Responses transport)
 *  - Custom xAI tools (generate_text, web_search, x_search, multi_agent, etc.)
 *  - Cursor/Grok CLI tool shims for Composer/Grok Build models
 *  - `/xai-status` command to check auth state
 *  - `session_start` cursor-shim sync
 *  - AbortError unhandled-rejection guard (from devin-auth)
 *  - `session_shutdown` cleanup (from devin-auth session-replacement discipline)
 *
 * Improvements adopted from devin-auth:
 *  - AbortError unhandled-rejection guard prevents process crashes when the
 *    user cancels an in-flight agent run (Escape during streaming).
 *  - session_shutdown handler clears module-level state so jiti-cached
 *    module state doesn't survive across sessions with stale references.
 *  - Status command for quick auth diagnostics.
 *  - Proper async factory + typed ExtensionAPI (no `as any` on the surface).
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import { getGrokAuthCredentials } from "../src/auth.js";
import {
	XAI_API_BASE_URL,
	XAI_API_IDENTIFIER,
	XAI_PROVIDER_ID,
	XAI_PROVIDER_NAME,
} from "../src/constants.js";
import { MODELS } from "../src/models.js";
import { createXaiOAuth } from "../src/oauth.js";
import { streamSimpleXaiResponses } from "../src/responses.js";
import { registerXaiTools } from "../src/tools/index.js";
import { syncCursorToolShimsForModel } from "../src/tools/cursor-shims.js";

let _pi: ExtensionAPI | null = null;

function registerXaiProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
	pi.registerProvider(XAI_PROVIDER_ID, {
		name: XAI_PROVIDER_NAME,
		baseUrl: XAI_API_BASE_URL,
		api: XAI_API_IDENTIFIER as Api,
		models,
		authHeader: true,
		// The forwarding stream is structurally compatible with
		// AssistantMessageEventStream at runtime (push/end/[Symbol.asyncIterator])
		// but doesn't share the class type — cast is required, same as upstream.
		streamSimple: streamSimpleXaiResponses as never,
		oauth: createXaiOAuth({ getExistingCredentials: getGrokAuthCredentials }),
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	_pi = pi;

	// AbortError unhandled-rejection guard (from devin-auth).
	// Swallows DOMException [AbortError] rejections that arise when the user
	// cancels an in-flight agent run (Escape during streaming). Non-abort
	// rejections are re-emitted so genuine bugs still surface.
	const abortRejectionHandler = (reason: unknown): void => {
		const reasonName =
			typeof reason === "object" && reason !== null
				? (reason as { name?: unknown }).name
				: undefined;
		if (reasonName === "AbortError") return;
		queueMicrotask(() => {
			throw reason;
		});
	};
	process.on("unhandledRejection", abortRejectionHandler);

	registerXaiProvider(pi, MODELS as ProviderModelConfig[]);
	registerXaiTools(pi);

	pi.on("session_start", (_event, ctx) => {
		syncCursorToolShimsForModel(pi, ctx?.model as Model<Api> | undefined);
	});

	pi.on("model_select", (event, ctx) => {
		syncCursorToolShimsForModel(pi, (event?.model ?? ctx?.model) as Model<Api> | undefined);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		syncCursorToolShimsForModel(pi, ctx?.model as Model<Api> | undefined);
	});

	pi.registerCommand("xai-status", {
		description: "Show xAI OAuth auth status",
		handler: async (_args, ctx) => {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(XAI_PROVIDER_ID);
			ctx.ui.notify(
				apiKey ? "xAI: authenticated" : "xAI: not signed in. Run /login xai-auth",
				apiKey ? "info" : "warning",
			);
		},
	});

	pi.on("session_shutdown", async () => {
		_pi = null;
		process.off("unhandledRejection", abortRejectionHandler);
	});
}

// Re-export for external consumers (tests, other plugins).
export { getGrokAuthCredentials, type OAuthCredentials };
