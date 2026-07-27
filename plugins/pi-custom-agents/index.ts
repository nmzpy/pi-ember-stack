/**
 * Pi Custom Agents — Primary Modes Extension
 *
 * Toggleable primary modes for the Ember project, mirroring opencode's
 * mode: primary agents. Each mode is a slash command that:
 *   - Restricts the active tool set
 *   - Injects a persisted system-reminder message (visible to the LLM)
 *   - Shows a status-bar indicator
 *   - Restores state on session resume
 *
 * Modes:
 *   /plan         — read-only planning, analysis, and architecture
 *   /code         — full access (default mode, restores all tools)
 *   /debug        — read-only health-check auditor + UI/Qt diagnostics
 *   /orchestrate  — read-only task decomposition + delegation planner
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	CustomEditor,
	type KeybindingsManager,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { install_bash_rules } from "./bash-rules.ts";
import { install_bash_timeout } from "./bash-timeout.ts";
import { validate_plan_mode_subagent } from "./subagent-policy.ts";
import {
	mutedBullet,
	setActiveMode,
	setPlanAutoContinuing,
	setShellMode,
} from "../pi-ember-ui/mode-colors.ts";
import { set_extension_selector_options } from "../pi-ember-ui/select-list-theme.ts";
import { format_model_effort_suffix } from "../pi-ember-ui/model-variants.ts";
import {
	cancelPendingModelPick,
	consumePendingShellSubmitEnter,
	finalizeEditorInputAfter,
	interceptShellInput,
	modelNameHasThinkingVariant,
	pickModelInEditor,
	processShellInput,
	refresh_footer,
	requestShellModeVisualRefresh,
	syncShellModeFromEditorText,
	requestTuiRender,
	resetSlashCommandTracking,
	scheduleFooterStats,
	setModeLabelResolver,
	setFooterThinkingLevel,
	wrapEditorRenderForShell,
	wrapModelPickerEditor,
} from "../pi-ember-ui/index.ts";
import { with_suppressed_shell_history_sync as withSuppressedShellHistorySync } from "../pi-ember-ui/shell-mode.ts";
import { askQuiz, type QuizQuestion, registerQuizTool } from "./quiz-tool.ts";
import {
	build_auto_continue_content,
	is_benign_compact_error,
	should_skip_compact,
} from "./auto-continue.ts";
import install_compaction_wiring from "./compaction-wiring.ts";
import {
	build_full_tools,
	model_provider_of,
	resolve_patch_tool_name,
	SUBAGENT_DELEGATION_TOOLS,
} from "./edit-tools.ts";
import {
	bind_mode_model,
	bound_identity_uses_baked_effort,
	bound_model_matches_live,
	canonicalize_persisted_identity,
	get_mode_model,
	get_pi_thinking_level,
	identities_equal,
	model_identity_of,
	model_identity_from_user_selection,
	normalize_mode_models,
	normalize_thinking_level,
	PI_AGENTS_BIND_MODE_MODEL_EVENT,
	type ModelIdentity,
} from "./mode-models.ts";
import { build_plan_implement_message_content } from "./plan-implement.ts";
import { get_new_session_fn, install_new_session_capture } from "./plan-fresh-session.ts";
import { arm_plan_turn, build_plan_review_questions, resolve_plan_review_answer, should_show_plan_review } from "./plan-review.ts";
import subagentPlugin from "./subagent/extensions/index.ts";
import { isGenericAbortMessage } from "./subagent/extensions/runner.ts";

/**
 * Promisify ctx.compact() into a result discriminated union.
 * Never throws — both callback errors and synchronous throws are caught.
 */
function compact_async(ctx: any): Promise<{ ok: true } | { ok: false; error: Error }> {
	return new Promise((resolve) => {
		try {
			ctx.compact({
				onComplete: () => resolve({ ok: true }),
				onError: (err: unknown) => {
					const error = err instanceof Error ? err : new Error(String(err));
					resolve({ ok: false, error });
				},
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			resolve({ ok: false, error });
		}
	});
}

function stable_serialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stable_serialize).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stable_serialize(entry)}`)
		.join(",")}}`;
}

function tool_call_signature(tool_name: string, input: unknown): string {
	return `${tool_name}:${stable_serialize(input)}`;
}

function is_non_generic_error(message: string | undefined): boolean {
	return Boolean(message) && !isGenericAbortMessage(message);
}

function assistant_text(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "assistant" || !Array.isArray(record.content)) return "";
	return record.content
		.filter(
			(item): item is { type?: unknown; text?: unknown } =>
				item !== null && typeof item === "object",
		)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("");
}

/**
 * CustomEditor handles app.clear (Ctrl+C) before Editor.handleInput, so Pi never
 * runs the autocomplete cancel path (tui.select.cancel is also Ctrl+C). Cancel
 * autocomplete first so clear/quit does not leave a stale overlay or stall exit.
 */
function prepare_app_clear_input(data: string, editor: any): void {
	if (!getKeybindings().matches(data, "app.clear")) return;
	editor.cancelAutocomplete?.();
}

function intercept_slash_escape(data: string, editor: any): boolean {
	if (!matchesKey(data, "escape")) return false;
	const text = editor.getText?.() ?? "";
	if (!text.trimStart().startsWith("/")) return false;
	cancelPendingModelPick();
	editor.cancelAutocomplete?.();
	editor.setText?.("");
	finalizeEditorInputAfter(editor);
	return true;
}

type PersistedState = {
	readonly mode?: string;
	/** @deprecated migrated into modeModels; stop writing */
	readonly model?: ModelIdentity;
	readonly modeModels?: Readonly<Partial<Record<string, ModelIdentity>>>;
};

function getPersistedStatePath(): string {
	const home =
		process.env.PI_HOME ||
		path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
	return path.join(home, "pi-ember-stack.json");
}

function readPersistedState(): PersistedState {
	try {
		const raw = JSON.parse(fs.readFileSync(getPersistedStatePath(), "utf8")) as Record<
			string,
			unknown
		>;
		const mode = typeof raw.mode === "string" ? raw.mode : undefined;
		const modeModels = normalize_mode_models(raw.modeModels);
		// Migration: if legacy top-level `model` exists and modeModels lacks an
		// entry for the persisted mode (fallback DEFAULT_MODE/"code"), seed only
		// that one mode. Never fan-out legacy model to all modes.
		const legacyModel = raw.model;
		if (
			legacyModel &&
			typeof legacyModel === "object" &&
			!Array.isArray(legacyModel) &&
			typeof (legacyModel as Record<string, unknown>).provider === "string" &&
			typeof (legacyModel as Record<string, unknown>).modelId === "string"
		) {
			const migrationMode = mode && mode in MODES ? mode : DEFAULT_MODE;
			if (!get_mode_model(modeModels, migrationMode)) {
				modeModels[migrationMode] = {
					provider: (legacyModel as Record<string, unknown>).provider as string,
					modelId: (legacyModel as Record<string, unknown>).modelId as string,
				};
			}
		}
		return { mode, modeModels };
	} catch {
		return {};
	}
}

function writePersistedState(state: {
	readonly mode?: string;
	readonly modeModels?: Partial<Record<string, ModelIdentity>>;
}): void {
	const file = getPersistedStatePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			// file doesn't exist or is invalid — start fresh
		}
		const merged = { ...existing } as Record<string, unknown>;
		// modeModels is the sole authority for per-mode model bindings.
		// Actively delete the legacy top-level `model` key so dual-truth dies.
		delete merged.model;
		if (state.mode !== undefined) merged.mode = state.mode;
		merged.modeModels = state.modeModels ?? {};
		fs.writeFileSync(file, `${JSON.stringify(merged, null, "\t")}\n`);
	} catch {
		// best-effort persistence
	}
}

// Web-access tools are read-only research tools (web_search, fetch_content,
// get_search_content) registered by the pi-ember-webtools plugin. They belong in
// every mode so the agent can do web research regardless of mode.
const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content"];
const BASE_RESEARCH_TOOLS = ["read", "grep", "find", "ls", "quiz", "todo", ...WEB_ACCESS_TOOLS];
const READONLY_TOOLS = [...BASE_RESEARCH_TOOLS];
const READONLY_DELEGATING_TOOLS = [...BASE_RESEARCH_TOOLS, ...SUBAGENT_DELEGATION_TOOLS];
function mode_tools_for_provider(modeId: string, provider: string | undefined): string[] {
	if (modeId === "code") return build_full_tools(provider);
	return MODES[modeId]?.tools ?? build_full_tools(provider);
}

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUBAGENT_FILES: Record<string, string> = {
	coder: path.join(SOURCE_ROOT, "subagent", "agents", "coder.md"),
	scout: path.join(SOURCE_ROOT, "subagent", "agents", "scout.md"),
};

const SUBAGENT_AGENT_KEYS = ["coder", "scout"] as const;
type SubagentAgentKey = (typeof SUBAGENT_AGENT_KEYS)[number];

let last_subagent_model_agent: SubagentAgentKey = "coder";

function subagent_agent_label(key: SubagentAgentKey): string {
	return key === "coder" ? "Coder" : "Scout";
}

function read_subagent_frontmatter_value(filePath: string, field: string): string | undefined {
	const content = fs.readFileSync(filePath, "utf-8");
	const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : undefined;
}

function parse_configured_model_ref(
	model_ref: string | undefined,
): { provider: string; id: string } | undefined {
	if (!model_ref || model_ref === "inherits parent") return undefined;
	const slash = model_ref.indexOf("/");
	if (slash <= 0) return undefined;
	return {
		provider: model_ref.slice(0, slash),
		id: model_ref.slice(slash + 1),
	};
}

function build_subagent_selector_options(): Array<{ label: string; description: string }> {
	const options = SUBAGENT_AGENT_KEYS.map((key) => {
		const filePath = SUBAGENT_FILES[key];
		const model = read_subagent_frontmatter_value(filePath, "model") ?? "inherits parent";
		return {
			key,
			label: subagent_agent_label(key),
			description: model,
		};
	});
	options.sort((a, b) => {
		if (a.key === last_subagent_model_agent) return -1;
		if (b.key === last_subagent_model_agent) return 1;
		return a.label.localeCompare(b.label);
	});
	return options.map(({ label, description }) => ({ label, description }));
}

const PARALLEL_TOOL_CALL_GUIDANCE = `

Tool Call Efficiency:

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching saves round-trips and reduces latency.
`;

const OUTPUT_STYLE_DIRECTIVE = `

Output style: Reply in plain dense text. No markdown headers (#, ##, ###), no
bold or italics (**, *), no decorative bulleted lists (-, *). Use short labeled
lines (Label: value) or compact key: value pairs. Keep code fences only for
multi-line code blocks. Be concise.
`;

const PLAN_OUTPUT_STYLE_DIRECTIVE = `

Output style: Use markdown for structure. Prefer ## and ### section headers,
**bold** for emphasis, and bullet lists where they aid scanability. Keep code
fences for multi-line code blocks. Be concise and dense — no filler prose.
`;

const SUBAGENT_AWARENESS_PROMPT = `

Available subagents:
- Scout: fast codebase reconnaissance; use to find files, patterns, and answers.
- Coder: implementation agent with full tool access; use for edits, tests, and verification.

Modes: single {agent, task}, parallel {tasks: [...]} (max 8, 4 concurrent), chain {chain: [...]} (sequential with {previous}). Use subagent_resume with a lettered name (e.g. Coder A) to continue a prior single-mode subagent run. Agent names are case-insensitive and surrounding whitespace is ignored.
`;

const PLAN_SUBAGENT_AWARENESS_PROMPT = `

Available subagents (exploration only):
- Scout: fast codebase reconnaissance; delegate broad search or discovery work so results stay in isolated context.

Plan mode allows Scout subagent only — not Coder or other implementation agents. Modes: single {agent: "Scout", task}, parallel {tasks: [...]} (max 8), chain {chain: [...]} (Scout steps only). Use subagent_resume with a lettered Scout name (e.g. Scout A) to continue a prior exploration run.
`;

function format_available_tools(tools: string[]): string {
	return [...tools].sort().join(", ");
}

function mode_intro(mode: string, tools: string[], extra = ""): string {
	const base = `Mode: ${mode}. Available tools: ${format_available_tools(tools)}.`;
	return extra ? `${base} ${extra}` : base;
}

function compose_mode_prompt(body: string): string {
	const style = OUTPUT_STYLE_DIRECTIVE.trim();
	return `${body}

${style}`;
}

function compose_plan_prompt(body: string): string {
	const style = PLAN_OUTPUT_STYLE_DIRECTIVE.trim();
	return `${body}

${style}`;
}

const ARCHITECT_PROMPT = compose_plan_prompt(`Plan mode is active. You are read-only. Do not edit, write, or run mutating shell commands. Ask clarifying questions via the quiz tool when tradeoffs exist.

${mode_intro(
	"plan",
	READONLY_DELEGATING_TOOLS,
	"Delegate broad codebase exploration to the Scout subagent when it would flood this context; otherwise use read/grep/find directly. If implementation is needed, produce a plan and wait for the user to approve it.",
)}${PLAN_SUBAGENT_AWARENESS_PROMPT}

Responsibility: explore, analyze, and produce a well-researched, actionable plan. Tie loose ends before implementation begins.

Planning requirements:
- Quiz unresolved forks before emitting the plan; the plan must pick one concrete approach (no Option A/B inside the plan). Do not emit an Open Questions section.
- Prefer problems and observable behavior over implementation detail in Summary, Problems, and Behavior.
- Each module maps to one logical change with one file owner. For every module include: action, Files (full paths), What (precise change), Why (rationale tied to Problems), Risks (regression surfaces), Cleanup (obsolete code made unreachable, or none), Validation (e.g. bash t.gate.sh <files>).
- When state or settings are involved: name storage key, default, raw vs display, canonical reader/writer, and what must never be written; load/hydrate before UI or controller construction; do not let feature code own a second persistence path. Persistence and Interfaces may be n/a when irrelevant.
- When replacing a control or path: preserve existing config keys and legal values unless the task explicitly migrates them; disable or collapse must not leave layout or ownership artifacts.
- If architecture, ownership, or persistence rules change, include an AGENTS.md (or plugin AGENTS.md) docs module that records durable rules, not patch history.
- Keep Investigation with file:line evidence; scale section depth to change size.

Output format — use markdown section headers and bullets:

## Task
<one-sentence goal>

## Investigation
<files read, patterns found, relevant file:line references>

## Summary
- <user-visible result>
- <architectural direction>
- <behavior that must remain unchanged>
- <persistence or ownership model when relevant>

## Problems
- <only the problems this change solves>

## Behavior
- <observable invariants and capability constraints>

## Plan

### Module 1: <action>
- **Files:** <paths>
- **What:** <change>
- **Why:** <rationale tied to Problems>
- **Risks:** <regression surfaces>
- **Cleanup:** <obsolete code to remove, or none>
- **Validation:** bash t.gate.sh <files>

### Module 2: <action>
- **Files:** <paths>
- **What:** <change>
- **Why:** <rationale tied to Problems>
- **Risks:** <regression surfaces>
- **Cleanup:** <obsolete code to remove, or none>
- **Validation:** bash t.gate.sh <files>

## Persistence
<keys, defaults, canonical read/write, forbidden stores; or n/a>

## Interfaces
<contracts to add/change; or n/a>

## Test Plan
- <pure logic / persistence / mapping / architecture checks as relevant>
- **Exclusions:** <intentional non-coverage>

## Non-Goals
- <explicitly out of scope>

## Assumptions
- <defaults taken when quiz was unnecessary>

## Working Tree
- Preserve unrelated uncommitted work; scope the patch to this plan; do not revert or reformat unrelated files.

## Acceptance Criteria
- <user-visible>
- <persistence/SSOT when relevant>
- <architecture / no duplicate ownership>
- <backward compatibility>
- <cleanup complete>
- <named suites pass>`);

const DOCTOR_PROMPT = compose_mode_prompt(`Debug mode is active. You are read-only. Investigate, diagnose, and report findings. Do not edit, write, or run mutating shell commands.

${mode_intro(
	"debug",
	READONLY_DELEGATING_TOOLS,
	"Delegate implementation to the Coder subagent when a fix is straightforward; otherwise report the issue and recommended correction.",
)}${SUBAGENT_AWARENESS_PROMPT}

Focus areas: ownership conflicts, hidden coupling, duplicated state or mirrored config, SSOT violations, fail-fast behavior, and high-change-entropy files. Label each finding as 'Confirmed issue' or 'Needs owner decision' and include File, Evidence, Impact, Correction, and Risks.

Output format — plain labeled lines, no markdown headers or bullets:

Classification: <Confirmed issue | Needs owner decision>
Category: <focus area>
File: <file_path:line_number>
Evidence: <tool output or call-site proof>
Impact: <what breaks or degrades>
Correction: <smallest architectural change>
Risks: <regression surfaces>`);

const ORCHESTRATOR_PROMPT = compose_mode_prompt(`Orchestrate mode is active. You are read-only. Decompose work into self-contained modules and delegate implementation to the Coder subagent. Do not edit, write, or run mutating shell commands yourself.

${mode_intro(
	"orchestrate",
	READONLY_DELEGATING_TOOLS,
	"Subagent delegation is your primary mechanism for getting work done.",
)}${SUBAGENT_AWARENESS_PROMPT}

Decomposition rules:
- One owner per file; if two modules need the same file, merge them or extract a prerequisite module.
- Right-size modules so each can be validated with bash t.gate.sh <files>.
- Group independent modules into parallel clusters; chain dependent modules.
- Pin shared interfaces in every dependent subagent prompt.

Delegation prompt quality: include goal, exact owned files with "do not touch anything else", anchored context (file:line references), interface contract, step sequence, AGENTS.md constraints, acceptance criteria, validation command, risks, and edge cases.

Output format — plain labeled lines, no markdown headers or bullets:

Task Summary: <one-sentence goal>

Modules:

Module 1: <name>
  Owned files: <full paths>
  Goal: <what this module achieves>
  Dependencies: <none | Module N>
  Parallel cluster: <A | B | sequential>
  Steps:
    1. <step>
    2. <step>
  Acceptance: <done criteria>
  Validation: bash t.gate.sh <files>
  Risks: <regression surfaces>

Module 2: <name>
  ...

Execution Order:
  1. Cluster A (parallel): Module 1, Module 2
  2. Cluster B (parallel): Module 3, Module 4

Delegation Prompts: <self-contained prompt for each module, ready for the Coder subagent>`);

function coder_prompt(provider: string | undefined): string {
	return compose_mode_prompt(`Code mode is active. You have full tool access. Implement, test, and verify code with autonomy.

${mode_intro("code", build_full_tools(provider))}`);
}

function exit_to_coder_prompt(provider: string | undefined): string {
	return compose_mode_prompt(`You have switched from {mode} mode to code mode. You now have full tool access.

${mode_intro("code", build_full_tools(provider))}`);
}

function plan_implement_prompt(
	provider: string | undefined,
	plan_reference: "above" | "below" = "above",
): string {
	return compose_mode_prompt(`The user has approved the plan ${plan_reference}. Execute it now in full.

Follow the plan modules in order. Implement, test, and verify each module before moving to the next. Run bash t.gate.sh <files> after each logical change. Report what you did and any deviations from the plan.

${mode_intro("code", build_full_tools(provider), "")}`);
}

function mode_reminder(modeId: string, provider: string | undefined): string {
	switch (modeId) {
		case "plan":
			return ARCHITECT_PROMPT;
		case "code":
			return coder_prompt(provider);
		case "debug":
			return DOCTOR_PROMPT;
		case "orchestrate":
			return ORCHESTRATOR_PROMPT;
		default:
			return MODES[modeId]?.enterMessage ?? coder_prompt(provider);
	}
}

function exit_mode_reminder(fromModeId: string, provider: string | undefined): string {
	if (fromModeId === "plan") return exit_to_coder_prompt(provider);
	return mode_reminder(fromModeId, provider);
}

interface ModeConfig {
	id: string;
	label: string;
	icon: string;
	color: string;
	tools: string[];
	enterMessage: string;
	exitMessage: string;
}

const MODES: Record<string, ModeConfig> = {
	plan: {
		id: "plan",
		label: "plan",
		icon: "P",
		color: "warning",
		tools: READONLY_DELEGATING_TOOLS,
		enterMessage: ARCHITECT_PROMPT,
		exitMessage: exit_to_coder_prompt(undefined),
	},
	code: {
		id: "code",
		label: "code",
		icon: "C",
		color: "success",
		tools: build_full_tools(undefined),
		enterMessage: coder_prompt(undefined),
		exitMessage: coder_prompt(undefined),
	},
	debug: {
		id: "debug",
		label: "debug",
		icon: "D",
		color: "warning",
		tools: READONLY_DELEGATING_TOOLS,
		enterMessage: DOCTOR_PROMPT,
		exitMessage: exit_to_coder_prompt(undefined),
	},
	orchestrate: {
		id: "orchestrate",
		label: "orchestrate",
		icon: "O",
		color: "warning",
		tools: READONLY_DELEGATING_TOOLS,
		enterMessage: ORCHESTRATOR_PROMPT,
		exitMessage: exit_to_coder_prompt(undefined),
	},
};

const MODE_IDS = Object.keys(MODES);
const DEFAULT_MODE = "code";
const CYCLE_ORDER = ["code", "plan", "orchestrate", "debug"];

function getLastModeFromSession(ctx: any): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom_message") {
			const customEntry = entry as any;
			if (customEntry.customType?.startsWith("pi-agents-enter-")) {
				return customEntry.customType.replace("pi-agents-enter-", "");
			}
			if (customEntry.customType === "pi-agents-exit") {
				return DEFAULT_MODE;
			}
		}
	}
	return null;
}

const MODE_LIVE_RENDER_STATUS = "pi-agents-mode-live-render";

export default async function piCustomAgentsPlugin(pi: any): Promise<void> {
	install_new_session_capture();
	install_bash_rules(pi);
	install_bash_timeout(pi);
	install_compaction_wiring(pi);

	let currentMode: string = DEFAULT_MODE;
	let lastMessagedMode: string | null = null;
	let waitingForPlan = false;
	let latest_plan_text = "";
	let active_session_manager: any;
	let session_ready = false;
	let pending_mode_id: string | undefined;

	function is_live_session(ctx: any): boolean {
		return session_ready && ctx.sessionManager === active_session_manager;
	}

	function request_live_mode_render(ctx: any): void {
		if (ctx.mode === "tui") {
			// setStatus only invalidates the footer/editor frame. Do not append a
			// transcript notification or invalidate the resumed chat history.
			ctx.ui.setStatus(MODE_LIVE_RENDER_STATUS, undefined);
		}
	}

	const persistedAtLoad = readPersistedState();
	if (persistedAtLoad.mode && persistedAtLoad.mode in MODES) {
		setActiveMode(persistedAtLoad.mode);
		currentMode = persistedAtLoad.mode;
	}

	// Per-mode model memory: each mode remembers its own last user-selected
	// model. Loaded once at factory start and re-read on session_start; updated
	// in-memory on bind and written through on changes.
	let mode_models: Partial<Record<string, ModelIdentity>> = {
		...(persistedAtLoad.modeModels ?? {}),
	};
	// Suppress bind during our own programmatic setModel (mode restore).
	let applying_mode_model = false;
	let applying_mode_thinking_level = false;
	// Stale async apply guard — incremented at each apply_mode start.
	let mode_apply_generation = 0;

	function bind_current_mode_model(identity: ModelIdentity): void {
		const canonical = canonicalize_persisted_identity(identity);
		const existing = get_mode_model(mode_models, currentMode);
		if (!identities_equal(existing, canonical)) {
			mode_models = bind_mode_model(mode_models, currentMode, canonical);
			writePersistedState({ mode: currentMode, modeModels: mode_models });
		}
	}

	function sync_footer_after_model_restore(ctx: any): void {
		setFooterThinkingLevel(get_pi_thinking_level(pi) ?? "off");
		refresh_footer(ctx);
	}

	pi.events.on(
		PI_AGENTS_BIND_MODE_MODEL_EVENT,
		(payload: {
			provider: string;
			modelId: string;
			name?: string;
			thinkingLevel?: string;
			syncThinkingLevelToPi?: boolean;
		}) => {
			const identity = model_identity_from_user_selection(
				{ provider: payload.provider, id: payload.modelId, name: payload.name },
				{
					thinkingLevel: payload.thinkingLevel,
					syncThinkingLevelToPi: payload.syncThinkingLevelToPi,
				},
			);
			if (identity) bind_current_mode_model(identity);
		},
	);

	async function apply_bound_thinking_level(ctx: any, bound: ModelIdentity): Promise<void> {
		if (!bound.thinkingLevel || bound_identity_uses_baked_effort(bound)) return;
		const model = ctx.model as Model<any> | undefined;
		const modelName = model?.name ?? model?.id ?? "";
		if (modelNameHasThinkingVariant(modelName)) return;
		applying_mode_thinking_level = true;
		try {
			const setLevel = (pi as { setThinkingLevel?: (level: string) => Promise<void> | void })
				.setThinkingLevel;
			if (typeof setLevel === "function") {
				await setLevel.call(pi, bound.thinkingLevel);
			}
			setFooterThinkingLevel(bound.thinkingLevel);
		} finally {
			applying_mode_thinking_level = false;
		}
	}

	async function apply_bound_model(ctx: any, bound: ModelIdentity): Promise<void> {
		const canonical = canonicalize_persisted_identity(bound);
		const current = ctx.model as Model<any> | undefined;
		const liveThinking = get_pi_thinking_level(pi);
		if (bound_model_matches_live(canonical, current, liveThinking)) return;

		const target = ctx.modelRegistry.find(
			canonical.provider,
			canonical.modelId,
		) as Model<any> | undefined;
		const needs_model =
			current?.provider !== canonical.provider || current?.id !== canonical.modelId;
		if (needs_model && (!target || !ctx.modelRegistry.hasConfiguredAuth(target))) return;

		applying_mode_model = true;
		try {
			if (needs_model && target) {
				await pi.setModel(target);
			}
			await apply_bound_thinking_level(ctx, canonical);
			sync_footer_after_model_restore(ctx);
		} finally {
			applying_mode_model = false;
		}
	}

	// Register the canonical mode-id → label resolver so the pi-ember-ui
	// footer can render the active mode label without duplicating the MODES
	// map. MODES stays the single source of truth for mode labels here.
	setModeLabelResolver((modeId: string) => MODES[modeId]?.label ?? modeId);

	registerQuizTool(pi);

	for (const modeId of MODE_IDS) {
		const mode = MODES[modeId];
		pi.events.emit("powerbar:register-segment", {
			id: `pi-agents-${modeId}`,
			label: `${mode.label} mode`,
		});
	}

	function updateStatus(ctx: any): void {
		pi.events.emit("powerbar:update", {
			id: `pi-agents-${currentMode}`,
			text: MODES[currentMode].label,
			icon: MODES[currentMode].icon,
			color: currentMode === DEFAULT_MODE ? "success" : MODES[currentMode].color,
		});
		for (const modeId of MODE_IDS) {
			if (modeId === currentMode) continue;
			pi.events.emit("powerbar:update", {
				id: `pi-agents-${modeId}`,
				text: undefined,
			});
		}
		request_live_mode_render(ctx);
	}

	function sync_active_tools(ctx: any): void {
		if (currentMode !== "code") return;
		pi.setActiveTools(build_full_tools(model_provider_of(ctx.model)));
	}

	async function apply_mode(modeId: string, ctx: any): Promise<void> {
		const mode = MODES[modeId];
		if (!mode) return;

		const prevModeId = currentMode;
		const prevMode = MODES[prevModeId];
		const provider = model_provider_of(ctx.model);

		// Mode changes are deliberately live-only. The active tool set and the
		// next-turn prompt change immediately, while the transcript stays lazy
		// and cached.
		currentMode = modeId;
		setActiveMode(modeId);
		pi.setActiveTools(mode_tools_for_provider(modeId, provider));
		pi.events.emit("pi-ember-ui:mode-change", { mode: modeId, liveOnly: true });
		updateStatus(ctx);

		// Remind the model which tools it lost and which it now has whenever the
		// mode (and therefore the tool set) actually changes. Hidden so it steers
		// the next turn without cluttering the transcript — same channel as the
		// plan-auto-continue and loop-retry hidden messages.
		if (prevMode && prevModeId !== modeId) {
			const prevTools = mode_tools_for_provider(prevModeId, provider);
			const newTools = mode_tools_for_provider(modeId, provider);
			const lost = prevTools.filter((t) => !newTools.includes(t));
			const gained = newTools.filter((t) => !prevTools.includes(t));
			const lines: string[] = [
				`You have switched from ${prevMode.label} mode to ${mode.label} mode.`,
			];
			if (lost.length > 0) {
				lines.push(
					`You no longer have access to these tools: ${lost.join(", ")}. Do not attempt to call them.`,
				);
			}
			if (gained.length > 0) {
				lines.push(`You now also have access to: ${gained.join(", ")}.`);
			}
			lines.push(`Your current tool set is: ${newTools.join(", ")}.`);
			pi.sendMessage({
				customType: "pi-agents-tool-access",
				content: lines.join("\n"),
				display: false,
			});
		}

		// Per-mode model restore: if this mode has a bound model and it differs
		// from the live model (or effort variant), restore it. Fail soft on
		// missing auth — leave the live model, no throw.
		const my_generation = ++mode_apply_generation;
		const bound = get_mode_model(mode_models, modeId);
		if (my_generation !== mode_apply_generation) return;
		if (bound) {
			await apply_bound_model(ctx, bound);
		}
		writePersistedState({ mode: currentMode, modeModels: mode_models });
	}

	async function switchMode(modeId: string, ctx: any): Promise<void> {
		if (!MODES[modeId]) return;
		if (!is_live_session(ctx)) {
			// Queue only for the session that is currently binding. Never retain a
			// request from an old session, where pi.setActiveTools would be stale.
			if (ctx.sessionManager === active_session_manager) pending_mode_id = modeId;
			return;
		}
		await apply_mode(modeId, ctx);
	}

	for (const modeId of MODE_IDS) {
		const mode = MODES[modeId];
		pi.registerCommand(modeId, {
			description: `Toggle ${mode.label} mode${
				modeId === DEFAULT_MODE ? " (full access)" : " (read-only)"
			}`,
			handler: async (_args: any, ctx: any) => {
				if (currentMode === modeId) {
					await switchMode(DEFAULT_MODE, ctx);
				} else {
					await switchMode(modeId, ctx);
				}
			},
		});
	}

	const cycleMode = async (ctx: any): Promise<void> => {
		const baseMode = pending_mode_id ?? currentMode;
		const idx = CYCLE_ORDER.indexOf(baseMode);
		const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
		await switchMode(next, ctx);
	};

	pi.registerShortcut("tab", {
		description: "Cycle agent mode",
		handler: cycleMode,
	});

	let thinking_editor_installed = false;

	const install_thinking_editor = (ctx: any): void => {
		if (!ctx.hasUI) return;
		if (thinking_editor_installed) return;

		const previous_editor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor =
				previous_editor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			// Also apply the shell-aware render wrap at instance level. Pi can load
			// @earendil-works/pi-tui from a different module copy than the extension,
			// so the prototype patch in pi-ember-ui/index.ts may not affect the live
			// Editor class that actually renders the chatbox.
			wrapEditorRenderForShell(editor);
			const original_handle_input = editor.handleInput.bind(editor);
			editor.handleInput = (data: string): void => {
				prepare_app_clear_input(data, editor);
				const shellResult = processShellInput(data, editor);
				if (shellResult?.consume) {
					requestShellModeVisualRefresh(editor, ctx);
					return;
				}
				if (shellResult?.data !== undefined && shellResult.data !== data) {
					data = shellResult.data;
				}
				if (interceptShellInput(data, editor)) {
					// Shell mode was entered/exited — the editor text didn't change
					// (empty → empty) so Pi's differential renderer won't re-render
					// the chatbox row. Force a render so the prompt glyph (`>` ↔ `!`)
					// and border color update immediately, and refresh the footer so
					// the left stats flip to / from `shell`.
					requestShellModeVisualRefresh(editor, ctx);
					return;
				}
				if (intercept_slash_escape(data, editor)) return;
				// Detect the thinking-blocks toggle (Ctrl+T by default, user-remappable)
				// before Pi's handler runs. Component-tree changes are followed by
				// one normal public render request; Pi owns shrink handling and all
				// differential bookkeeping.
				const is_thinking_toggle = getKeybindings().matches(data, "app.thinking.toggle");

				// Suppress thinking-level cycling for provider-locked model variants
				// (e.g. "Grok 4.5 High") so the user does not see "Thinking level: off"
				// / "Thinking level: high" flip-flops with no effect.
				const is_thinking_cycle = getKeybindings().matches(data, "app.thinking.cycle");
				if (is_thinking_cycle && ctx.model) {
					const modelName = ctx.model.name ?? ctx.model.id ?? "";
					if (modelNameHasThinkingVariant(modelName)) {
						ctx.ui.notify(
							"Switching thinking variant suppressed. Using provider-locked model variant.",
							"info",
						);
						return;
					}
				}

				original_handle_input(data);

				// History restore (up/down arrows) can land a previously-submitted
				// bash command like `!git status` in the editor body. Convert that
				// into shell mode so the `!` is rendered as the prompt glyph and the
				// body is just `git status`. Skip after shell-mode Enter submit: the
				// `!` prefix is intentional for Pi's bash handler and must not be
				// stripped back into the chatbox.
				if (consumePendingShellSubmitEnter()) {
					withSuppressedShellHistorySync(() => editor.setText?.(""));
					requestShellModeVisualRefresh(editor, ctx);
				} else if (syncShellModeFromEditorText(editor)) {
					requestShellModeVisualRefresh(editor, ctx);
				}

				finalizeEditorInputAfter(editor);
				if (is_thinking_toggle) {
					queueMicrotask(() => requestTuiRender());
				}
			};
			wrapModelPickerEditor(editor, pi, ctx);
			return editor;
		});
		thinking_editor_installed = true;
	};

	pi.registerCommand("subagent-model", {
		description: "Set the model and thinking level for subagents on next spawn",
		handler: async (_args: any, ctx: any) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("subagent-model requires interactive UI.", "error");
				return;
			}
			const selector_options = build_subagent_selector_options();
			set_extension_selector_options(selector_options);
			let agentChoice: string | undefined;
			try {
				agentChoice = await ctx.ui.select(
					"Subagent to configure",
					selector_options.map((option) => option.label),
				);
			} finally {
				set_extension_selector_options(undefined);
			}
			if (!agentChoice) return;
			const agentKey = agentChoice.toLowerCase() as SubagentAgentKey;
			last_subagent_model_agent = agentKey;
			const filePath = SUBAGENT_FILES[agentKey];
			if (!filePath || !fs.existsSync(filePath)) {
				ctx.ui.notify(`Agent file not found: ${filePath ?? agentKey}`, "error");
				return;
			}
			let currentContent = fs.readFileSync(filePath, "utf-8");
			const currentModelMatch = currentContent.match(/^model:\s*(.+)$/m);
			const currentModel = currentModelMatch ? currentModelMatch[1].trim() : "inherits parent";
			const currentThinkingMatch = currentContent.match(/^thinking:\s*(.+)$/m);
			const currentThinking = currentThinkingMatch ? currentThinkingMatch[1].trim() : "off";
			const configured_model = parse_configured_model_ref(currentModel);
			const parent_model = ctx.model as { provider?: string; id?: string } | undefined;
			const picked = await pickModelInEditor(ctx, pi, {
				currentModel: {
					...(configured_model ?? {
						provider: parent_model?.provider ?? "",
						id: parent_model?.id ?? "",
					}),
					thinkingLevel: currentThinking,
				},
			});
			if (!picked) return;
			const modelValue = `${picked.provider}/${picked.id}`;
			if (currentModelMatch) {
				currentContent = currentContent.replace(/^model:\s*.+$/m, `model: ${modelValue}`);
			} else {
				currentContent = currentContent.replace(/^(---\n)/, `$1model: ${modelValue}\n`);
			}
			// Effort slider in the model picker is SSOT — never fall back to ctx.ui.select.
			const thinkingChoice = picked.thinkingLevel ?? currentThinking;
			if (currentThinkingMatch) {
				currentContent = currentContent.replace(/^thinking:\s*.+$/m, `thinking: ${thinkingChoice}`);
			} else if (thinkingChoice !== "off") {
				currentContent = currentContent.replace(/^(---\n)/, `$1thinking: ${thinkingChoice}\n`);
			}
			fs.writeFileSync(filePath, currentContent, "utf-8");
			const effortHint = format_model_effort_suffix({ id: picked.id }, picked.thinkingLevel);
			ctx.ui.notify(
				`${agentChoice} subagent: ${modelValue}${effortHint}. Will use on next spawn.`,
			);
		},
	});

	async function copy_plan_to_clipboard(ctx: any): Promise<void> {
		const plan = latest_plan_text.trim();
		if (!plan) {
			ctx.ui.notify("No plan text is available to copy.", "error");
			return;
		}
		try {
			await copyToClipboard(plan);
			ctx.ui.notify("Plan copied to clipboard.", "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to copy plan: ${message}`, "error");
		}
	}

	async function showPlanReview(ctx: any) {
		const answers = await askQuiz(ctx, "Plan Review", build_plan_review_questions());
		return resolve_plan_review_answer(answers?.[0]);
	}

	async function showLoopRecovery(
		ctx: any,
	): Promise<{ action: "end" | "retry" | "custom"; instruction?: string } | undefined> {
		const questions: QuizQuestion[] = [
			{
				id: "loop-recovery",
				label: "Tool Loop Detected",
				prompt: "Choose how to handle the repeated tool call.",
				options: [
					{ value: "end", label: "End stream" },
					{ value: "retry", label: "Retry" },
				],
			},
		];
		const answers = await askQuiz(ctx, "Tool Loop Detected", questions);
		const choice = answers?.[0]?.value;
		if (choice === "end") return { action: "end" };
		if (choice === "retry") return { action: "retry" };
		if (choice) return { action: "custom", instruction: choice };
		return undefined;
	}

	async function handlePlanImplementFreshContext(ctx: any) {
		const plan = latest_plan_text.trim();
		if (!plan) {
			ctx.ui.notify("No plan text is available.", "error");
			return;
		}
		const newSession = get_new_session_fn();
		if (!ctx.hasUI || !newSession) {
			ctx.ui.notify("Fresh-context implement is unavailable in this mode.", "error");
			return;
		}

		waitingForPlan = false;
		latest_plan_text = "";
		const parentSession = ctx.sessionManager?.getSessionFile?.();
		const result = await newSession({
			parentSession,
			setup: async (sm: SessionManager) => {
				sm.appendMessage({
					role: "user",
					content: [{ type: "text", text: plan }],
					timestamp: Date.now(),
				});
			},
			withSession: async (newCtx) => {
				await apply_mode(DEFAULT_MODE, newCtx);
				await newCtx.sendMessage({
					customType: "pi-agents-plan-implement",
					content: plan_implement_prompt(model_provider_of(newCtx.model)),
					display: false,
				});
				await newCtx.sendUserMessage("Execute the plan following the modules.", {
					deliverAs: "followUp",
				});
			},
		});
		if (result?.cancelled) {
			ctx.ui.notify("New session cancelled.", "warning");
		}
	}

	async function handlePlanImplement(ctx: any) {
		const plan = latest_plan_text.trim();
		if (!plan) {
			ctx.ui.notify("No plan text is available.", "error");
			return;
		}
		if (!ctx.hasUI) {
			switchMode(DEFAULT_MODE, ctx);
			pi.sendMessage({
				customType: "pi-agents-plan-implement",
				content: build_plan_implement_message_content(
					plan,
					plan_implement_prompt(model_provider_of(ctx.model), "below"),
				),
				display: false,
			});
			waitingForPlan = false;
			latest_plan_text = "";
			pi.sendUserMessage("Execute the plan following the modules.");
			return;
		}
		const implementQuestions: QuizQuestion[] = [
			{
				id: "implement-via",
				label: "Implement",
				prompt: "Implement the plan via which mode?",
				options: [
					{
						value: "code",
						label: "Code",
						description: "Execute the plan with full tool access.",
					},
					{
						value: "orchestrate",
						label: "Orchestrate",
						description: "Delegate the plan to subagents.",
					},
				],
			},
		];
		const answers = await askQuiz(ctx, "Implement via", implementQuestions, {
			includeNone: false,
		});
		const answer = answers?.[0];
		if (!answer) {
			ctx.ui.notify("Plan implementation cancelled.");
			return;
		}
		const target = answer.value === "orchestrate" ? "Orchestrate" : "Code";
		const targetMode = answer.value === "orchestrate" ? "orchestrate" : DEFAULT_MODE;
		await switchMode(targetMode, ctx);
		const msg =
			target === "Orchestrate"
				? "Delegate the plan to subagents."
				: "Execute the plan following the modules.";
		const provider = model_provider_of(ctx.model);
		pi.sendMessage({
			customType: "pi-agents-plan-implement",
			content: build_plan_implement_message_content(
				plan,
				plan_implement_prompt(provider, "below"),
			),
			display: false,
		});
		waitingForPlan = false;
		latest_plan_text = "";
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	}

	function build_system_prompt(event: any, modeReminder: string): string {
		return `${event.systemPrompt}${PARALLEL_TOOL_CALL_GUIDANCE}\n\n${modeReminder}`;
	}

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const provider = model_provider_of(ctx.model);
		const plan_arm = arm_plan_turn(currentMode, event.prompt);
		if (plan_arm.armed) {
			waitingForPlan = true;
			if (plan_arm.clear_plan_text) latest_plan_text = "";
		}
		if (currentMode !== DEFAULT_MODE && lastMessagedMode !== currentMode) {
			const mode = MODES[currentMode];
			lastMessagedMode = currentMode;
			return {
				systemPrompt: build_system_prompt(event, mode_reminder(currentMode, provider)),
				message: {
					customType: `pi-agents-enter-${currentMode}`,
					content: `Entered ${mode.label} mode.`,
					display: false,
				},
			};
		}
		if (currentMode === DEFAULT_MODE && lastMessagedMode && lastMessagedMode !== DEFAULT_MODE) {
			const prevModeId = lastMessagedMode;
			const prevMode = MODES[prevModeId];
			lastMessagedMode = DEFAULT_MODE;
			return {
				systemPrompt: build_system_prompt(
					event,
					exit_mode_reminder(prevModeId, provider).replace("{mode}", prevMode.label),
				),
				message: {
					customType: "pi-agents-exit",
					content: `Exited ${prevMode.label} mode.`,
					display: false,
				},
			};
		}
		return {
			systemPrompt: build_system_prompt(event, mode_reminder(currentMode, provider)),
		};
	});

	let lastTurnAborted = false;
	let lastTurnLengthStopped = false;
	let lastTurnError = false;
	/** Max consecutive auto-continues before giving up and surfacing the error. */
	const PLAN_AUTO_CONTINUE_MAX = 5;
	let planAutoContinueCount = 0;
	const LOOP_TOOL_CALL_LIMIT = 3;
	let loop_tool_call_signature: string | undefined;
	let loop_tool_call_count = 0;
	let loop_detected = false;
	let loop_prompt_active = false;

	/**
	 * Single-path output-limit recovery. Compact is best-effort: if the
	 * branch tip is already a compaction entry ("Already compacted") the
	 * compact call is skipped; if compact fails with a non-benign error we
	 * still resume — the user asked for unconditional continue within budget.
	 *
	 * session_before_compact runs Ember-owned summarization (compaction-prompts.ts).
	 * Pi injects that checkpoint into LLM context after compact().
	 * The hidden pi-agents-auto-continue message is a short non-duplicating
	 * resume directive built by build_auto_continue_content — it does NOT
	 * re-paste the compaction summary.
	 */
	async function resume_after_output_limit(ctx: any): Promise<void> {
		setPlanAutoContinuing(true);
		const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as
			| Array<{ type?: string } | null | undefined>
			| undefined;
		const skip = should_skip_compact(branch ?? []);
		if (!skip) {
			const compact_result = await compact_async(ctx);
			if (!compact_result.ok && !is_benign_compact_error(compact_result.error)) {
				// Non-benign compact error: still resume. Pi may already show
				// compaction_end error. Do not throw; do not abort resume.
			}
		}

		const content = build_auto_continue_content({
			latest_plan_text: currentMode === "plan" ? latest_plan_text : undefined,
		});

		// Keep suppression true until the message is dispatched so the
		// length-error row stays hidden in the TUI.
		pi.sendMessage(
			{ customType: "pi-agents-auto-continue", content, display: false },
			{ triggerTurn: true },
		);
		// Clear after dispatch; the next length stop can re-arm via message_end.
		setPlanAutoContinuing(false);
	}

	function reset_tool_loop_tracking(): void {
		loop_tool_call_signature = undefined;
		loop_tool_call_count = 0;
		loop_detected = false;
	}

	pi.on("agent_start", () => {
		reset_tool_loop_tracking();
		loop_prompt_active = false;
	});

	pi.on("tool_call", (event: any, ctx: any) => {
		const provider = model_provider_of(ctx.model);
		const activeTools = mode_tools_for_provider(currentMode, provider);
		if (!activeTools.includes(event.toolName)) {
			return {
				block: true,
				reason: `Tool '${event.toolName}' is not available in ${MODES[currentMode]?.label ?? currentMode} mode. Available tools: ${activeTools.join(", ")}.`,
			};
		}
		if (currentMode === "plan") {
			const planSubagentBlock = validate_plan_mode_subagent(event.toolName, event.input);
			if (planSubagentBlock) return planSubagentBlock;
		}
		const patch_tool = resolve_patch_tool_name(provider);
		if (event.toolName === "apply_patch" && patch_tool !== "apply_patch") {
			return {
				block: true,
				reason: "apply_patch is only available with openai-codex models. Use edit instead.",
			};
		}
		if (event.toolName === "edit" && patch_tool !== "edit") {
			return {
				block: true,
				reason: "edit is not available with openai-codex models. Use apply_patch instead.",
			};
		}
		if (loop_detected || loop_prompt_active) {
			return {
				block: true,
				reason: "Tool loop detected; blocking further tool calls.",
			};
		}
		const signature = tool_call_signature(event.toolName, event.input);
		if (signature === loop_tool_call_signature) {
			loop_tool_call_count++;
		} else {
			loop_tool_call_signature = signature;
			loop_tool_call_count = 1;
		}
		if (loop_tool_call_count >= LOOP_TOOL_CALL_LIMIT) {
			loop_detected = true;
			ctx.abort();
			return {
				block: true,
				reason: `Tool '${event.toolName}' has been called ${LOOP_TOOL_CALL_LIMIT} times with identical arguments.`,
			};
		}
	});

	pi.on("turn_end", (event: any) => {
		const msg = event?.message;
		const plan_text = waitingForPlan && currentMode === "plan" ? assistant_text(msg) : "";
		if (plan_text) {
			latest_plan_text = latest_plan_text ? `${latest_plan_text}\n\n${plan_text}` : plan_text;
		}
		const assistantStopReason =
			msg?.role === "assistant" && typeof msg?.content === "object"
				? (msg.content as { stopReason?: string }).stopReason
				: undefined;
		lastTurnAborted = msg?.stopReason === "aborted" || assistantStopReason === "aborted";
		lastTurnLengthStopped = msg?.stopReason === "length";
		lastTurnError =
			msg?.stopReason === "error" ||
			assistantStopReason === "error" ||
			is_non_generic_error((msg as { errorMessage?: string }).errorMessage) ||
			is_non_generic_error((msg?.content as { errorMessage?: string })?.errorMessage);
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		if (loop_detected && !loop_prompt_active) {
			loop_prompt_active = true;
			const model = ctx.model as Model<any> | undefined;
			const model_name = model?.name ?? model?.id ?? "The model";
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${model_name} has been looping for ${LOOP_TOOL_CALL_LIMIT} toolcalls`,
					"warning",
				);
			}
			const choice = ctx.hasUI ? await showLoopRecovery(ctx) : undefined;
			loop_prompt_active = false;
			reset_tool_loop_tracking();
			lastTurnAborted = false;
			lastTurnLengthStopped = false;
			lastTurnError = false;
			setPlanAutoContinuing(false);
			if (choice?.action === "retry") {
				pi.sendMessage(
					{
						customType: "pi-agents-loop-retry",
						content: "You have been looping, back off and continue with a different tool.",
						display: false,
					},
					{ triggerTurn: true },
				);
			} else if (choice?.action === "custom" && choice.instruction) {
				pi.sendMessage(
					{
						customType: "pi-agents-loop-guidance",
						content: choice.instruction,
						display: false,
					},
					{ triggerTurn: true },
				);
			}
			return;
		}

		// Output-limit recovery: when the model hits the max output token limit,
		// compact is best-effort and resume is unconditional within budget.
		// If the branch tip is already a compaction entry ("Already compacted"),
		// compact is skipped. If compact fails with a non-benign error we still
		// resume — the user never sees the error row or a recovery prompt.
		// The suppression flag in mode-colors.ts is set in the message_end
		// handler (before the TUI renders the error row) and cleared after the
		// hidden pi-agents-auto-continue message is dispatched.
		if (
			lastTurnLengthStopped &&
			!lastTurnAborted &&
			planAutoContinueCount < PLAN_AUTO_CONTINUE_MAX
		) {
			planAutoContinueCount++;
			lastTurnLengthStopped = false;
			await resume_after_output_limit(ctx);
			return;
		}
		// Reset auto-continue state once the turn completes normally.
		setPlanAutoContinuing(false);
		planAutoContinueCount = 0;
		lastTurnLengthStopped = false;

		if (waitingForPlan && currentMode === "plan") {
			const turn_aborted = lastTurnAborted;
			const turn_errored = lastTurnError;
			lastTurnAborted = false;
			lastTurnError = false;
			if (turn_aborted || turn_errored) return;
			if (!should_show_plan_review(latest_plan_text)) {
				waitingForPlan = false;
				return;
			}

			const action = await showPlanReview(ctx);
			if (action === "implement") {
				waitingForPlan = false;
				await handlePlanImplement(ctx);
			} else if (action === "implement-fresh") {
				await handlePlanImplementFreshContext(ctx);
			} else if (action === "copy") {
				await copy_plan_to_clipboard(ctx);
			} else if (action?.action === "refine") {
				latest_plan_text = "";
				pi.sendUserMessage(action.instruction);
			}
			return;
		}

		lastTurnAborted = false;
		lastTurnError = false;
	});

	async function restore_mode_model(ctx: any, modeId: string): Promise<void> {
		const bound = get_mode_model(mode_models, modeId);
		if (!bound) return;
		await apply_bound_model(ctx, bound);
	}

	async function restoreMode(ctx: any): Promise<void> {
		const persisted = readPersistedState();
		const provider = model_provider_of(ctx.model);
		const savedMode =
			persisted.mode && persisted.mode in MODES ? persisted.mode : getLastModeFromSession(ctx);
		if (savedMode && savedMode !== DEFAULT_MODE) {
			currentMode = savedMode;
			lastMessagedMode = savedMode;
			pi.setActiveTools(mode_tools_for_provider(savedMode, provider));
		} else {
			currentMode = DEFAULT_MODE;
			lastMessagedMode = null;
			pi.setActiveTools(build_full_tools(provider));
		}
		setActiveMode(currentMode);
		pi.events.emit("pi-ember-ui:mode-change", { mode: currentMode, liveOnly: true });
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		// The TUI can accept input while /resume is still rebinding extensions.
		// Keep mode switching lazy until all session-bound setup has finished.
		active_session_manager = ctx.sessionManager;
		session_ready = false;
		resetSlashCommandTracking();
		install_thinking_editor(ctx);
		// Re-read persisted state to pick up any mode-model bindings written by
		// another session or by the migration on first read.
		const persisted = readPersistedState();
		mode_models = { ...(persisted.modeModels ?? {}) };
		await restoreMode(ctx);
		await restore_mode_model(ctx, currentMode);
		sync_active_tools(ctx);
		last_patch_tool_provider = model_provider_of(ctx.model);
		session_ready = true;
		const pending_mode = pending_mode_id;
		pending_mode_id = undefined;
		if (pending_mode) await apply_mode(pending_mode, ctx);
		else updateStatus(ctx);
	});

	let last_patch_tool_provider: string | undefined;

	pi.on("model_select", async (event: any, ctx: any) => {
		const model = event.model as Model<any> | undefined;
		if (!model) return;
		const provider = model_provider_of(model);
		const prev_provider = last_patch_tool_provider;
		// Suppress bind during our own programmatic setModel (mode restore).
		if (applying_mode_model) {
			last_patch_tool_provider = provider;
			sync_active_tools(ctx);
			return;
		}
		// Only bind on Ctrl+P cycle. `/model` and the Switch Model overlay emit
		// pi-agents:bind-mode-model after model + effort are fully applied.
		const source = event.source as string | undefined;
		if (source === "cycle") {
			const identity = model_identity_of(model, get_pi_thinking_level(pi));
			if (identity) bind_current_mode_model(identity);
		}
		if (
			currentMode === "code" &&
			resolve_patch_tool_name(prev_provider) !== resolve_patch_tool_name(provider)
		) {
			sync_active_tools(ctx);
			const patch_tool = resolve_patch_tool_name(provider);
			const other = patch_tool === "apply_patch" ? "edit" : "apply_patch";
			pi.sendMessage({
				customType: "pi-agents-tool-access",
				content: [
					`The active model provider is now ${provider ?? "unknown"}.`,
					`Use ${patch_tool} for file edits instead of ${other}.`,
					`Your current tool set is: ${build_full_tools(provider).join(", ")}.`,
				].join("\n"),
				display: false,
			});
		} else {
			sync_active_tools(ctx);
		}
		last_patch_tool_provider = provider;
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		if (!is_live_session(ctx)) return;
		if (applying_mode_model || applying_mode_thinking_level) return;
		const level = normalize_thinking_level(event?.level);
		if (!level) return;
		const identity = model_identity_of(ctx.model as Model<any> | undefined, level);
		if (identity) bind_current_mode_model(identity);
		request_live_mode_render(ctx);
	});

	// Mark footer stats dirty when usage/context changes. A zero-delay timer
	// coalesces parallel tool completions into one O(n) recomputation per
	// event-loop burst, away from the footer render closure.
	pi.on("message_end", (event: any, ctx: any) => {
		scheduleFooterStats(ctx);
		// Set the auto-continue suppression flag BEFORE the TUI renders the
		// assistant message (extension message_end fires before the interactive-mode
		// handler that calls updateContent). When the model hits the output token
		// limit and we haven't exhausted the retry budget, suppress the error row —
		// agent_settled will best-effort compact and send a hidden
		// pi-agents-auto-continue message with a checkpoint digest to resume.
		const msg = event?.message;
		if (
			msg?.role === "assistant" &&
			msg?.stopReason === "length" &&
			!lastTurnAborted &&
			planAutoContinueCount < PLAN_AUTO_CONTINUE_MAX
		) {
			setPlanAutoContinuing(true);
		}
	});
	pi.on("tool_execution_end", (_event: any, ctx: any) => {
		scheduleFooterStats(ctx);
	});

	pi.on("session_shutdown", (_event: any, _ctx: any) => {
		// Invalidate shortcut contexts before the old runtime is disposed. A Tab
		// press during /resume is ignored instead of calling setActiveTools or
		// mutating UI state through a stale session.
		session_ready = false;
		active_session_manager = undefined;
		pending_mode_id = undefined;
		setShellMode(false);
		setPlanAutoContinuing(false);
		planAutoContinueCount = 0;
		lastTurnLengthStopped = false;
		lastTurnError = false;
		reset_tool_loop_tracking();
		loop_prompt_active = false;
		latest_plan_text = "";
		resetSlashCommandTracking();
		thinking_editor_installed = false;
		// Write per-mode model bindings only. Do NOT bind the current live model
		// onto the current mode — only explicit user picks bind (model_select
		// handler). Do NOT write top-level legacy `model` key.
		writePersistedState({ mode: currentMode, modeModels: mode_models });
	});

	await subagentPlugin(pi);
}
