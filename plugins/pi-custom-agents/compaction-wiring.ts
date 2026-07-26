/**
 * Parent + subagent sessions: Ember-owned compaction via session_before_compact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { run_stack_compaction } from "./stack-compaction.ts";

export default function install_compaction_wiring(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

		try {
			const compaction = await run_stack_compaction(
				event.preparation,
				model,
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
				},
				event.signal,
			);
			return { compaction };
		} catch {
			// Fail soft — Pi default compaction runs when the hook returns undefined.
			return;
		}
	});
}
