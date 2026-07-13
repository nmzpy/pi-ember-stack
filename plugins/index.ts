import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import devinAuthPlugin from "./devin-auth/extensions/index.ts";
import piCompactToolsPlugin from "./pi-compact-tools/index.ts";
import subagentPlugin from "./subagent/extensions/index.ts";

type PluginId = "pi-compact-tools" | "subagent" | "devin-auth";
type StackPlugin = {
	id: PluginId;
	description: string;
	extension: (pi: ExtensionAPI) => void | Promise<void>;
};

type StackPluginConfig = {
	plugins?: unknown;
};

const CONFIG_RELATIVE_PATH = path.join(".pi", "ember-stack.json");
const DEFAULT_PLUGIN_IDS: readonly PluginId[] = [
	"pi-compact-tools",
	"subagent",
	"devin-auth",
];

const PLUGINS: readonly StackPlugin[] = [
	{
		id: "pi-compact-tools",
		description: "Compact edit rendering, modes, questionnaire, and footer",
		extension: piCompactToolsPlugin,
	},
	{
		id: "subagent",
		description: "Bundled subagent tool and agent definitions",
		extension: subagentPlugin,
	},
	{
		id: "devin-auth",
		description: "Devin OAuth provider, model catalog, and streaming transport",
		extension: devinAuthPlugin,
	},
];

function isPluginId(value: unknown): value is PluginId {
	return typeof value === "string" && PLUGINS.some((plugin) => plugin.id === value);
}

function getConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_RELATIVE_PATH);
}

function readEnabledPlugins(cwd: string): Set<PluginId> {
	const configPath = getConfigPath(cwd);
	if (!fs.existsSync(configPath)) return new Set(DEFAULT_PLUGIN_IDS);

	let config: StackPluginConfig;
	try {
		config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as StackPluginConfig;
	} catch (error) {
		throw new Error(
			`Invalid ${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!Array.isArray(config.plugins)) {
		throw new Error(
			`${CONFIG_RELATIVE_PATH} must contain a plugins array with known plugin IDs.`,
		);
	}

	const unknownPlugin = config.plugins.find((pluginId) => !isPluginId(pluginId));
	if (unknownPlugin !== undefined) {
		throw new Error(
			`Unknown pi-ember-stack plugin ${String(unknownPlugin)} in ${CONFIG_RELATIVE_PATH}.`,
		);
	}

	return new Set(config.plugins as PluginId[]);
}

function writeEnabledPlugins(cwd: string, enabledPlugins: Set<PluginId>): void {
	const configPath = getConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		configPath,
		`${JSON.stringify({ plugins: PLUGINS.filter((plugin) => enabledPlugins.has(plugin.id)).map((plugin) => plugin.id) }, null, 2)}\n`,
		"utf-8",
	);
}

function formatPluginChoice(plugin: StackPlugin, enabledPlugins: Set<PluginId>): string {
	return `${enabledPlugins.has(plugin.id) ? "[on]" : "[off]"} ${plugin.id} — ${plugin.description}`;
}

function registerPluginCommand(
	pi: ExtensionAPI,
	cwd: string,
	enabledPlugins: Set<PluginId>,
): void {
	pi.registerCommand("stack-plugins", {
		description: "Show or toggle pi-ember-stack plugins",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Enabled pi-ember-stack plugins: ${[...enabledPlugins].join(", ")}`);
				return;
			}

			const choices = PLUGINS.map((plugin) => formatPluginChoice(plugin, enabledPlugins));
			const selected = await ctx.ui.select("Plugin to toggle", choices);
			if (!selected) return;

			const selectedIndex = choices.indexOf(selected);
			const plugin = PLUGINS[selectedIndex];
			if (!plugin) return;

			if (enabledPlugins.has(plugin.id)) {
				enabledPlugins.delete(plugin.id);
			} else {
				enabledPlugins.add(plugin.id);
			}
			writeEnabledPlugins(cwd, enabledPlugins);
			ctx.ui.notify(
				`${plugin.id} ${enabledPlugins.has(plugin.id) ? "enabled" : "disabled"}. Restart pi to apply the change.`,
			);
		},
	});
}

export default async function piEmberStackPlugin(pi: ExtensionAPI): Promise<void> {
	const cwd = process.cwd();
	const enabledPlugins = readEnabledPlugins(cwd);
	for (const plugin of PLUGINS) {
		if (!enabledPlugins.has(plugin.id)) continue;
		await plugin.extension(pi);
	}
	registerPluginCommand(pi, cwd, enabledPlugins);
}
