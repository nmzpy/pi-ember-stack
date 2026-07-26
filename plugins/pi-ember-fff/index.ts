/**
 * pi-ember-fff: Ember-owned FFF-powered file search extension for pi.
 *
 * Forked from @ff-labs/pi-fff 0.9.6 (MIT, Copyright (c) Dmitry Kovalenko).
 * Always registers canonical `grep` and `find` tool names (override mode),
 * and delegates rendering to the shared Ember compact renderer from
 * @nmzpy/pi-ember-stack so the TUI stays consistent across all tools.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { bashGrepInfo, rewriteGrepToRg } from "../pi-compact-tools/bash-grep.ts";
import { getSharedRenderer } from "../pi-compact-tools/index.ts";
import { buildExternalAllowlist } from "./query.ts";
import { clearCursorStores } from "./cursor-store.ts";
import { createFinderManager } from "./finder.ts";
import { createMentionItemsLoader, registerAutocompleteProvider } from "./mention.ts";
import { registerGrepTool } from "./grep-tool.ts";
import { registerFindTool } from "./find-tool.ts";
import { registerFffCommands } from "./commands.ts";

export { fffFileAnnotation } from "./format.ts";

function resolveBoolOpt(
	pi: ExtensionAPI,
	flagName: string,
	envName: string,
): boolean {
	const flag = pi.getFlag(flagName);
	if (typeof flag === "boolean") return flag;
	if (typeof flag === "string") return flag === "true" || flag === "1";
	const env = process.env[envName];
	return env === "1" || env === "true";
}

export default function emberFffExtension(pi: ExtensionAPI) {
	const renderer = getSharedRenderer();
	const externalAllowlist = buildExternalAllowlist();

	const frecencyDbPath =
		(pi.getFlag("fff-frecency-db") as string | undefined) ??
		process.env.FFF_FRECENCY_DB ??
		undefined;
	const historyDbPath =
		(pi.getFlag("fff-history-db") as string | undefined) ??
		process.env.FFF_HISTORY_DB ??
		undefined;
	const enableFsRootScanning = resolveBoolOpt(pi, "fff-enable-root-scan", "FFF_ENABLE_ROOT_SCAN");
	const enableExternalAllow = (() => {
		const flag = pi.getFlag("fff-external-allow");
		if (typeof flag === "boolean") return flag;
		if (typeof flag === "string") return flag === "true" || flag === "1";
		const env = process.env.FFF_EXTERNAL_ALLOW;
		if (env !== undefined) return env === "1" || env === "true";
		return true;
	})();

	const finder = createFinderManager({
		frecencyDbPath,
		historyDbPath,
		enableFsRootScanning,
		enableExternalAllow,
		externalAllowlist,
	});

	const getMentionItems = createMentionItemsLoader(
		finder.ensureFinder,
		finder.getActiveCwd,
	);

	pi.registerFlag("fff-frecency-db", {
		description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
		type: "string",
	});

	pi.registerFlag("fff-history-db", {
		description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
		type: "string",
	});

	pi.registerFlag("fff-enable-root-scan", {
		description:
			"Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
		type: "boolean",
	});

	pi.registerFlag("fff-external-allow", {
		description:
			"Allow grep/find to search the auto-detected @earendil-works/pi-coding-agent package directory via the ./pi-coding-agent alias (also: FFF_EXTERNAL_ALLOW env; default: true)",
		type: "boolean",
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			finder.setActiveCwd(ctx.cwd);
			registerAutocompleteProvider(ctx, getMentionItems);
			await finder.ensureFinder(ctx.cwd);
		} catch (e: unknown) {
			ctx.ui.notify(
				`FFF init failed: ${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		finder.destroyFinder();
		finder.destroyExternalFinder();
		clearCursorStores();
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;
		if (!bashGrepInfo(command)) return;
		const rewritten = rewriteGrepToRg(command);
		if (rewritten) event.input.command = rewritten;
	});

	registerGrepTool(pi, { renderer, finder, externalAllowlist });
	registerFindTool(pi, { renderer, finder });
	registerFffCommands(pi, finder.getFinder);
}
