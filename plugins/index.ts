import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import devinAuthPlugin from "./devin-auth/extensions/index.ts";
import piCompactToolsPlugin, { getSharedRenderer } from "./pi-compact-tools/index.ts";
import piCursorAuthPlugin from "./pi-cursor-auth/extensions/index.ts";
import piCustomAgentsPlugin from "./pi-custom-agents/index.ts";
import piEmberDcpPlugin from "./pi-ember-dcp/index.ts";
import piEmberFffPlugin from "./pi-ember-fff/index.ts";
import piEmberTpsPlugin from "./pi-ember-tps/index.ts";
import piEmberUiPlugin from "./pi-ember-ui/index.ts";
import piEmberWebtoolsPlugin from "./pi-ember-webtools/extensions/index.ts";

export { getSharedRenderer };

type PluginId =
	| "pi-compact-tools"
	| "pi-custom-agents"
	| "pi-ember-dcp"
	| "devin-auth"
	| "pi-cursor-auth"
	| "pi-ember-fff"
	| "pi-ember-ui"
	| "pi-ember-tps"
	| "pi-ember-webtools";
type StackPlugin = {
	id: PluginId;
	description: string;
	extension: (pi: ExtensionAPI) => void | Promise<void>;
};

const CONFIG_FILENAME = "pi-ember-stack.json";
const DEFAULT_PLUGIN_IDS: readonly PluginId[] = [
	"pi-compact-tools",
	"devin-auth",
	"pi-cursor-auth",
	"pi-custom-agents",
	"pi-ember-dcp",
	"pi-ember-fff",
	"pi-ember-ui",
	"pi-ember-tps",
	"pi-ember-webtools",
];

const PLUGINS: readonly StackPlugin[] = [
	{
		id: "pi-compact-tools",
		description: "Collapsed native edit rendering",
		extension: piCompactToolsPlugin,
	},
	{
		id: "devin-auth",
		description: "Devin OAuth provider, model catalog, and streaming transport",
		extension: devinAuthPlugin,
	},
	{
		id: "pi-cursor-auth",
		description: "Cursor subscription auth, model catalog, and native Pi streaming",
		extension: piCursorAuthPlugin,
	},
	{
		id: "pi-custom-agents",
		description: "Questionnaire, primary modes, plans, subagents, and bundled agent definitions",
		extension: piCustomAgentsPlugin,
	},
	{
		id: "pi-ember-dcp",
		description: "Dynamic context pruning and compress tool for outbound LLM context",
		extension: piEmberDcpPlugin,
	},
	{
		id: "pi-ember-fff",
		description: "FFF-powered grep and find with compact rendering",
		extension: piEmberFffPlugin,
	},
	{
		id: "pi-ember-ui",
		description: "Ember accent theme — orange reasoning colors, accent borders",
		extension: piEmberUiPlugin,
	},
	{
		id: "pi-ember-tps",
		description: "Tokens-per-second meter with sparkline trend and live gauge",
		extension: piEmberTpsPlugin,
	},
	{
		id: "pi-ember-webtools",
		description: "Web search, URL fetching, GitHub cloning, PDF/YouTube/video extraction",
		extension: piEmberWebtoolsPlugin,
	},
];

function isPluginId(value: unknown): value is PluginId {
	return typeof value === "string" && PLUGINS.some((plugin) => plugin.id === value);
}

function getConfigPath(): string {
	const home =
		process.env.PI_HOME ||
		path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
	return path.join(home, CONFIG_FILENAME);
}

function readConfigFile(): Record<string, unknown> {
	const configPath = getConfigPath();
	if (!fs.existsSync(configPath)) return {};
	try {
		return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`Invalid ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function writeConfigFile(config: Record<string, unknown>): void {
	const configPath = getConfigPath();
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readEnabledPlugins(): Set<PluginId> {
	const config = readConfigFile();

	if (!Array.isArray(config.plugins)) {
		return new Set(DEFAULT_PLUGIN_IDS);
	}

	const rawPlugins = config.plugins as unknown[];
	const configuredPlugins = rawPlugins.map((pluginId) =>
		pluginId === "pi-web-access" ? "pi-ember-webtools" : pluginId,
	);
	if (configuredPlugins.some((pluginId, index) => pluginId !== rawPlugins[index])) {
		config.plugins = configuredPlugins;
		writeConfigFile(config);
	}

	const unknownPlugin = configuredPlugins.find((pluginId) => !isPluginId(pluginId));
	if (unknownPlugin !== undefined) {
		throw new Error(
			`Unknown pi-ember-stack plugin ${String(unknownPlugin)} in ${CONFIG_FILENAME}.`,
		);
	}

	return new Set(config.plugins as PluginId[]);
}

function writeEnabledPlugins(enabledPlugins: Set<PluginId>): void {
	const config = readConfigFile();
	config.plugins = PLUGINS.filter((plugin) => enabledPlugins.has(plugin.id)).map(
		(plugin) => plugin.id,
	);
	writeConfigFile(config);
}

function formatPluginChoice(plugin: StackPlugin, enabledPlugins: Set<PluginId>): string {
	return `${enabledPlugins.has(plugin.id) ? "[on]" : "[off]"} ${plugin.id} — ${plugin.description}`;
}

function registerPluginCommand(pi: ExtensionAPI, enabledPlugins: Set<PluginId>): void {
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
			writeEnabledPlugins(enabledPlugins);
			ctx.ui.notify(
				`${plugin.id} ${enabledPlugins.has(plugin.id) ? "enabled" : "disabled"}. Restart pi to apply the change.`,
			);
		},
	});
}

export default async function piEmberStackPlugin(pi: ExtensionAPI): Promise<void> {
	const enabledPlugins = readEnabledPlugins();
	for (const plugin of PLUGINS) {
		if (!enabledPlugins.has(plugin.id)) continue;
		await plugin.extension(pi);
	}
	registerPluginCommand(pi, enabledPlugins);
}
