/**
 * pi-ember-dcp — Dynamic Context Pruning for Pi (Ember-owned plugin core).
 *
 * Vendored/adapted from @davecodes/pi-dcp@0.2.0 by Davidcreador
 * (https://github.com/Davidcreador/pi-dcp), AGPL-3.0-or-later.
 * See plugins/pi-ember-dcp/LICENSE for the full license text.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bump_lifetime } from "./lib/stats.ts";
import {
	create_dcp_runtime,
	DCP_FULL_WIRE_OPTIONS,
	wire_dcp,
} from "./lib/wiring.ts";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

export default function piEmberDcpPlugin(pi: ExtensionAPI): void {
	const initial_cwd = process.cwd();
	const runtime = create_dcp_runtime(initial_cwd);

	if (!runtime.config.enabled) {
		runtime.logger.info("pi-ember-dcp disabled via config; skipping wiring");
		return;
	}

	bump_lifetime({ sessionsTouched: 1 });

	wire_dcp(pi, runtime, { ...DCP_FULL_WIRE_OPTIONS, skillsDir: SKILLS_DIR });

	runtime.logger.info("pi-ember-dcp initialized", {
		enabled: runtime.config.enabled,
		mode: runtime.config.compress.mode,
		manualMode: runtime.state.manualMode,
		customPrompts: runtime.config.experimental.customPrompts,
		hasOverrides: runtime.prompts.has_any_override(),
		strategies: {
			deduplication: runtime.config.strategies.deduplication.enabled,
			purgeErrors: runtime.config.strategies.purgeErrors.enabled,
		},
		compressPermission: runtime.config.compress.permission,
	});
}

export {
	create_dcp_runtime,
	DCP_FULL_WIRE_OPTIONS,
	DCP_SUBAGENT_WIRE_OPTIONS,
	is_dcp_enabled_for_subagent,
	wire_dcp,
} from "./lib/wiring.ts";
export { create_subagent_dcp_extension } from "./subagent-wiring.ts";
