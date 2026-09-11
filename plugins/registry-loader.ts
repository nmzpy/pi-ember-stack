/**
 * Pure registry-loading orchestration for pi-ember-stack.
 *
 * Kept in its own module (no plugin imports) so it can be unit-tested without
 * pulling in the heavy provider/plugin import graph (which needs `node:sqlite`
 * via pi-ember-hashedit and `.js`→`.ts` specifier resolution unavailable to
 * plain Node). plugins/index.ts re-exports these for the runtime entry point.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PluginId =
	| "pi-compact-tools"
	| "pi-ember-applypatch"
	| "pi-custom-agents"
	| "devin-auth"
	| "pi-crof-auth"
	| "pi-cursor-auth"
	| "pi-novita-auth"
	| "pi-ember-fff"
	| "pi-ember-hashedit"
	| "pi-ember-images"
	| "pi-ember-sessions"
	| "pi-ember-ui"
	| "pi-ember-tps"
	| "pi-ember-autoname"
	| "pi-ember-screen"
	| "pi-ember-webtools";

export type StackPlugin = {
	id: PluginId;
	description: string;
	extension: (pi: ExtensionAPI) => void | Promise<void>;
};

// Provider plugins are independent of each other: each registers its own
// provider id and primes its model catalog from a network call during the
// awaited factory. They are batched with Promise.all so those catalog-priming
// network waits overlap instead of running back-to-back sequentially.
export const PROVIDER_PLUGIN_IDS: ReadonlySet<PluginId> = new Set([
	"devin-auth",
	"pi-crof-auth",
	"pi-cursor-auth",
	"pi-novita-auth",
]);

/**
 * Runs the enabled plugins in canonical PLUGINS order. Non-provider plugins
 * run sequentially in their declared order so prerequisite ordering (e.g.
 * compact-tools before FFF, images before custom-agents) is preserved.
 * Consecutive enabled provider plugins are batched with Promise.all so their
 * catalog-priming network waits overlap; Promise.all preserves fail-fast
 * semantics (the first rejection rejects the batch, nothing is swallowed).
 */
export async function runEnabledPlugins(
	plugins: readonly StackPlugin[],
	enabledPlugins: Set<PluginId>,
	runOne: (plugin: StackPlugin) => Promise<void> | void,
): Promise<void> {
	const enabled = plugins.filter((plugin) => enabledPlugins.has(plugin.id));
	for (let index = 0; index < enabled.length; index++) {
		const plugin = enabled[index];
		if (!PROVIDER_PLUGIN_IDS.has(plugin.id)) {
			await runOne(plugin);
			continue;
		}
		const batch = [plugin];
		while (index + 1 < enabled.length && PROVIDER_PLUGIN_IDS.has(enabled[index + 1].id)) {
			batch.push(enabled[index + 1]);
			index++;
		}
		await Promise.all(batch.map((member) => runOne(member)));
	}
}
