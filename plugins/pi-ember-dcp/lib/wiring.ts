import type {
	AgentEndEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolResultEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { load_config } from "./config.ts";
import { Logger } from "./logger.ts";
import { run_pipeline } from "./pipeline.ts";
import { clear_session_runtime_state, create_session_state } from "./state.ts";
import { make_nudge_handler } from "./nudges.ts";
import { notify_pipeline_result, refresh_footer_status } from "./notifications.ts";
import { PromptStore } from "./prompts/index.ts";
import type { DcpRuntime } from "./runtime.ts";
import { create_compress_message_tool } from "./tools/compress-message.ts";
import { create_compress_range_tool } from "./tools/compress-range.ts";
import { handle_help } from "./commands/help.ts";
import { handle_stats } from "./commands/stats.ts";
import { make_context_command } from "./commands/context.ts";
import { make_manual_command } from "./commands/manual.ts";
import { make_sweep_command } from "./commands/sweep.ts";
import {
	make_decompress_command,
	make_recompress_command,
} from "./commands/decompress.ts";
import {
	save_session_state,
	restore_session_state,
	reset_tracking_after_compaction,
	prune_old_session_files,
} from "./persistence.ts";
import type { AnyMessage } from "./messages.ts";

interface ContextEventResult {
	messages?: ContextEvent["messages"];
}

export interface WireDcpOptions {
	registerCompressTool?: boolean;
	registerCommands?: boolean;
	registerSkills?: boolean;
	persistSession?: boolean;
	nudges?: boolean;
	/** Bundled skill directory for resources_discover. Omit when registerSkills is false. */
	skillsDir?: string;
}

export const DCP_SUBAGENT_WIRE_OPTIONS: WireDcpOptions = {
	registerCompressTool: false,
	registerCommands: false,
	registerSkills: false,
	persistSession: false,
	nudges: false,
};

export const DCP_FULL_WIRE_OPTIONS: WireDcpOptions = {
	registerCompressTool: true,
	registerCommands: true,
	registerSkills: true,
	persistSession: true,
	nudges: true,
};

/** Create a fresh runtime bag for one DCP wiring instance. */
export function create_dcp_runtime(cwd: string): DcpRuntime {
	const config = load_config(cwd);
	const state = create_session_state();
	state.manualMode = config.manualMode.enabled;
	return {
		cwd,
		config,
		logger: new Logger(config.debug),
		prompts: new PromptStore({
			customPromptsEnabled: config.experimental.customPrompts,
		}),
		state,
	};
}

/**
 * Wire DCP handlers/tools into an ExtensionAPI.
 * Shared by the parent plugin and subagent child sessions.
 */
export function wire_dcp(
	pi: ExtensionAPI,
	runtime: DcpRuntime,
	options: WireDcpOptions = DCP_FULL_WIRE_OPTIONS,
): void {
	const state = runtime.state;
	const register_compress_tool = options.registerCompressTool ?? true;
	const register_commands = options.registerCommands ?? true;
	const register_skills = options.registerSkills ?? true;
	const persist_session = options.persistSession ?? true;
	const nudges = options.nudges ?? true;
	const skills_dir = options.skillsDir;

	if (register_skills && skills_dir) {
		pi.on("resources_discover", async () => ({
			skillPaths: [skills_dir],
		}));
	}

	if (persist_session) {
		pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
			try {
				if (typeof ctx.cwd === "string" && ctx.cwd.length > 0 && ctx.cwd !== runtime.cwd) {
					runtime.cwd = ctx.cwd;
					runtime.config = load_config(runtime.cwd);
					runtime.logger = new Logger(runtime.config.debug);
					runtime.prompts = new PromptStore({
						customPromptsEnabled: runtime.config.experimental.customPrompts,
					});
				}

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
				prune_old_session_files(30, runtime.logger);
			} catch (err) {
				runtime.logger.warn("session_start handler failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

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
				state.manualMode = false;
			}
		});

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
	} else {
		pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
			try {
				if (typeof ctx.cwd === "string" && ctx.cwd.length > 0 && ctx.cwd !== runtime.cwd) {
					runtime.cwd = ctx.cwd;
					runtime.config = load_config(runtime.cwd);
					runtime.logger = new Logger(runtime.config.debug);
					runtime.prompts = new PromptStore({
						customPromptsEnabled: runtime.config.experimental.customPrompts,
					});
				}
				state.manualMode = runtime.config.manualMode.enabled;
				runtime.logger.info("subagent dcp session_start", { reason: event.reason });
			} catch (err) {
				runtime.logger.warn("session_start handler failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
			clear_session_runtime_state(state);
			state.manualMode = false;
		});
	}

	pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
		try {
			reset_tracking_after_compaction(state, runtime.logger);
			state.lastKnownTokens = null;
		} catch (err) {
			runtime.logger.warn("session_compact handler failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on("context", (event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined => {
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

	pi.on("turn_start", (event: TurnStartEvent) => {
		state.turnIndex = event.turnIndex;
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		if (!event.isError) return;
		if (!state.erroredAt.has(event.toolCallId)) {
			state.erroredAt.set(event.toolCallId, state.turnIndex);
		}
	});

	if (register_compress_tool && runtime.config.compress.permission !== "deny") {
		if (runtime.config.compress.mode === "range") {
			pi.registerTool(create_compress_range_tool(runtime));
		} else {
			pi.registerTool(create_compress_message_tool(runtime));
		}
	}

	if (nudges) {
		pi.on("before_agent_start", make_nudge_handler(runtime));
	}

	if (register_commands) {
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
							return make_sweep_command(state, runtime.config, runtime.logger)(
								sub_args,
								ctx,
							);
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
}

/** Whether DCP should wire into a subagent child session for this cwd. */
export function is_dcp_enabled_for_subagent(cwd: string): boolean {
	return load_config(cwd).enabled;
}
