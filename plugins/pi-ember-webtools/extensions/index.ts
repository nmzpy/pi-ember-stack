/**
 * pi-ember-webtools — Ember-owned extension wrapper.
 *
 * The vendored source lives in the plugin root (`../index.ts` and sibling
 * modules) and is compiled directly by tsc. This thin wrapper imports the
 * original default factory and registers the bundled `librarian` skill via
 * `resources_discover` so it is discovered when loaded as an internal
 * pi-ember-stack plugin (not as a standalone pi package).
 *
 * Original author: Nico Bailon (MIT License, see ../LICENSE)
 * Source: https://github.com/nicobailon/pi-web-access
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piEmberWebtoolsFactory from "../index.ts";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

export default async function piEmberWebtoolsPlugin(pi: ExtensionAPI): Promise<void> {
	// Register the bundled librarian skill directory.
	pi.on("resources_discover", async () => ({
		skillPaths: [SKILLS_DIR],
	}));

	piEmberWebtoolsFactory(pi);
}
