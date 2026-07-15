/**
 * pi extension entry point for the Devin (Cognition) provider.
 *
 * Registers the `devin` provider with pi's ExtensionAPI, wiring up:
 *  - OAuth login via Windsurf's browser sign-in flow (`loginDevin`)
 *  - A no-op token refresh (Windsurf api_keys are long-lived)
 *  - Live model catalog fetch from Cognition's GetCascadeModelConfigs
 *    after login, surfacing every model the account has access to
 *  - `/devin-refresh` command to manually re-fetch the catalog
 *  - `/devin-status` command to check auth state
 *  - `session_start` auto-fetch when already logged in
 *  - Streaming chat completions through Devin Cloud (`streamDevin`)
 *
 * The provider uses `streamSimple` — no background proxy. All routing
 * and auth are handled internally via the OAuth-issued api_key.
 */

import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from '@earendil-works/pi-coding-agent';
import type {
    Api,
    Model,
    OAuthCredentials,
    OAuthLoginCallbacks,
} from '@earendil-works/pi-ai';
import { streamDevin } from '../src/stream.js';
import { loginDevin } from '../src/oauth/login.js';
import { buildLiveModels, DEFAULT_HOST } from '../src/models.js';
import { getCachedCatalog, clearCachedCatalog } from '../src/cloud-direct/catalog.js';
import { DEFAULT_REGION } from '../src/oauth/types.js';

const PROVIDER_ID = 'devin';
const PROVIDER_NAME = 'Devin (Cognition)';
const OAUTH_NAME = 'Devin (Cognition / Windsurf)';
const API_IDENTIFIER = 'devin-cloud';
// pi requires baseUrl when models are defined, even with streamSimple.
// streamSimple ignores this — it routes internally — but the field must be present.
const PLACEHOLDER_BASE_URL = DEFAULT_HOST;

let _pi: ExtensionAPI | null = null;

/**
 * Fetch the live catalog using credentials already in auth.json and register
 * the resulting models. Called during the awaited factory load so devin
 * models exist before pi flushes pending provider registrations and restores
 * the session model.
 *
 * Reads auth.json directly via AuthStorage (the model registry is not bound
 * yet during factory load). Silently no-ops when not signed in or the fetch
 * fails — the session_start handler re-attempts once the registry is live.
 */
async function primeCatalogFromStoredAuth(): Promise<void> {
    if (!_pi) return;
    try {
        const authStorage = AuthStorage.create();
        const apiKey = await authStorage.getApiKey(PROVIDER_ID, { includeFallback: false });
        if (!apiKey) return;
        const catalog = await getCachedCatalog(apiKey, DEFAULT_HOST);
        const liveModels = buildLiveModels(catalog);
        if (liveModels.length > 0) {
            registerDevinProvider(_pi, liveModels);
        }
    } catch {
        // Not signed in, network failure, or schema drift — keep the empty
        // model list and let session_start retry once the registry is bound.
    }
}

function registerDevinProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
    pi.registerProvider(PROVIDER_ID, {
        name: PROVIDER_NAME,
        api: API_IDENTIFIER,
        baseUrl: PLACEHOLDER_BASE_URL,
        models,
        oauth: {
            name: OAUTH_NAME,
            async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
                const credentials = await loginDevin(callbacks, DEFAULT_REGION);
                if (_pi) {
                    try {
                        clearCachedCatalog();
                        const catalog = await getCachedCatalog(
                            credentials.access,
                            DEFAULT_HOST,
                        );
                        const liveModels = buildLiveModels(catalog);
                        registerDevinProvider(_pi, liveModels);
                    } catch {
                        // keep current models if catalog fetch fails
                    }
                }
                return credentials;
            },
            async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
                return credentials;
            },
            getApiKey(credentials: OAuthCredentials): string {
                return credentials.access;
            },
            modifyModels(models: Model<Api>[]): Model<Api>[] {
                return models;
            },
        },
        streamSimple: streamDevin,
    });
}

export default async function (pi: ExtensionAPI): Promise<void> {
    _pi = pi;

    // Swallow AbortError unhandled rejections that arise when the user
    // cancels an in-flight agent run (Escape during streaming). The agent's
    // AbortController.abort() sets signal.reason to a DOMException
    // [AbortError]; late rejections from fetch body streams, reader.cancel(),
    // or the anySignal polyfill can surface as unhandled rejections that —
    // on Node ≥15 with --unhandled-rejections=throw (the default in Node 25)
    // — trigger pi's uncaughtException handler and crash the process.
    // These are expected during cancellation, not real errors.
    //
    // Non-abort rejections are genuine bugs. Re-throw them through the normal
    // uncaught-exception path without creating another rejected promise.
    const abortRejectionHandler = (reason: unknown): void => {
        const reasonName =
            typeof reason === 'object' && reason !== null
                ? (reason as { name?: unknown }).name
                : undefined;
        const isAbort = reasonName === 'AbortError';
        if (isAbort) return; // expected during cancellation
        queueMicrotask(() => {
            throw reason;
        });
    };
    process.on('unhandledRejection', abortRejectionHandler);

    // Register with an empty model list first so the provider (and OAuth
    // login support) is known even before the catalog arrives. Then, if we
    // already have credentials in auth.json, fetch the live catalog now —
    // during the awaited factory load, before pi flushes pending provider
    // registrations and restores the session model. This is what makes
    // `devin/glm-5-2` resolvable on resume instead of falling back to the
    // default provider with a "Could not restore model" warning.
    registerDevinProvider(pi, []);
    await primeCatalogFromStoredAuth();

    pi.on('session_start', async (_event, ctx) => {
        // Re-prime in case credentials were added via /login since load, or
        // the catalog TTL expired during a long-lived session.
        try {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            if (apiKey && _pi) {
                const catalog = await getCachedCatalog(apiKey, DEFAULT_HOST);
                const liveModels = buildLiveModels(catalog);
                registerDevinProvider(_pi, liveModels);
            }
        } catch {
            // keep current models
        }
    });

    pi.registerCommand('devin-refresh', {
        description: 'Refresh Devin model catalog from Cognition',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            if (!apiKey) {
                ctx.ui.notify(
                    'Devin: not signed in. Run /login devin',
                    'warning',
                );
                return;
            }
            clearCachedCatalog();
            try {
                const catalog = await getCachedCatalog(apiKey, DEFAULT_HOST);
                const liveModels = buildLiveModels(catalog);
                registerDevinProvider(pi, liveModels);
                ctx.ui.notify(
                    `Devin: refreshed ${liveModels.length} models.`,
                    'info',
                );
            } catch (e) {
                ctx.ui.notify(
                    `Devin: refresh error - ${e instanceof Error ? e.message : String(e)}`,
                    'error',
                );
            }
        },
    });

    pi.registerCommand('devin-status', {
        description: 'Show Devin auth status',
        handler: async (_args, ctx) => {
            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
            ctx.ui.notify(
                apiKey ? 'Devin: authenticated' : 'Devin: not signed in. Run /login devin',
                apiKey ? 'info' : 'warning',
            );
        },
    });

    pi.on('session_shutdown', async () => {
        _pi = null;
        process.off('unhandledRejection', abortRejectionHandler);
    });
}
