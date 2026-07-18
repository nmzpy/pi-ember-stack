/**
 * pi-ember-dcp — Dynamic Context Pruning for Pi (Ember-owned plugin core).
 *
 * Vendored/adapted from @davecodes/pi-dcp@0.2.0 by Davidcreador
 * (https://github.com/Davidcreador/pi-dcp), AGPL-3.0-or-later.
 * See plugins/pi-ember-dcp/LICENSE for the full license text.
 *
 * Wires the following into pi:
 *   1. A `context` handler that prunes the message array on every LLM call
 *      (deduplication + errored-input purge + stored compressions). Returns
 *      a freshly built array — message objects share identity with persisted
 *      session entries and must not be mutated in place.
 *   2. A `compress` tool the LLM can call to summarize closed work-streams.
 *      Two variants: message-mode (toolCallIds[]) and range-mode (start+end).
 *      One or the other is registered based on `config.compress.mode`.
 *   3. A `before_agent_start` handler that appends throttled system-prompt
 *      nudges as context fills up.
 *   4. A `/dcp` slash command surface for inspecting/controlling DCP.
 *
 * Config lives in ~/.pi-dcp/config.json (auto-created on first run) with
 * optional per-project override at <cwd>/.pi/dcp.json. Session cwd is preferred
 * when available from lifecycle handlers.
 *
 * Bundled skill: plugins/pi-ember-dcp/skills/pi-dcp/ via resources_discover.
 *
 * Prompts: defaults regenerated at init under ~/.pi-dcp/prompts/defaults/;
 * user overrides honoured under ~/.pi-dcp/prompts/overrides/ when
 * `experimental.customPrompts` is enabled.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	TurnStartEvent,
	ToolResultEvent,
	SessionStartEvent,
	SessionShutdownEvent,
	SessionCompactEvent,
	AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import { load_config } from "./lib/config.ts";
import { Logger } from "./lib/logger.ts";
import { run_pipeline } from "./lib/pipeline.ts";
import {
	clear_session_runtime_state,
	create_session_state,
} from "./lib/state.ts";
import { bump_lifetime } from "./lib/stats.ts";
import { make_nudge_handler } from "./lib/nudges.ts";
import {
	notify_pipeline_result,
	refresh_footer_status,
} from "./lib/notifications.ts";
import { PromptStore } from "./lib/prompts/index.ts";
import type { DcpRuntime } from "./lib/runtime.ts";
import { create_compress_message_tool } from "./lib/tools/compress-message.ts";
import { create_compress_range_tool } from "./lib/tools/compress-range.ts";
import { handle_help } from "./lib/commands/help.ts";
import { handle_stats } from "./lib/commands/stats.ts";
import { make_context_command } from "./lib/commands/context.ts";
import { make_manual_command } from "./lib/commands/manual.ts";
import { make_sweep_command } from "./lib/commands/sweep.ts";
import {
	make_decompress_command,
	make_recompress_command,
} from "./lib/commands/decompress.ts";
import {
	save_session_state,
	restore_session_state,
	reset_tracking_after_compaction,
	prune_old_session_files,
} from "./lib/persistence.ts";
import type { AnyMessage } from "./lib/messages.ts";

interface ContextEventResult {
	messages?: ContextEvent["messages"];
}

/**
 * Ember-owned dynamic context pruning extension.
 *
 * Session-replacement safe: jiti may cache this module across /resume|/new|/fork,
 * so session-bound state is cleared on session_shutdown and rebound on session_start.
 */
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(PLUGIN_ROOT, "skills");

export default function piEmberDcpPlugin(pi: ExtensionAPI): void {
	// Prefer process cwd at factory time; session_start rebinds project cwd when present.
	const initial_cwd = process.cwd();
	const initial_config = load_config(initial_cwd);
	const initial_logger = new Logger(initial_config.debug);

	if (!initial_config.enabled) {
		initial_logger.info("pi-ember-dcp disabled via config; skipping wiring");
		return;
	}

	const state = create_session_state();
	// Seed runtime manualMode from config so the user can opt in declaratively.
	state.manualMode = initial_config.manualMode.enabled;

	const runtime: DcpRuntime = {
		cwd: initial_cwd,
		config: initial_config,
		logger: initial_logger,
		prompts: new PromptStore({
			customPromptsEnabled: initial_config.experimental.customPrompts,
		}),
		state,
	};

	bump_lifetime({ sessionsTouched: 1 });

	// Bundled skill directory (package-relative). Discovered after session_start.
	pi.on("resources_discover", async () => ({
		skillPaths: [SKILLS_DIR],
	}));

	// Restore state from previous session if this session was already visited.
	// Session id is only available from lifecycle handlers — never from render.
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			// Prefer the session workspace cwd for project config overrides.
			if (typeof ctx.cwd === "string" && ctx.cwd.length > 0 && ctx.cwd !== runtime.cwd) {
				runtime.cwd = ctx.cwd;
				runtime.config = load_config(runtime.cwd);
				runtime.logger = new Logger(runtime.config.debug);
				runtime.prompts = new PromptStore({
					customPromptsEnabled: runtime.config.experimental.customPrompts,
				});
			}

			// Always reseed manualMode from live config on session replacement.
			// Runtime /dcp manual toggles are not persisted and must not leak
			// across /new|/resume|/fork when the factory closure is jiti-cached.
			state.manualMode = runtime.config.manualMode.enabled;

			const session_id = ctx.sessionManager.getSessionId?.() ?? "";
			runtime.logger.info("session_start fired", {
				reason: event.reason,
				sessionId: session_id || "(empty)",
			});
			if (session_id) {
				state.sessionId = session_id;
				const restored = restore_session_state(session_id, state, runtime.logger);
				if (restored) refresh_footer_status(ctx, state);
			} else {
				runtime.logger.warn(
					"session_start: getSessionId returned empty — persistence disabled for this session",
				);
			}
			// Prune stale session files opportunistically (30-day TTL).
			prune_old_session_files(30, runtime.logger);
		} catch (err) {
			runtime.logger.warn("session_start handler failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// Persist state before pi shuts down or switches sessions, then clear
	// session-bound runtime so a jiti-cached factory cannot leak IDs.
	pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
		try {
			if (state.sessionId) {
				save_session_state(state.sessionId, state, runtime.logger);
			}
		} catch (err) {
			runtime.logger.warn("session_shutdown: failed to save state", {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			clear_session_runtime_state(state);
			// manualMode is reseeded from config on the next session_start.
			state.manualMode = false;
		}
	});

	// After pi's built-in compaction, old tool-call IDs no longer exist in the
	// message stream. Clear all ID-based tracking so stale references don't
	// pollute the pruning strategies. Compressions survive — they were
	// user-requested and the pipeline will just no-op on missing IDs.
	pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
		try {
			reset_tracking_after_compaction(state, runtime.logger);
			// Also reset the cached token count so we don't fire nudges based on
			// pre-compaction usage numbers.
			state.lastKnownTokens = null;
		} catch (err) {
			runtime.logger.warn("session_compact handler failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	runtime.logger.info("pi-ember-dcp initialized", {
		enabled: runtime.config.enabled,
		mode: runtime.config.compress.mode,
		manualMode: state.manualMode,
		customPrompts: runtime.config.experimental.customPrompts,
		hasOverrides: runtime.prompts.has_any_override(),
		strategies: {
			deduplication: runtime.config.strategies.deduplication.enabled,
			purgeErrors: runtime.config.strategies.purgeErrors.enabled,
		},
		compressPermission: runtime.config.compress.permission,
	});

	// 1. The pruning pipeline runs immediately before every LLM call.
	//    Pipeline exceptions pass messages through unchanged so a broken prune
	//    pass cannot destroy a request.
	pi.on("context", (event: ContextEvent, ctx: ExtensionContext): ContextEventResult | void => {
		try {
			const result = run_pipeline(
				event.messages as AnyMessage[],
				runtime.config,
				state,
				runtime.logger,
			);
			notify_pipeline_result(ctx, runtime.config, state, result, runtime.logger);
			return { messages: result.messages as ContextEvent["messages"] };
		} catch (err) {
			runtime.logger.error("pipeline crashed — passing messages through unchanged", {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			});
			return;
		}
	});

	// 2. Track turn index so purgeErrors can age errored calls.
	pi.on("turn_start", (event: TurnStartEvent) => {
		state.turnIndex = event.turnIndex;
	});

	// 2b. Save state after each agent turn completes so compressions survive
	//     crashes between session_shutdown events.
	pi.on("agent_end", (_event: AgentEndEvent, _ctx: ExtensionContext) => {
		try {
			if (state.sessionId) {
				save_session_state(state.sessionId, state, runtime.logger);
			}
		} catch (err) {
			runtime.logger.warn("agent_end: failed to save state", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// 3. Record errored tool results the moment we see them so purgeErrors has
	//    a reliable turn-of-first-observation.
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (!event.isError) return;
		if (!state.erroredAt.has(event.toolCallId)) {
			state.erroredAt.set(event.toolCallId, state.turnIndex);
		}
	});

	// 4. Compress tool: one variant based on configured mode at registration.
	//    Live permission/manual checks still read runtime.config/state.
	if (runtime.config.compress.permission !== "deny") {
		if (runtime.config.compress.mode === "range") {
			pi.registerTool(create_compress_range_tool(runtime));
		} else {
			pi.registerTool(create_compress_message_tool(runtime));
		}
	}

	// 5. Throttled system-prompt nudges (reads live runtime bag each call).
	pi.on("before_agent_start", make_nudge_handler(runtime));

	// 6. /dcp slash commands. Command paths must stay free of render-loop work.
	pi.registerCommand("dcp", {
		description: "Dynamic context pruning — see /dcp for subcommands",
		getArgumentCompletions(prefix) {
			const subs = [
				"context",
				"stats",
				"sweep",
				"manual",
				"decompress",
				"recompress",
				"help",
			];
			return subs
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const sub_args = rest.join(" ");
			try {
				switch (sub) {
					case "":
					case "help":
						return handle_help(sub_args, ctx);
					case "context":
						return make_context_command(state)(sub_args, ctx);
					case "stats":
						return handle_stats(sub_args, ctx);
					case "manual":
						return make_manual_command(state)(sub_args, ctx);
					case "sweep":
						return make_sweep_command(
							state,
							runtime.config,
							runtime.logger,
						)(sub_args, ctx);
					case "decompress":
						return make_decompress_command(state)(sub_args, ctx);
					case "recompress":
						return make_recompress_command(state)(sub_args, ctx);
					default:
						if (ctx.hasUI) {
							ctx.ui.notify(`pi-dcp: unknown subcommand "${sub}"`, "warning");
						}
						return handle_help("", ctx);
				}
			} catch (err) {
				runtime.logger.error("/dcp subcommand failed", {
					sub,
					error: err instanceof Error ? err.message : String(err),
				});
				if (ctx.hasUI) {
					ctx.ui.notify(
						`pi-dcp: /dcp ${sub} failed — ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			}
		},
	});
}
