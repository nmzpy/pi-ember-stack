/**
 * pi-web-access — Ember-owned extension wrapper.
 *
 * The vendored source lives in the plugin root (`../index.ts` and sibling
 * modules). This thin wrapper dynamically imports the original default
 * factory and registers the bundled `librarian` skill via
 * `resources_discover` so it is discovered when loaded as an internal
 * pi-ember-stack plugin (not as a standalone pi package).
 *
 * A dynamic import is used so the vendored source — which has type drift
 * against pi 0.80 — is not pulled into our strict tsc compilation. The
 * runtime import works correctly via jiti.
 *
 * Original author: Nico Bailon (MIT License, see ../LICENSE)
 * Source: https://github.com/nicobailon/pi-web-access
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

export default async function piWebAccessPlugin(pi: ExtensionAPI): Promise<void> {
	// Register the bundled librarian skill directory.
	pi.on("resources_discover", async () => ({
		skillPaths: [SKILLS_DIR],
	}));

	// Dynamically import the vendored extension to avoid pulling its type
	// errors into our strict tsc compilation. jiti resolves the .ts import
	// at runtime. The path is constructed indirectly so tsc does not
	// statically resolve and type-check the vendored module.
	const entryPath = "../index.ts";
	const module = await import(entryPath);
	const factory = module.default;
	if (typeof factory !== "function") {
		throw new Error("pi-web-access: vendored index.ts does not export a default function");
	}
	factory(pi);
}
