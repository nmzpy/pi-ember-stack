/**
 * pi-ember-sessions — session catalog + fleet of background conversations.
 *
 * Two jobs, one owner:
 *
 * 1. `session-index.ts` is the SSOT for "what sessions exist". `/resume`
 *    (pi-ember-ui) reads its catalog instead of scanning the session dir, so a
 *    picker hit never parses session history.
 * 2. `fleet.ts` + `session-factory.ts` run addressable background
 *    conversations: `/fleet new`, `/fleet send`, `/fleet switch`, `/fleet stop`.
 *    A fleet conversation is a normal Pi session file, so attaching to it is the
 *    ordinary `switchSession` path and it shows up in `/resume` like any other.
 *
 * Render boundary: this plugin never paints. The fleet list goes through Pi's
 * own `ctx.ui.select` UI, and background sessions report status through the
 * fleet registry (no TUI writes, no extra render scheduler, no timers).
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	configure_fleet_session_factory,
	create_fleet_session,
	fleet_find,
	fleet_list,
	forget_fleet_session,
	format_fleet_row,
	load_fleet,
	release_fleet_session,
	send_fleet_message,
	stop_fleet_session,
} from "./fleet.ts";
import { create_fleet_session_factory, type FleetRuntimeContext } from "./session-factory.ts";
import { flush_session_cache } from "./session-index.ts";

const FLEET_COMMAND = "fleet";

/** Live parent session; the factory reads its facts lazily so a session switch rebinds them. */
let bound_ctx: ExtensionContext | undefined;
let pi_thinking_level: string | undefined;

function resolve_fleet_context(): FleetRuntimeContext | undefined {
	const live = bound_ctx;
	if (!live) return undefined;
	const cwd = live.sessionManager?.getCwd?.() ?? live.cwd;
	if (!cwd) return undefined;
	return {
		cwd,
		model: live.model,
		model_registry: live.modelRegistry,
		thinking_level: pi_thinking_level,
	};
}

function describe_fleet(name: string): string {
	const info = fleet_find(name);
	if (!info) return `Unknown fleet session: ${name}`;
	return format_fleet_row(info);
}

/**
 * `/fleet` with no subcommand opens the picker: every conversation, running
 * ones first, and choosing one attaches the TUI to it.
 */
async function open_fleet_picker(ctx: ExtensionCommandContext): Promise<void> {
	const sessions = fleet_list();
	if (sessions.length === 0) {
		ctx.ui.notify(
			"No fleet sessions. Start one with /fleet new <name> [message], or share one from /resume with /fleet adopt <name> <path>.",
			"info",
		);
		return;
	}
	const rows = sessions.map(format_fleet_row);
	const choice = await ctx.ui.select("Fleet", rows);
	if (!choice) return;
	const index = rows.indexOf(choice);
	const target = sessions[index];
	if (target) await attach_fleet(target.name, ctx);
}

/** Attach the TUI to a fleet conversation (release the fleet runtime first). */
async function attach_fleet(name: string, ctx: ExtensionCommandContext): Promise<void> {
	const info = await release_fleet_session(name);
	ctx.ui.notify(`Opening ${info.name}…`, "info");
	try {
		const result = await ctx.switchSession(info.session_file);
		if (result?.cancelled) ctx.ui.notify("Switch cancelled", "info");
	} catch (error) {
		ctx.ui.notify(
			`Could not open ${info.name}: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function run_fleet_command(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	if (!trimmed) {
		await open_fleet_picker(ctx);
		return;
	}

	const [verb, ...rest] = trimmed.split(/\s+/);
	const rest_text = trimmed.slice(verb?.length ?? 0).trim();
	const [name] = rest;
	const message = rest_text.slice(name?.length ?? 0).trim();

	switch ((verb ?? "").toLowerCase()) {
		case "list": {
			const sessions = fleet_list();
			if (sessions.length === 0) {
				ctx.ui.notify("Fleet is empty.", "info");
				return;
			}
			ctx.ui.notify(sessions.map(format_fleet_row).join("\n"), "info");
			return;
		}
		case "new": {
			if (!name) {
				ctx.ui.notify("Usage: /fleet new <name> [first message]", "warning");
				return;
			}
			const info = create_fleet_session(name);
			if (message) {
				await send_fleet_message(info.name, message);
				ctx.ui.notify(`Started ${info.name}: ${message}`, "info");
			} else {
				ctx.ui.notify(
					`Created ${info.name}. Send it work with /fleet send ${info.name} <message>.`,
					"info",
				);
			}
			return;
		}
		case "send": {
			if (!name || !message) {
				ctx.ui.notify("Usage: /fleet send <name> <message>", "warning");
				return;
			}
			const info = await send_fleet_message(name, message);
			ctx.ui.notify(`Sent to ${info.name}: ${message}`, "info");
			return;
		}
		case "stop": {
			if (!name) {
				ctx.ui.notify("Usage: /fleet stop <name>", "warning");
				return;
			}
			const info = await stop_fleet_session(name);
			ctx.ui.notify(`Stopped ${info.name}.`, "info");
			return;
		}
		case "switch":
		case "open": {
			if (!name) {
				ctx.ui.notify("Usage: /fleet switch <name>", "warning");
				return;
			}
			await attach_fleet(name, ctx);
			return;
		}
		case "forget": {
			if (!name) {
				ctx.ui.notify("Usage: /fleet forget <name>", "warning");
				return;
			}
			const info = forget_fleet_session(name);
			ctx.ui.notify(`Forgot ${info.name} (session file kept).`, "info");
			return;
		}
		case "status": {
			ctx.ui.notify(describe_fleet(name ?? ""), "info");
			return;
		}
		default:
			ctx.ui.notify(
				"Usage: /fleet | /fleet new <name> [message] | /fleet send <name> <message> | /fleet switch <name> | /fleet stop <name> | /fleet forget <name> | /fleet list",
				"warning",
			);
	}
}

export default async function piEmberSessionsPlugin(pi: ExtensionAPI): Promise<void> {
	pi.on("session_start", (_event, ctx) => {
		bound_ctx = ctx;
		pi_thinking_level = pi.getThinkingLevel?.();
		configure_fleet_session_factory(create_fleet_session_factory(resolve_fleet_context));
		const cwd = ctx.sessionManager?.getCwd?.() ?? ctx.cwd;
		if (cwd) load_fleet(cwd);
	});

	pi.on("session_shutdown", async () => {
		// The fleet deliberately survives session replacement: background runs keep
		// going while the TUI moves to another session, and the next session_start
		// rebinds the list from fleet.json. Only the parent binding is dropped.
		// The session catalog stays warm for the same reason — it is inert
		// session-dir data, and dropping it would make the next /resume pay for a
		// scan that had just finished. Only the debounced cache write is flushed
		// here, so the next start reads the freshest file instead of waiting out
		// the write interval.
		bound_ctx = undefined;
		await flush_session_cache().catch(() => {
			/* the cache is an optimization; a failed flush is not fatal */
		});
	});

	pi.registerCommand(FLEET_COMMAND, {
		description: "Run and switch between background conversations (/fleet list)",
		handler: async (args, ctx) => {
			try {
				await run_fleet_command(args, ctx);
			} catch (error) {
				ctx.ui.notify(
					`Fleet error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
