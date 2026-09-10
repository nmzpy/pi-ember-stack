/**
 * Parent + subagent sessions: Ember-owned compaction via session_before_compact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve_runtime_stream_simple } from "./model-runtime-bridge.ts";
import { run_stack_compaction } from "./stack-compaction.ts";

export default function install_compaction_wiring(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

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
				undefined,
				resolve_runtime_stream_simple(ctx.modelRegistry),
			);
			return { compaction };
		} catch {
			// Fail soft — Pi default compaction runs when the hook returns undefined.
			return;
		}
	});
}
