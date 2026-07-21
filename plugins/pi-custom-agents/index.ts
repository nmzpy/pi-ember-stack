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
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import {
	MODE_COLORS,
	mutedBullet,
	setActiveMode,
	setPlanAutoContinuing,
	setShellMode,
} from "../pi-ember-ui/mode-colors.ts";
import {
	cancelPendingModelPick,
	finalizeEditorInputAfter,
	interceptShellInput,
	modelNameHasThinkingVariant,
	pickModelInEditor,
	processShellInput,
	requestShellModeVisualRefresh,
	syncShellModeFromEditorText,
	requestTuiRenderFromEditor,
	requestTuiRenderSnapToBottom,
	resetSlashCommandTracking,
	scheduleFooterStats,
	setModeLabelResolver,
	wrapEditorRenderForShell,
	wrapModelPickerEditor,
} from "../pi-ember-ui/index.ts";
import { askQuiz, type QuizQuestion, registerQuizTool } from "./quiz-tool.ts";
import {
	build_auto_continue_content,
	COMPACT_FOCUS_INSTRUCTIONS,
	is_benign_compact_error,
	should_skip_compact,
} from "./auto-continue.ts";
import subagentPlugin from "./subagent/extensions/index.ts";
import { isGenericAbortMessage } from "./subagent/extensions/runner.ts";

/**
 * Promisify ctx.compact() into a result discriminated union.
 * Never throws — both callback errors and synchronous throws are caught.
 */
function compact_async(
	ctx: any,
	customInstructions: string,
): Promise<{ ok: true } | { ok: false; error: Error }> {
	return new Promise((resolve) => {
		try {
			ctx.compact({
				customInstructions,
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

type ModelIdentity = { readonly provider: string; readonly modelId: string };

function model_identity_of(model: Model<any> | undefined): ModelIdentity | undefined {
	return model ? { provider: model.provider, modelId: model.id } : undefined;
}

function identities_equal(a?: ModelIdentity, b?: ModelIdentity): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.provider === b.provider && a.modelId === b.modelId;
}

function normalize_mode_models(raw: unknown): Partial<Record<string, ModelIdentity>> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	const result: Partial<Record<string, ModelIdentity>> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof (value as Record<string, unknown>).provider === "string" &&
			typeof (value as Record<string, unknown>).modelId === "string"
		) {
			result[key] = {
				provider: (value as Record<string, unknown>).provider as string,
				modelId: (value as Record<string, unknown>).modelId as string,
			};
		}
	}
	return result;
}

function get_mode_model(
	modeModels: Partial<Record<string, ModelIdentity>>,
	modeId: string,
): ModelIdentity | undefined {
	return modeModels[modeId];
}

function bind_mode_model(
	modeModels: Partial<Record<string, ModelIdentity>>,
	modeId: string,
	identity: ModelIdentity,
): Partial<Record<string, ModelIdentity>> {
	return { ...modeModels, [modeId]: identity };
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
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "quiz", ...WEB_ACCESS_TOOLS];
const READONLY_DELEGATING_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"quiz",
	"subagent",
	...WEB_ACCESS_TOOLS,
];
const FULL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"quiz",
	...WEB_ACCESS_TOOLS,
];

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUBAGENT_FILES: Record<string, string> = {
	coder: path.join(SOURCE_ROOT, "subagent", "agents", "coder.md"),
	scout: path.join(SOURCE_ROOT, "subagent", "agents", "scout.md"),
};

const PARALLEL_TOOL_CALL_GUIDANCE = `

Tool Call Efficiency:

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching them saves round-trips and reduces latency.
`;

const OUTPUT_STYLE_DIRECTIVE = `

Output style: Reply in plain dense text. No markdown headers (#, ##, ###), no
bold or italics (**, *), no decorative bulleted lists (-, *). Use short labeled
lines (Label: value) or compact key: value pairs. Keep code fences only for
multi-line code blocks. Do not narrate your process ("I'll keep tracing...",
"Next I'll...", "Now I...") and do not state what you are about to do. Just
do the work and return the result. Be concise.
`;

const SUBAGENT_AWARENESS_PROMPT = `

Available Subagents:

You have the subagent tool available for delegating tasks to specialized agents
with isolated context. Use it to keep your own context lean.

Scout: Fast agent specialized for exploring codebases. Use when you need to
quickly find files by patterns (e.g. "src/components/**/*.tsx"), search code for
keywords (e.g. "API endpoints"), or answer questions about the codebase (e.g.
"how do API endpoints work?").
Coder: Implementation agent for writing, editing, testing, and verifying code.
Full tool access. Use for focused implementation tasks — bug fixes, feature
additions, refactors, file edits.

Modes: single (agent + task), parallel (tasks array, max 8), chain (sequential
with {previous}).

Agent names are case-insensitive and surrounding whitespace is ignored; the
runtime resolves requests to the canonical frontmatter name.
`;

interface ModeConfig {
	id: string;
	label: string;
	icon: string;
	color: string;
	tools: string[];
	enterMessage: string;
	exitMessage: string;
}

const ARCHITECT_PROMPT = `<system-reminder>
Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE — you are in READ-ONLY planning phase. You do NOT
have the edit or write tools, and no other file-modifying tools are available.
Your allowed tools are: read, bash (read/inspect only), grep, find, ls, quiz,
web_search, fetch_content, and get_search_content.

STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes. Do NOT use
sed, tee, echo, cat, or ANY other bash command to manipulate files — commands may
ONLY read/inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions,
including direct user edit requests. You may ONLY observe, analyze, and plan. Any
modification attempt is a critical violation. ZERO exceptions.

---

Responsibility:

Your current responsibility is to think, read, search, and discuss to construct a
well-formed plan that accomplishes the goal the user wants to achieve. Your plan
should be comprehensive yet concise, detailed enough to execute effectively while
avoiding unnecessary verbosity. Include the goal as first part of the plan.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.
Use the quiz tool for decision-oriented questions so the user can answer inline.

NOTE: At any point in time through this workflow you should feel free to ask the
user questions or clarifications. Don't make large assumptions about user intent.
The goal is to present a well researched plan to the user, and tie any loose ends
before implementation begins.

---

Planning Requirements:

The plan must be explicit — concrete, sequential modules that map directly to single
logical changes.

For each module, provide: action, Files (full paths to read or modify), What
(precise change), Why (user-facing or architectural rationale), Risks (regression
surfaces), and Validation (how to verify, e.g. bash t.gate.sh <files>).

---

Output Format — use plain labeled lines, NO markdown headers or bullets:

Task: <one-sentence goal>

Investigation: <files read, patterns found, relevant file:line references>

Plan:

Module 1: <action>
  Files: <paths>
  What: <change>
  Why: <rationale>
  Risks: <regression surfaces>
  Validation: bash t.gate.sh <files>

Module 2: <action>
  Files: <paths>
  What: <change>
  Why: <rationale>
  Risks: <regression surfaces>
  Validation: bash t.gate.sh <files>

Acceptance Criteria: <what done looks like>

If you need clarifications before or during the plan, ask the user using the quiz tool; do not emit an Open Questions section.
${OUTPUT_STYLE_DIRECTIVE}${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const DOCTOR_PROMPT = `<system-reminder>
Debug Mode - System Reminder

CRITICAL: Debug mode ACTIVE — you are the Debugger, a health-check auditor and
diagnostician for the Ember project (PySide6 subtitle + DaVinci Resolve integration
app).

You do NOT have the edit or write tools, and no other file-modifying tools are
available to you. Your allowed tools are: read, grep, find, ls, quiz, subagent,
web_search, fetch_content, and get_search_content. Bash may be used only for
non-mutating inspection/validation commands. You investigate, diagnose, and report
findings. If a fix is straightforward, you may DELEGATE the implementation to the
Coder subagent (full tool access) — the read-only constraint applies to your direct
tool usage only, not to delegated subagent work. Otherwise, report the correction
and let the user or Orchestrator handle it.

---

Health Check Focus Areas:

Structural architecture risk: prioritize ownership conflicts, hidden coupling,
duplicated state, complex control flow, unsafe cross-layer dependencies, changes
that violate documented golden paths, and high-change-entropy files.

Verified dead code: flag unused imports, unreachable functions, never-called
methods, orphaned variables, and stale tests only after tool output and call-site
verification. Avoid flagging public APIs, plugin hooks, signal/slot targets,
reflection/dynamic dispatch, localized catalog entries, or config/schema fields
without proof they are unreachable.

Single source of truth (SSOT): every piece of data, config, constant, or
business logic must have exactly one authoritative source. Flag duplicated
constants, parallel config files, mirrored state, overlapping services,
copy-pasted logic, and derived data that should reference a canonical source.

Production readiness: check fail-fast behavior, actionable error surfacing,
EmberLogger use instead of print(), no bare except:, and no silent degradation
of offline/core runtime behavior.

Threading/UI safety: flag worker-thread UI/state mutation, missing signal/slot
boundaries, hot-loop sleeps, unsafe Resolve API changes, and animations that
ignore animation-disabled settings.

GUI localization/styling: new user-facing UI text must be localized for all
supported languages; UI colors must use Colors tokens. Do not flag intentional
tuned one-off layout values or proven timeline/playback golden paths without a
concrete regression.

Tests and validation: prefer meaningful tests or targeted validation over
brittle assertions that encode stale architecture. Python/app edits use
bash t.gate.sh <files>; site edits follow site/AGENTS.md.

Performance traps: flag large linear scans in hot paths, blocking UI work,
unnecessary repeated Resolve calls, and avoidable recomputation in
timeline/editor interactions.

Boundary checks: keep site/marketing concerns separate from Ember runtime
GUI concerns and do not apply GUI-only rules to site/ unless its own
instructions require them.

---

Classification:

Label each finding as:
  Confirmed issue — verified by tool output, ready for implementation
  Needs owner decision — requires user input, do not guess
  False positive — investigated and cleared

Only report Confirmed issues and Needs owner decision items. Drop false positives
from the final report.

---

Output Format:

For each finding, return:
  Classification: Confirmed issue / Needs owner decision
  Category: which health-check focus area
  File: file_path:line_number
  Evidence: tool output or call-site proof
  Impact: what breaks or degrades
  Correction: smallest architectural change that removes the cause
  Risks: regression surfaces

---

Constraints:

You do not edit or write files directly. You may delegate fixes to the Coder
subagent when a correction is straightforward and well-scoped.
Use bash t.gate.sh <files> only for targeted validation of files you are checking.
Do not run bash gate.sh (full gate) — that is the user's responsibility.
Ignore git status / git diff changes unrelated to the files you were asked to check.

---

UI/Qt Pipeline Diagnostics:

In addition to structural health checks, diagnose PySide6/Qt UI pipeline issues.

Failure Modes To Investigate:
1. Event-loop blockage: Does any GUI-thread callback perform blocking I/O or
   unbounded CPU work?
2. Excessive synchronous UI mutation: Does one state transition perform many
   independent widget/layout/geometry operations?
3. Recursive signal/callback propagation: Can a signal or layout refresh
   indirectly re-enter the same pipeline?
4. Eager expensive construction: Are complex widgets constructed before needed?
5. Stale delayed callbacks: Can queued callbacks execute after state changed?
6. Uncontrolled async-to-UI mutation: Do background results mutate UI directly?
7. Competing layout authorities: Do multiple functions independently control the
   same widget geometry?

Commit Architecture (Healthy Reference):

event/signal/async completion -> validate generation -> mutate semantic state ->
mark dirty -> request one coalesced commit -> measure once -> apply geometry once ->
repaint

UI Report Format:

For every UI failure mode, report: Verdict, Evidence, Trigger, Duplicated work,
Re-entry path, Stale-state risk, Authority conflict, Impact, Correction,
Invariant, Verification.

Invalid UI Fix Patterns:

Reject fixes that: add more invalidate()/activate() calls, use
QApplication.processEvents(), replace deferred passes with blocking callbacks,
add arbitrary QTimer.singleShot() delays, perform geometry repair both
immediately and later, introduce parallel build paths duplicating normal layout.
${OUTPUT_STYLE_DIRECTIVE}${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const ORCHESTRATOR_PROMPT = `<system-reminder>
Orchestrate Mode - System Reminder

CRITICAL: Orchestrate mode ACTIVE — you are the Orchestrator, an implementation
coordinator for the Ember project (PySide6 subtitle + DaVinci Resolve integration
app).

You do NOT have the edit or write tools, and no other file-modifying tools are
available to you. Your allowed tools are: read, grep, find, ls, quiz, subagent,
web_search, fetch_content, and get_search_content. Bash may be used only for
non-mutating inspection/validation commands. Your job is to decompose work into
modules and DELEGATE implementation to the Coder subagent (full tool access). The
read-only constraint applies to YOUR direct tool usage only — you may read,
search, and inspect to build accurate delegation prompts, but you must not edit,
write, or run mutating bash commands yourself. Delegating implementation work to
the Coder subagent is the ENTIRE POINT of this mode. Do it eagerly.

---

Task Decomposition Into Digestible Modules:

Break the work into the smallest self-contained modules an agent can implement
without cross-talk. A good module is one clear responsibility, a bounded file set,
and an independently verifiable outcome.

Slice by cohesion, not by line count: Each module owns one logical change
(one feature seam, one bug, one refactor boundary). If a module touches two
unrelated concerns, split it.

One owner per file: A file belongs to exactly one module. If two modules both
need the same file, either merge them or extract the shared change into a
prerequisite module that runs first.

Right-size the unit: Aim for a module an agent can finish and self-validate with
bash t.gate.sh <files> in a single pass. If the prompt needs more than 6 owned
files or a long list of unrelated steps, split it further.

Order by dependency: Group independent modules into parallel clusters; chain
modules that depend on another module's output so the producer completes before
the consumer starts.

Define the seam explicitly: When modules share an interface (function
signature, data model, signal), pin that contract in every dependent prompt so
parallel agents integrate cleanly without seeing each other's work.

---

Delegation Prompt Quality:

Each subagent starts with zero shared context. Treat every prompt as a complete
brief that a competent engineer could execute cold. A thorough prompt includes:

Goal and rationale: What outcome the module must achieve and why.
Exact owned files: Full paths, plus explicit "do not touch anything else."
Anchored context: Relevant existing functions, classes, patterns, and
file_path:line_number references the agent should read first and mirror.
Interface contract: The precise signatures, data shapes, tokens, or catalog
keys the module must produce or consume.
Step sequence: Concrete, ordered steps mapping to single logical changes.
Constraints: Applicable AGENTS.md rules (typing, logging, localization,
Colors tokens, error handling, DRY/SSOT), and any golden paths to preserve.
Acceptance criteria and validation: What "done" looks like and the exact
bash t.gate.sh <files> command to run.
Risks and edge cases: Known pitfalls, regression surfaces, and behavior that
must be preserved.
No redundancy, dead code cleanup after implementations of the given files.
No DRY violations.
Ignore git status / git diff changes unrelated to owned files.

---

Output Format:

Return a structured plan using plain labeled lines, NO markdown headers or bullets.

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
  3. Sequential: Module 5 (depends on Module 3)

Delegation Prompts: <full self-contained prompt for each module, ready to paste into a subagent>

Constraints:
  You do not edit or write files directly — delegate implementation to the Coder subagent. That is your primary mechanism for getting work done.
  Do not run bash gate.sh (full gate) — that is the user's responsibility.
  If task scope is unclear, say so and request clarification rather than guessing.
${OUTPUT_STYLE_DIRECTIVE}${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const CODER_PROMPT = `<system-reminder>
Your operational mode has changed to code.
You are in full-access mode. You are permitted to make file changes, run shell
commands, and utilize your arsenal of tools as needed. You are the default
implementation agent — write, test, and verify code with full autonomy.
${OUTPUT_STYLE_DIRECTIVE}</system-reminder>`;

const EXIT_TO_CODER = `<system-reminder>
Your operational mode has changed from {mode} to code.
You are permitted to make file changes, run shell commands, and utilize your
arsenal of tools as needed.
${OUTPUT_STYLE_DIRECTIVE}</system-reminder>`;

const PLAN_IMPLEMENT_PROMPT = `<system-reminder>
The user has approved the plan above. Execute it now in full.
Follow the plan modules in order. Implement, test, and verify each module before
moving to the next. Run bash t.gate.sh <files> after each logical change.
Report what you did and any deviations from the plan.
${OUTPUT_STYLE_DIRECTIVE}</system-reminder>`;

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
		tools: READONLY_TOOLS,
		enterMessage: ARCHITECT_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
	code: {
		id: "code",
		label: "code",
		icon: "C",
		color: "success",
		tools: FULL_TOOLS,
		enterMessage: CODER_PROMPT,
		exitMessage: CODER_PROMPT,
	},
	debug: {
		id: "debug",
		label: "debug",
		icon: "D",
		color: "warning",
		tools: READONLY_DELEGATING_TOOLS,
		enterMessage: DOCTOR_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
	orchestrate: {
		id: "orchestrate",
		label: "orchestrate",
		icon: "O",
		color: "warning",
		tools: READONLY_DELEGATING_TOOLS,
		enterMessage: ORCHESTRATOR_PROMPT,
		exitMessage: EXIT_TO_CODER,
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
	// Stale async apply guard — incremented at each apply_mode start.
	let mode_apply_generation = 0;

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

	async function apply_mode(modeId: string, ctx: any): Promise<void> {
		const mode = MODES[modeId];
		if (!mode) return;

		const prevModeId = currentMode;
		const prevMode = MODES[prevModeId];

		// Mode changes are deliberately live-only. The active tool set and the
		// next-turn prompt change immediately, while the transcript stays lazy
		// and cached.
		currentMode = modeId;
		setActiveMode(modeId);
		pi.setActiveTools(mode.tools);
		pi.events.emit("pi-ember-ui:mode-change", { mode: modeId, liveOnly: true });
		updateStatus(ctx);

		// Remind the model which tools it lost and which it now has whenever the
		// mode (and therefore the tool set) actually changes. Hidden so it steers
		// the next turn without cluttering the transcript — same channel as the
		// plan-auto-continue and loop-retry hidden messages.
		if (prevMode && prevModeId !== modeId) {
			const prevTools = prevMode.tools;
			const newTools = mode.tools;
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
		// from the live model, restore it. Fail soft on missing auth — leave the
		// live model, no throw.
		const my_generation = ++mode_apply_generation;
		const bound = get_mode_model(mode_models, modeId);
		if (!bound) return;
		const current = ctx.model as Model<any> | undefined;
		const current_identity = model_identity_of(current);
		if (identities_equal(bound, current_identity)) return;
		const target = ctx.modelRegistry.find(bound.provider, bound.modelId) as Model<any> | undefined;
		if (!target || !ctx.modelRegistry.hasConfiguredAuth(target)) return;
		// Stale guard: if a newer apply_mode was started, abort.
		if (my_generation !== mode_apply_generation) return;
		applying_mode_model = true;
		try {
			await pi.setModel(target);
		} finally {
			applying_mode_model = false;
		}
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

	const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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
				// before Pi's handler runs. toggleThinkingBlockVisibility() rebuilds
				// the chat synchronously inside original_handle_input; when groups
				// collapse/expand the line count shrinks/grows and Pi's differential
				// render path (clearOnShrink) can leave the viewport not pinned to
				// the bottom. Schedule a scrollback-preserving snap on the next
				// microtask so it fires after the rebuild but before Pi's next
				// (differential) render tick — requestTuiRenderSnapToBottom() clears
				// only the visible screen (`2J`, never `3J`), resets
				// previousViewportTop/maxLinesRendered, and requests a normal render
				// whose first-render path pins the chatbox to the bottom without
				// destroying terminal scrollback. Same lever the slash-command exit
				// snap uses. Never use requestTuiRender(true) here — it emits `3J`
				// and nukes scrollback.
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
				// body is just `git status`.
				if (syncShellModeFromEditorText(editor)) {
					requestShellModeVisualRefresh(editor, ctx);
				}

				finalizeEditorInputAfter(editor);
				if (is_thinking_toggle) {
					queueMicrotask(() => requestTuiRenderSnapToBottom());
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
			const agentChoice = await ctx.ui.select("Subagent to configure", ["Coder", "Scout"]);
			if (!agentChoice) return;
			const agentKey = agentChoice.toLowerCase();
			const filePath = SUBAGENT_FILES[agentKey];
			if (!filePath || !fs.existsSync(filePath)) {
				ctx.ui.notify(`Agent file not found: ${filePath ?? agentKey}`, "error");
				return;
			}
			let currentContent = fs.readFileSync(filePath, "utf-8");
			const currentModelMatch = currentContent.match(/^model:\s*(.+)$/m);
			const currentModel = currentModelMatch ? currentModelMatch[1].trim() : "inherits parent";
			ctx.ui.notify(`Pick a model for ${agentChoice} subagent (current: ${currentModel})`, "info");
			const picked = await pickModelInEditor(ctx, pi);
			if (!picked) return;
			const modelValue = `${picked.provider}/${picked.id}`;
			if (currentModelMatch) {
				currentContent = currentContent.replace(/^model:\s*.+$/m, `model: ${modelValue}`);
			} else {
				currentContent = currentContent.replace(/^(---\n)/, `$1model: ${modelValue}\n`);
			}
			const currentThinkingMatch = currentContent.match(/^thinking:\s*(.+)$/m);
			const currentThinking = currentThinkingMatch ? currentThinkingMatch[1].trim() : "off";
			const thinkingChoice = await ctx.ui.select(
				`Thinking level for ${agentChoice} (current: ${currentThinking})`,
				THINKING_LEVELS,
			);
			if (!thinkingChoice) {
				fs.writeFileSync(filePath, currentContent, "utf-8");
				ctx.ui.notify(
					`${agentChoice} subagent model set to ${modelValue}. Will use on next spawn.`,
				);
				return;
			}
			if (currentThinkingMatch) {
				currentContent = currentContent.replace(/^thinking:\s*.+$/m, `thinking: ${thinkingChoice}`);
			} else {
				currentContent = currentContent.replace(/^(---\n)/, `$1thinking: ${thinkingChoice}\n`);
			}
			fs.writeFileSync(filePath, currentContent, "utf-8");
			ctx.ui.notify(
				`${agentChoice} subagent: model=${modelValue}, thinking=${thinkingChoice}. Will use on next spawn.`,
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

	async function showPlanReview(
		ctx: any,
	): Promise<"implement" | "copy" | { action: "refine"; instruction: string } | undefined> {
		const questions: QuizQuestion[] = [
			{
				id: "plan-review",
				label: "Plan Review",
				prompt: "Choose what to do with the plan.",
				options: [
					{ value: "implement", label: "Implement Plan" },
					{ value: "copy", label: "Copy Plan" },
				],
			},
		];
		const answers = await askQuiz(ctx, "Plan Review", questions);
		const answer = answers?.[0];
		if (answer?.value === "implement") return "implement";
		if (answer?.value === "copy") return "copy";
		if (answer?.wasCustom && answer.value) {
			return { action: "refine", instruction: answer.value };
		}
		return undefined;
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

	async function handlePlanImplement(ctx: any) {
		if (!ctx.hasUI) {
			switchMode(DEFAULT_MODE, ctx);
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
						selectedColor: MODE_COLORS.code,
					},
					{
						value: "orchestrate",
						label: "Orchestrate",
						description: "Delegate the plan to subagents.",
						selectedColor: MODE_COLORS.orchestrate,
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
		pi.sendMessage({
			customType: "pi-agents-plan-implement",
			content: PLAN_IMPLEMENT_PROMPT,
			display: false,
		});
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	}

	pi.on("before_agent_start", async (event: any) => {
		const augmentedSystemPrompt = event.systemPrompt + PARALLEL_TOOL_CALL_GUIDANCE;
		if (currentMode === "plan" && waitingForPlan && event.prompt !== "continue") {
			latest_plan_text = "";
		}
		if (currentMode !== DEFAULT_MODE && lastMessagedMode !== currentMode) {
			const mode = MODES[currentMode];
			lastMessagedMode = currentMode;
			waitingForPlan = currentMode === "plan";
			if (waitingForPlan) latest_plan_text = "";
			return {
				systemPrompt: augmentedSystemPrompt,
				message: {
					customType: `pi-agents-enter-${currentMode}`,
					content: mode.enterMessage,
					display: false,
				},
			};
		}
		if (currentMode === DEFAULT_MODE && lastMessagedMode && lastMessagedMode !== DEFAULT_MODE) {
			const prevMode = MODES[lastMessagedMode];
			lastMessagedMode = DEFAULT_MODE;
			return {
				systemPrompt: augmentedSystemPrompt,
				message: {
					customType: "pi-agents-exit",
					content: prevMode.exitMessage.replace("{mode}", prevMode.label),
					display: false,
				},
			};
		}
		return { systemPrompt: augmentedSystemPrompt };
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
	 * The compact customInstructions (COMPACT_FOCUS_INSTRUCTIONS SSOT) steer
	 * the single session checkpoint to plain Goal/Done/Left/Files labeled
	 * lines. Pi injects that checkpoint into LLM context after compact().
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
			const compact_result = await compact_async(ctx, COMPACT_FOCUS_INSTRUCTIONS);
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
		const activeTools = MODES[currentMode]?.tools ?? FULL_TOOLS;
		if (!activeTools.includes(event.toolName)) {
			return {
				block: true,
				reason: `Tool '${event.toolName}' is not available in ${MODES[currentMode]?.label ?? currentMode} mode. Available tools: ${activeTools.join(", ")}.`,
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
		lastTurnError = false;

		if (waitingForPlan && currentMode === "plan") {
			waitingForPlan = false;
			if (lastTurnAborted || lastTurnError) {
				lastTurnAborted = false;
				lastTurnError = false;
				return;
			}
			const action = await showPlanReview(ctx);
			if (action === "implement") {
				await handlePlanImplement(ctx);
			} else if (action === "copy") {
				await copy_plan_to_clipboard(ctx);
				waitingForPlan = true;
			} else if (action?.action === "refine") {
				waitingForPlan = true;
				latest_plan_text = "";
				pi.sendUserMessage(action.instruction);
			}
		}
	});

	async function restore_mode_model(ctx: any, modeId: string): Promise<void> {
		const bound = get_mode_model(mode_models, modeId);
		if (!bound) return;
		const current = ctx.model as Model<any> | undefined;
		const current_identity = model_identity_of(current);
		if (identities_equal(bound, current_identity)) return;
		const target = ctx.modelRegistry.find(bound.provider, bound.modelId) as Model<any> | undefined;
		if (!target || !ctx.modelRegistry.hasConfiguredAuth(target)) return;
		applying_mode_model = true;
		try {
			await pi.setModel(target);
		} finally {
			applying_mode_model = false;
		}
	}

	async function restoreMode(ctx: any): Promise<void> {
		const persisted = readPersistedState();
		const savedMode =
			persisted.mode && persisted.mode in MODES ? persisted.mode : getLastModeFromSession(ctx);
		if (savedMode && savedMode !== DEFAULT_MODE) {
			currentMode = savedMode;
			lastMessagedMode = savedMode;
			pi.setActiveTools(MODES[savedMode].tools);
		} else {
			currentMode = DEFAULT_MODE;
			lastMessagedMode = null;
			pi.setActiveTools(FULL_TOOLS);
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
		session_ready = true;
		const pending_mode = pending_mode_id;
		pending_mode_id = undefined;
		if (pending_mode) await apply_mode(pending_mode, ctx);
		else updateStatus(ctx);
	});

	pi.on("model_select", async (event: any, _ctx: any) => {
		const model = event.model as Model<any> | undefined;
		if (!model) return;
		// Suppress bind during our own programmatic setModel (mode restore).
		if (applying_mode_model) return;
		// Only bind on explicit user picks: "set" (/model, Ctrl+P select) or
		// "cycle" (Ctrl+P cycle). Ignore restore/unknown sources.
		const source = event.source as string | undefined;
		if (source !== "set" && source !== "cycle") return;
		const identity = model_identity_of(model);
		if (!identity) return;
		const existing = get_mode_model(mode_models, currentMode);
		if (identities_equal(existing, identity)) return;
		mode_models = bind_mode_model(mode_models, currentMode, identity);
		writePersistedState({ mode: currentMode, modeModels: mode_models });
	});

	pi.on("thinking_level_select", (_event: any, ctx: any) => {
		if (!is_live_session(ctx)) return;
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
