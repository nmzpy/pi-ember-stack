/**
 * Parent + subagent sessions: Ember-owned compaction via session_before_compact.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	apply_openrouter_routing,
	build_openrouter_routing,
} from "../pi-ember-ui/openrouter-routing.ts";
import { resolve_runtime_stream_simple } from "./model-runtime-bridge.ts";
import type { ModelIdentity } from "./mode-models.ts";
import { run_stack_compaction } from "./stack-compaction.ts";

/**
 * User-picked summarizer model (`/compact-model`). Session-bound module state:
 * set by the command handler, re-read from persisted state on session_start,
 * cleared on session_shutdown. `undefined` means "use the session model"
 * (ctx.model) — the default before any pick.
 */
let compact_model_identity: ModelIdentity | undefined;

/** Bind the summarizer model for the next compaction. `undefined` resets to the session model. */
export function set_compact_model(identity: ModelIdentity | undefined): void {
	compact_model_identity = identity;
}

/** The currently bound summarizer identity, if any (test + notify surface). */
export function get_compact_model(): ModelIdentity | undefined {
	return compact_model_identity;
}

/**
 * Resolve the bound compaction identity to a live registry model with its
 * OpenRouter upstream baked in. Returns `undefined` when no override is set,
 * the model is no longer in the catalog, or it has no configured auth — the
 * caller then falls back to the session model so compaction always runs.
 */
async function resolve_compact_model(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; thinkingLevel?: string } | undefined> {
	const bound = compact_model_identity;
	if (!bound) return undefined;
	const target = ctx.modelRegistry.find(bound.provider, bound.modelId) as Model<Api> | undefined;
	if (!target || !ctx.modelRegistry.hasConfiguredAuth(target)) return undefined;
	const routing = build_openrouter_routing(bound.openRouterProvider ?? "");
	return { model: apply_openrouter_routing(target, routing), thinkingLevel: bound.thinkingLevel };
}

export default function install_compaction_wiring(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => {
		compact_model_identity = undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// `/compact-model` override wins; otherwise the session model summarizes.
		const override = await resolve_compact_model(ctx);
		const model = override?.model ?? ctx.model;
		if (!model) return;

		// Only an unresolvable credential skips Ember compaction. A headers-only
		// resolution (env/command-configured key) must NOT fall through to Pi's
		// native summarizer: the canonical runtime resolves the key itself, and
		// the native path adds the split-turn block and throws on a `length`
		// stop. `auth.apiKey` is undefined there and is forwarded as-is.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;

		try {
			// Stream the summarizer through the canonical ModelRuntime: extension-
			// registered providers (Devin, Cursor, CrofAI, …) are not visible to the
			// global pi-ai dispatcher, and only the streaming path emits the deltas
			// the footer TPS meter taps while the `• Compacting` row animates.
			const compaction = await run_stack_compaction(
				event.preparation,
				model,
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
				},
				event.signal,
				override?.thinkingLevel as Parameters<typeof run_stack_compaction>[4],
				resolve_runtime_stream_simple(ctx.modelRegistry),
			);
			return { compaction };
		} catch {
			// Fail soft — Pi default compaction runs when the hook returns undefined.
			return;
		}
	});
}
