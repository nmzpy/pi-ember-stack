/**
 * Fleet runtime factory (SSOT for "how a background conversation is created").
 *
 * A fleet conversation is a real `AgentSession` running in-process on the main
 * thread, exactly like a subagent: it inherits the parent's canonical
 * `ModelRuntime` (so every registered provider and credential works without
 * re-registration), loads the same child extension set (Ember compaction wiring
 * + bash rules + visual tools), and persists to a normal session file.
 *
 * The difference from a subagent is lifetime and ownership: a fleet session is
 * addressable by name, can be prompted again later, and is released to the TUI
 * (never shared with it) when the user attaches.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	getAgentDir,
	loadProjectContextFiles,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS } from "../pi-custom-agents/edit-tools.ts";
import {
	is_legacy_model_registry,
	resolve_parent_model_runtime,
} from "../pi-custom-agents/model-runtime-bridge.ts";
import {
	build_subagent_settings,
	load_subagent_extensions,
} from "../pi-custom-agents/subagent/extensions/runner.ts";
import type { FleetEvent, FleetSessionFactory } from "./fleet.ts";

/** Parent-session facts a fleet conversation needs; rebound on every session_start. */
export type FleetRuntimeContext = {
	cwd: string;
	model: Model<Api> | undefined;
	model_registry: ModelRegistry | undefined;
	thinking_level?: string | undefined;
};

/** Short, single-line activity text for the fleet list. */
const ACTIVITY_MAX_CHARS = 80;

function clip_activity(text: string): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= ACTIVITY_MAX_CHARS) return clean;
	return `${clean.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;
}

function describe_tool_args(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const field of ["path", "file_path", "filePath", "command", "pattern", "query"]) {
		const value = record[field];
		if (typeof value === "string" && value.trim()) return clip_activity(value);
	}
	return "";
}

/**
 * Map child-session stream events onto the fleet's normalized facts. Kept
 * deliberately small: the fleet list shows one activity line and running usage,
 * not a transcript (the transcript is the session file).
 */
function map_child_event(
	event: {
		type: string;
		assistantMessageEvent?: { type?: string; delta?: string };
		toolName?: string;
		name?: string;
		args?: unknown;
		input?: unknown;
		message?: unknown;
	},
	emit: (event: FleetEvent) => void,
	usage: { turns: number; cost: number; tokens: number },
): void {
	if (event.type === "message_update") {
		const delta = event.assistantMessageEvent;
		if (!delta?.type) return;
		if (delta.type === "thinking_start" || delta.type === "thinking_delta") {
			emit({ type: "activity", text: "thinking…" });
			return;
		}
		if (delta.type === "text_start" || delta.type === "text_delta") {
			const text = typeof delta.delta === "string" ? delta.delta : "";
			if (text) emit({ type: "activity", text: clip_activity(text) });
			return;
		}
		return;
	}
	if (event.type === "tool_execution_start" || event.type === "tool_call") {
		const name = event.toolName ?? event.name ?? "tool";
		const detail = describe_tool_args(event.input ?? event.args);
		emit({ type: "activity", text: detail ? `${name} ${detail}` : name });
		return;
	}
	if (event.type === "message_end") {
		const message = event.message as
			| {
					role?: string;
					usage?: {
						input?: number;
						output?: number;
						totalTokens?: number;
						cost?: { total?: number };
					};
					stopReason?: string;
					errorMessage?: string;
			  }
			| undefined;
		if (message?.role !== "assistant") return;
		if (message.usage) {
			usage.turns += 1;
			usage.tokens +=
				message.usage.totalTokens ?? (message.usage.input ?? 0) + (message.usage.output ?? 0);
			usage.cost += message.usage.cost?.total ?? 0;
			emit({ type: "usage", turns: usage.turns, cost: usage.cost, tokens: usage.tokens });
		}
		if (message.stopReason === "error" && message.errorMessage) {
			emit({ type: "error", message: message.errorMessage });
		}
		return;
	}
	if (event.type === "agent_settled") {
		emit({ type: "settled" });
	}
}

/**
 * Build the production factory. `context` is read per session so a factory
 * created before the first `session_start` still resolves live parent facts.
 */
export function create_fleet_session_factory(
	context: () => FleetRuntimeContext | undefined,
): FleetSessionFactory {
	return async ({ name, cwd, session_file, on_event }) => {
		const parent = context();
		const agent_dir = getAgentDir();
		// Pi defers session-file creation until the first assistant message, so a
		// brand-new conversation reserves its path here and writes it on first use.
		const session_manager = session_file
			? SessionManager.open(session_file, undefined, cwd)
			: SessionManager.create(cwd);
		if (session_manager.getSessionName() !== name) {
			session_manager.appendSessionInfo(name);
		}
		const resolved_session_file = session_manager.getSessionFile() ?? session_file ?? "";

		const extensions = await load_subagent_extensions(cwd);
		const context_files = (() => {
			try {
				return loadProjectContextFiles({ cwd, agentDir: agent_dir });
			} catch {
				return [];
			}
		})();
		const resource_loader = {
			getExtensions: () => extensions,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			// Project context files (AGENTS.md) reach the child through Pi's own
			// system-prompt builder, which is why the custom prompt stays empty —
			// a non-empty custom prompt would REPLACE the standard coding prompt.
			getAgentsFiles: () => ({ agentsFiles: context_files }),
			getSystemPrompt: () => "",
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		// Fleet conversations inherit the parent model, so they carry the same
		// absolute auto-compaction ceiling as every other Ember session.
		const settings_manager = SettingsManager.inMemory(build_subagent_settings(parent?.model));
		const session_options: Record<string, unknown> = {
			cwd,
			resourceLoader: resource_loader,
			tools: [...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS],
			sessionManager: session_manager,
			settingsManager: settings_manager,
		};
		if (parent?.model) session_options.model = parent.model;
		if (parent?.thinking_level) session_options.thinkingLevel = parent.thinking_level;
		const model_runtime = resolve_parent_model_runtime(parent?.model_registry);
		if (model_runtime) {
			session_options.modelRuntime = model_runtime;
		} else if (parent?.model_registry && is_legacy_model_registry(parent.model_registry)) {
			session_options.modelRegistry = parent.model_registry;
		}

		const created = await createAgentSession(session_options);
		const session = created.session;
		const usage = { turns: 0, cost: 0, tokens: 0 };
		const unsubscribe = session.subscribe((event) => {
			map_child_event(event as Parameters<typeof map_child_event>[0], on_event, usage);
		});

		return {
			session_file: resolved_session_file,
			handle: {
				prompt: (text: string) => session.prompt(text),
				abort: () => session.abort(),
				dispose: () => {
					try {
						unsubscribe();
					} catch {
						/* already disposed */
					}
					session.dispose();
				},
			},
		};
	};
}
