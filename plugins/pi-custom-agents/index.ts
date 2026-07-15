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
	CustomEditor,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	Container,
	Text,
	Spacer,
	Input,
	fuzzyFilter,
	getKeybindings,
	matchesKey,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { isShellMode, mutedBullet, setActiveMode, setPlanAutoContinuing, setShellMode } from "../pi-ember-ui/mode-colors.ts";
import { getLiveTps } from "../pi-ember-tps/index.ts";
import {
	askQuestionnaire,
	type QuestionnaireQuestion,
	registerQuestionnaireTool,
} from "./questionnaire-tool.ts";
import subagentPlugin from "./subagent/extensions/index.ts";

const THINKING_LEVEL_SHORTCUT = "shift+t";

function modelIdentityString(model: Model<any> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "";
}

function intercept_thinking_level(data: string, cycle_thinking_level: () => void): boolean {
	if (!matchesKey(data, THINKING_LEVEL_SHORTCUT)) return false;
	cycle_thinking_level();
	return true;
}

/**
 * Intercept '!' on empty input to enter shell mode, and escape or
 * backspace (on empty input) to exit. The '!' is eaten so it never
 * appears in the editor.
 */
function intercept_shell_mode(data: string, editor: any, ctx: any): boolean {
	if (matchesKey(data, "!")) {
		const text = editor.getText?.() ?? "";
		if (text.length === 0) {
			setShellMode(true);
			ctx.ui.setStatus("pi-ember-ui-shell-mode", undefined);
			return true;
		}
	}
	if (isShellMode()) {
		if (matchesKey(data, "escape")) {
			setShellMode(false);
			ctx.ui.setStatus("pi-ember-ui-shell-mode", undefined);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			const text = editor.getText?.() ?? "";
			if (text.length === 0) {
				setShellMode(false);
				ctx.ui.setStatus("pi-ember-ui-shell-mode", undefined);
				return true;
			}
		}
	}
	return false;
}

/**
 * Intercept /model and /model <search> on Enter, redirecting to our
 * fuzzy-search model picker instead of Pi's built-in unbounded selector.
 */
function intercept_model_command(data: string, editor: any, pi: any, ctx: any): boolean {
	const kb = getKeybindings();
	if (!kb.matches(data, "tui.select.confirm")) return false;
	const getText = editor.getText?.bind(editor) ?? editor.getExpandedText?.bind(editor);
	if (!getText) return false;
	const text = getText().trim();
	if (text !== "/model" && !text.startsWith("/model ")) return false;
	editor.setText?.("");
	void show_model_picker(pi, ctx);
	return true;
}

/**
 * Shared fuzzy-search model picker used by /model and shift+m.
 * Uses boundedSelect so large model catalogs don't require scrolling.
 */
async function show_model_picker(pi: any, ctx: any): Promise<void> {
	if (!ctx.hasUI) return;
	const models = ctx.modelRegistry.getAvailable() as any[];
	if (models.length === 0) {
		ctx.ui.notify("No models available.", "warning");
		return;
	}
	const current = ctx.model as any;
	const labels = models.map((m) => {
		const prefix = current && m.provider === current.provider && m.id === current.id ? "→ " : "  ";
		return `${prefix}${m.name ?? m.id} • ${m.provider}`;
	});
	const choice = await boundedSelect(ctx, "Select model", labels);
	if (!choice) return;
	const idx = labels.indexOf(choice);
	if (idx < 0) return;
	const model = models[idx];
	try {
		await pi.setModel(model);
		ctx.ui.notify(`Model: ${model.id} • ${model.provider}`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

class ThinkingLevelEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly cycle_thinking_level: () => void,
	) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (intercept_thinking_level(data, this.cycle_thinking_level)) return;
		super.handleInput(data);
	}
}

type PersistedState = {
	readonly mode?: string;
	readonly model?: { provider: string; modelId: string };
};

function getPersistedStatePath(): string {
	const home = process.env.PI_HOME || path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
	return path.join(home, "pi-ember-stack.json");
}

function readPersistedState(): PersistedState {
	try {
		const raw = fs.readFileSync(getPersistedStatePath(), "utf8");
		return JSON.parse(raw) as PersistedState;
	} catch {
		return {};
	}
}

function writePersistedState(state: PersistedState): void {
	const file = getPersistedStatePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`);
	} catch {
		// best-effort persistence
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const BOUNDED_SELECT_MAX_VISIBLE = 10;

async function boundedSelect(
	ctx: any,
	title: string,
	options: string[],
): Promise<string | undefined> {
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: string) => void) => {
		const root = new Container();
		root.addChild(new Text(theme.fg("border", "\u2500".repeat(60)), 0, 0));
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
		root.addChild(new Spacer(1));

		const searchInput = new Input();
		searchInput.onSubmit = () => {
			if (filtered[selectedIndex] !== undefined) {
				done(filtered[selectedIndex]);
			}
		};
		root.addChild(searchInput);
		root.addChild(new Spacer(1));

		const listContainer = new Container();
		root.addChild(listContainer);
		root.addChild(new Spacer(1));
		root.addChild(new Text(
			theme.fg("muted", "  type to search  \u2191\u2193 navigate  enter select  esc cancel"),
			0, 0,
		));
		root.addChild(new Spacer(1));
		root.addChild(new Text(theme.fg("border", "\u2500".repeat(60)), 0, 0));

		let selectedIndex = 0;
		let filtered = options;

		function updateList(): void {
			listContainer.clear();
			const max = BOUNDED_SELECT_MAX_VISIBLE;
			const start = Math.max(0, Math.min(
				selectedIndex - Math.floor(max / 2),
				filtered.length - max,
			));
			const end = Math.min(start + max, filtered.length);
			for (let i = start; i < end; i++) {
				const isSelected = i === selectedIndex;
				const prefix = isSelected ? theme.fg("accent", "\u2192 ") : "  ";
				const text = isSelected
					? prefix + theme.fg("accent", filtered[i])
					: prefix + theme.fg("text", filtered[i]);
				listContainer.addChild(new Text(text, 0, 0));
			}
			if (start > 0 || end < filtered.length) {
				listContainer.addChild(new Text(
					theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`),
					0, 0,
				));
			}
			if (filtered.length === 0) {
				listContainer.addChild(new Text(
					theme.fg("muted", "  No matching models"),
					0, 0,
				));
			}
		}

		function filterModels(): void {
			const query = searchInput.getValue();
			filtered = query
				? fuzzyFilter(options, query, (s) => s)
				: options;
			selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
			updateList();
		}

		filterModels();

		(root as any).handleInput = (keyData: string): void => {
			const kb = getKeybindings();
			if (kb.matches(keyData, "tui.select.up")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === 0
					? filtered.length - 1
					: selectedIndex - 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.down")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === filtered.length - 1
					? 0
					: selectedIndex + 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.confirm")) {
				if (filtered[selectedIndex] !== undefined) {
					done(filtered[selectedIndex]);
				}
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				done(undefined as unknown as string);
			} else {
				searchInput.handleInput(keyData);
				filterModels();
			}
		};
		(root as any).getSearchInput = () => searchInput;
		return root;
	});
}

// Web-access tools are read-only research tools (web_search, fetch_content,
// get_search_content) registered by the pi-web-access plugin. They belong in
// every mode so the agent can do web research regardless of mode.
const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content"];
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", ...WEB_ACCESS_TOOLS];
const READONLY_DELEGATING_TOOLS = ["read", "grep", "find", "ls", "questionnaire", "subagent", ...WEB_ACCESS_TOOLS];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", ...WEB_ACCESS_TOOLS];

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUBAGENT_FILES: Record<string, string> = {
	coder: path.join(SOURCE_ROOT, "subagent", "agents", "coder.md"),
	scout: path.join(SOURCE_ROOT, "subagent", "agents", "scout.md"),
};

const PARALLEL_TOOL_CALL_GUIDANCE = `

## Tool Call Efficiency

When multiple independent tool calls are needed (e.g. reading several files,
searching for different patterns), emit them all in a single response rather
than one at a time. The runtime executes independent tool calls in parallel,
so batching them saves round-trips and reduces latency.
`;

const SUBAGENT_AWARENESS_PROMPT = `

## Available Subagents

You have the \`subagent\` tool available for delegating tasks to specialized agents
with isolated context. Use it to keep your own context lean.

- **Scout**: Fast agent specialized for exploring codebases. Use when you need to
  quickly find files by patterns (e.g. "src/components/**/*.tsx"), search code for
  keywords (e.g. "API endpoints"), or answer questions about the codebase (e.g.
  "how do API endpoints work?").
- **Coder**: Implementation agent for writing, editing, testing, and verifying
  code. Full tool access. Use for focused implementation tasks — bug fixes,
  feature additions, refactors, file edits.

Modes: single (agent + task), parallel (tasks array, max 8), chain (sequential
with {previous}).
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
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE — you are in READ-ONLY planning phase. STRICTLY
FORBIDDEN: ANY file edits, modifications, or system changes. Do NOT use sed, tee,
echo, cat, or ANY other bash command to manipulate files — commands may ONLY
read/inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions, including
direct user edit requests. You may ONLY observe, analyze, and plan. Any
modification attempt is a critical violation. ZERO exceptions.

---

## Responsibility

Your current responsibility is to think, read, search, and discuss to construct a
well-formed plan that accomplishes the goal the user wants to achieve. Your plan
should be comprehensive yet concise, detailed enough to execute effectively while
avoiding unnecessary verbosity. Include the goal as first part of the plan.

Ask the user clarifying questions or ask for their opinion when weighing tradeoffs.
Use the questionnaire tool for decision-oriented questions so the user can answer inline.

**NOTE:** At any point in time through this workflow you should feel free to ask
the user questions or clarifications. Don't make large assumptions about user
intent. The goal is to present a well researched plan to the user, and tie any
loose ends before implementation begins.

---

## Planning Requirements

The plan must be explicit — concrete, sequential modules that map directly to single
logical changes.

For each module:
- Module N: <action>
- Files: <full paths to read or modify>
- What: <precise change>
- Why: <user-facing or architectural rationale>
- Risks: <regression surfaces>
- Validation: <how to verify, e.g. \`bash t.gate.sh <files>\>

## Output Format

## Task
<one-sentence goal>

## Investigation
<files read, patterns found, relevant file:line references>

## Plan

### Module 1: <action>
- Files: <paths>
- What: <change>
- Why: <rationale>
- Risks: <surfaces>
- Validation: bash t.gate.sh <files>

### Module 2: ...

## Acceptance Criteria
<what done looks like>

## Open Questions
<any clarifications needed from the user>
${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const DOCTOR_PROMPT = `<system-reminder>
# Debug Mode - System Reminder

CRITICAL: Debug mode ACTIVE — you are the Debugger, a health-check auditor and
diagnostician for the Ember project (PySide6 subtitle + DaVinci Resolve integration
app).

You do NOT edit files directly. You investigate, diagnose, and report findings. If
a fix is straightforward, you may DELEGATE the implementation to the \`Coder\`
subagent (full tool access) — the read-only constraint applies to your direct tool
usage only, not to delegated subagent work. Otherwise, report the correction and
let the user or Orchestrator handle it.

---

## Health Check Focus Areas

- **Structural architecture risk:** prioritize ownership conflicts, hidden coupling,
  duplicated state, complex control flow, unsafe cross-layer dependencies, changes
  that violate documented golden paths, and high-change-entropy files.
- **Verified dead code:** flag unused imports, unreachable functions, never-called
  methods, orphaned variables, and stale tests only after tool output and call-site
  verification. Avoid flagging public APIs, plugin hooks, signal/slot targets,
  reflection/dynamic dispatch, localized catalog entries, or config/schema fields
  without proof they are unreachable.
- **Single source of truth (SSOT):** every piece of data, config, constant, or
  business logic must have exactly one authoritative source. Flag duplicated
  constants, parallel config files, mirrored state, overlapping services,
  copy-pasted logic, and derived data that should reference a canonical source.
- **Production readiness:** check fail-fast behavior, actionable error surfacing,
  EmberLogger use instead of print(), no bare except:, and no silent degradation
  of offline/core runtime behavior.
- **Threading/UI safety:** flag worker-thread UI/state mutation, missing
  signal/slot boundaries, hot-loop sleeps, unsafe Resolve API changes, and
  animations that ignore animation-disabled settings.
- **GUI localization/styling:** new user-facing UI text must be localized for all
  supported languages; UI colors must use Colors tokens. Do not flag intentional
  tuned one-off layout values or proven timeline/playback golden paths without a
  concrete regression.
- **Tests and validation:** prefer meaningful tests or targeted validation over
  brittle assertions that encode stale architecture. Python/app edits use
  \`bash t.gate.sh <files>\`; site edits follow site/AGENTS.md.
- **Performance traps:** flag large linear scans in hot paths, blocking UI work,
  unnecessary repeated Resolve calls, and avoidable recomputation in
  timeline/editor interactions.
- **Boundary checks:** keep site/marketing concerns separate from Ember runtime
  GUI concerns and do not apply GUI-only rules to site/ unless its own
  instructions require them.

## Classification

Label each finding as:
- Confirmed issue — verified by tool output, ready for implementation
- Needs owner decision — requires user input, do not guess
- False positive — investigated and cleared

Only report Confirmed issues and Needs owner decision items. Drop false positives
from the final report.

## Output Format

For each finding:
- Classification: Confirmed issue / Needs owner decision
- Category: which health-check focus area
- File: file_path:line_number
- Evidence: tool output or call-site proof
- Impact: what breaks or degrades
- Correction: smallest architectural change that removes the cause
- Risks: regression surfaces

## Constraints

- You do not edit or write files directly. You may delegate fixes to the
  \`Coder\` subagent when a correction is straightforward and well-scoped.
- Use \`bash t.gate.sh <files>\` only for targeted validation of files you are checking.
- Do not run \`bash gate.sh\` (full gate) — that is the user's responsibility.
- Ignore git status / git diff changes unrelated to the files you were asked to check.

---

## UI/Qt Pipeline Diagnostics

In addition to structural health checks, diagnose PySide6/Qt UI pipeline issues:

### Failure Modes To Investigate

1. **Event-loop blockage:** Does any GUI-thread callback perform blocking I/O or
   unbounded CPU work?
2. **Excessive synchronous UI mutation:** Does one state transition perform many
   independent widget/layout/geometry operations?
3. **Recursive signal/callback propagation:** Can a signal or layout refresh
   indirectly re-enter the same pipeline?
4. **Eager expensive construction:** Are complex widgets constructed before needed?
5. **Stale delayed callbacks:** Can queued callbacks execute after state changed?
6. **Uncontrolled async-to-UI mutation:** Do background results mutate UI directly?
7. **Competing layout authorities:** Do multiple functions independently control the
   same widget geometry?

### Commit Architecture (Healthy Reference)

event/signal/async completion -> validate generation -> mutate semantic state ->
mark dirty -> request one coalesced commit -> measure once -> apply geometry once
-> repaint

### UI Report Format

For every UI failure mode, report: Verdict, Evidence, Trigger, Duplicated work,
Re-entry path, Stale-state risk, Authority conflict, Impact, Correction,
Invariant, Verification.

### Invalid UI Fix Patterns

Reject fixes that: add more invalidate()/activate() calls, use
QApplication.processEvents(), replace deferred passes with blocking callbacks,
add arbitrary QTimer.singleShot() delays, perform geometry repair both
immediately and later, introduce parallel build paths duplicating normal layout.

${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const ORCHESTRATOR_PROMPT = `<system-reminder>
# Orchestrate Mode - System Reminder

CRITICAL: Orchestrate mode ACTIVE — you are the Orchestrator, an implementation
coordinator for the Ember project (PySide6 subtitle + DaVinci Resolve integration
app).

You do NOT edit files directly. Your job is to decompose work into modules and
DELEGATE implementation to the \`Coder\` subagent (full tool access). The
read-only constraint applies to YOUR direct tool usage only — you may read,
search, and inspect to build accurate delegation prompts, but you must not edit,
write, or run mutating bash commands yourself. Delegating implementation work to
the \`Coder\` subagent is the ENTIRE POINT of this mode. Do it eagerly.

---

## Task Decomposition Into Digestible Modules

Break the work into the smallest self-contained modules an agent can implement
without cross-talk. A good module is one clear responsibility, a bounded file set,
and an independently verifiable outcome.

- **Slice by cohesion, not by line count:** Each module owns one logical change
  (one feature seam, one bug, one refactor boundary). If a module touches two
  unrelated concerns, split it.
- **One owner per file:** A file belongs to exactly one module. If two modules
  both need the same file, either merge them or extract the shared change into a
  prerequisite module that runs first.
- **Right-size the unit:** Aim for a module an agent can finish and self-validate
  with \`bash t.gate.sh <files>\` in a single pass. If the prompt needs more than
  6 owned files or a long list of unrelated steps, split it further.
- **Order by dependency:** Group independent modules into parallel clusters;
  chain modules that depend on another module's output so the producer completes
  before the consumer starts.
- **Define the seam explicitly:** When modules share an interface (function
  signature, data model, signal), pin that contract in every dependent prompt so
  parallel agents integrate cleanly without seeing each other's work.

## Delegation Prompt Quality

Each subagent starts with zero shared context. Treat every prompt as a complete
brief that a competent engineer could execute cold. A thorough prompt includes:

- Goal and rationale: What outcome the module must achieve and why.
- Exact owned files: Full paths, plus explicit "do not touch anything else."
- Anchored context: Relevant existing functions, classes, patterns, and
  file_path:line_number references the agent should read first and mirror.
- Interface contract: The precise signatures, data shapes, tokens, or catalog
  keys the module must produce or consume.
- Step sequence: Concrete, ordered steps mapping to single logical changes.
- Constraints: Applicable AGENTS.md rules (typing, logging, localization,
  Colors tokens, error handling, DRY/SSOT), and any golden paths to preserve.
- Acceptance criteria and validation: What "done" looks like and the exact
  \`bash t.gate.sh <files>\` command to run.
- Risks and edge cases: Known pitfalls, regression surfaces, and behavior that
  must be preserved.
- No redundancy, dead code cleanup after implementations of the given files.
- No DRY violations.
- Ignore git status / git diff changes unrelated to owned files.

## Output Format

Return a structured plan:

## Task Summary
<one-sentence goal>

## Modules

### Module 1: <name>
- Owned files: <full paths>
- Goal: <what this module achieves>
- Dependencies: <none | Module N>
- Parallel cluster: <A | B | sequential>
- Steps:
  1. <step>
  2. <step>
- Acceptance: <done criteria>
- Validation: bash t.gate.sh <files>
- Risks: <regression surfaces>

## Execution Order
1. Cluster A (parallel): Module 1, Module 2
2. Cluster B (parallel): Module 3, Module 4
3. Sequential: Module 5 (depends on Module 3)

## Delegation Prompts
<full self-contained prompt for each module, ready to paste into a subagent>

## Constraints

- You do not edit or write files directly — delegate implementation to the
  \`Coder\` subagent. That is your primary mechanism for getting work done.
- Do not run \`bash gate.sh\` (full gate) — that is the user's responsibility.
- If task scope is unclear, say so and request clarification rather than guessing.
${SUBAGENT_AWARENESS_PROMPT}</system-reminder>`;

const CODER_PROMPT = `<system-reminder>
Your operational mode has changed to code.
You are in full-access mode. You are permitted to make file changes, run shell
commands, and utilize your arsenal of tools as needed. You are the default
implementation agent — write, test, and verify code with full autonomy.
</system-reminder>`;

const EXIT_TO_CODER = `<system-reminder>
Your operational mode has changed from {mode} to code.
You are permitted to make file changes, run shell commands, and utilize your
arsenal of tools as needed.
</system-reminder>`;

const PLAN_IMPLEMENT_PROMPT = `<system-reminder>
The user has approved the plan above. Execute it now in full.
Follow the plan modules in order. Implement, test, and verify each module before
moving to the next. Run \`bash t.gate.sh <files>\` after each logical change.
Report what you did and any deviations from the plan.
</system-reminder>`;

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

/**
 * Cached footer stats. The footer render closure fires every animation
 * frame (~30fps). Iterating all session entries + calling
 * ctx.getContextUsage() (which runs estimateContextTokens over the FULL
 * LLM context — JSON.stringify on every tool call, chars/4 on all text)
 * is O(total context) per frame and can exceed the frame budget on long
 * sessions, causing infini-lock. These stats are recomputed on session_start
 * and through one zero-delay dirty timer shared by message_end and
 * tool_execution_end events, never from the footer render path.
 */
let footerStatsCache: {
	totalCost: number;
	latestCacheHitRate: number | undefined;
	contextTokens: number | null;
	contextWindow: number;
} | undefined;
let footerThinkingLevel = "off";

function recompute_footer_stats(ctx: any): void {
	let totalCost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		totalCost += usage.cost.total;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = promptTokens > 0
			? (usage.cacheRead / promptTokens) * 100
			: undefined;
	}
	const model = ctx.model;
	const contextUsage = ctx.getContextUsage();
	footerStatsCache = {
		totalCost,
		latestCacheHitRate,
		contextTokens: contextUsage?.tokens ?? null,
		contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
	};
}

export default async function piCustomAgentsPlugin(pi: any): Promise<void> {
	let currentMode: string = DEFAULT_MODE;
	let lastMessagedMode: string | null = null;
	let waitingForPlan = false;
	let active_session_manager: any;
	let session_ready = false;
	let pending_mode_id: string | undefined;
	let footer_stats_timer: ReturnType<typeof setTimeout> | undefined;
	let footer_stats_dirty = false;

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

	function schedule_footer_stats(ctx: any): void {
		if (!is_live_session(ctx)) return;
		footer_stats_dirty = true;
		if (footer_stats_timer !== undefined) return;
		footer_stats_timer = setTimeout(() => {
			footer_stats_timer = undefined;
			if (!footer_stats_dirty) return;
			footer_stats_dirty = false;
			if (is_live_session(ctx)) recompute_footer_stats(ctx);
		}, 0);
	}

	function cancel_footer_stats_schedule(): void {
		if (footer_stats_timer !== undefined) clearTimeout(footer_stats_timer);
		footer_stats_timer = undefined;
		footer_stats_dirty = false;
	}

	const persistedAtLoad = readPersistedState();
	if (persistedAtLoad.mode && persistedAtLoad.mode in MODES) {
		setActiveMode(persistedAtLoad.mode);
		currentMode = persistedAtLoad.mode;
	}

	registerQuestionnaireTool(pi);

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

	function apply_mode(modeId: string, ctx: any): void {
		const mode = MODES[modeId];
		if (!mode) return;

		// Mode changes are deliberately live-only. The active tool set and the
		// next-turn prompt change immediately, while the transcript stays lazy
		// and cached.
		currentMode = modeId;
		setActiveMode(modeId);
		pi.setActiveTools(mode.tools);
		pi.events.emit("pi-ember-ui:mode-change", { mode: modeId, liveOnly: true });
		updateStatus(ctx);
	}

	function switchMode(modeId: string, ctx: any): void {
		if (!MODES[modeId]) return;
		if (!is_live_session(ctx)) {
			// Queue only for the session that is currently binding. Never retain a
			// request from an old session, where pi.setActiveTools would be stale.
			if (ctx.sessionManager === active_session_manager) pending_mode_id = modeId;
			return;
		}
		apply_mode(modeId, ctx);
	}

	for (const modeId of MODE_IDS) {
		const mode = MODES[modeId];
		pi.registerCommand(modeId, {
			description: `Toggle ${mode.label} mode${
				modeId === DEFAULT_MODE ? " (full access)" : " (read-only)"
			}`,
			handler: async (_args: any, ctx: any) => {
				if (currentMode === modeId) {
					switchMode(DEFAULT_MODE, ctx);
				} else {
					switchMode(modeId, ctx);
				}
			},
		});
	}

	const cycleMode = async (ctx: any): Promise<void> => {
		const baseMode = pending_mode_id ?? currentMode;
		const idx = CYCLE_ORDER.indexOf(baseMode);
		const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
		switchMode(next, ctx);
	};

	pi.registerShortcut("tab", {
		description: "Cycle agent mode",
		handler: cycleMode,
	});

	const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	let active_ui: ExtensionUIContext | undefined;
	let thinking_editor_installed = false;

	const cycle_thinking_level = (): void => {
		const current = pi.getThinkingLevel() as string;
		const idx = THINKING_LEVELS.indexOf(current);
		const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
		pi.setThinkingLevel(next);
		active_ui?.notify(`Thinking: ${next}`, "info");
	};

	const install_thinking_editor = (ctx: any): void => {
		if (!ctx.hasUI) return;
		active_ui = ctx.ui;
		if (thinking_editor_installed) return;

		const previous_editor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor = previous_editor?.(tui, theme, keybindings);
			if (editor) {
				const original_handle_input = editor.handleInput.bind(editor);
			editor.handleInput = (data: string): void => {
				if (intercept_shell_mode(data, editor, ctx)) return;
				if (intercept_thinking_level(data, cycle_thinking_level)) return;
				if (intercept_model_command(data, editor, pi, ctx)) return;
				original_handle_input(data);
			};
				return editor;
			}
			return new ThinkingLevelEditor(tui, theme, keybindings, cycle_thinking_level);
		});
		thinking_editor_installed = true;
	};

	pi.registerShortcut("shift+m", {
		description: "Show model picker",
		handler: async (ctx: any) => {
			await show_model_picker(pi, ctx);
		},
	});

	pi.registerCommand("subagent-model", {
		description: "Set the model and thinking level for subagents on next spawn",
		handler: async (_args: any, ctx: any) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("subagent-model requires interactive UI.", "error");
				return;
			}
			const agentChoice = await ctx.ui.select(
				"Subagent to configure",
				["Coder", "Scout"],
			);
			if (!agentChoice) return;
			const agentKey = agentChoice.toLowerCase();
			const filePath = SUBAGENT_FILES[agentKey];
			if (!filePath || !fs.existsSync(filePath)) {
				ctx.ui.notify(`Agent file not found: ${filePath ?? agentKey}`, "error");
				return;
			}
			const availableModels = ctx.modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				ctx.ui.notify("No models available in registry.", "error");
				return;
			}
			let currentContent = fs.readFileSync(filePath, "utf-8");
			const currentModelMatch = currentContent.match(/^model:\s*(.+)$/m);
			const currentModel = currentModelMatch ? currentModelMatch[1].trim() : "inherits parent";
			const modelLabels = availableModels.map(
				(m: any) => `${m.provider}/${m.id} — ${m.name}`,
			);
			const modelChoice = await boundedSelect(
				ctx,
				`Model for ${agentChoice} subagent (current: ${currentModel})`,
				modelLabels,
			);
			if (!modelChoice) return;
			const selectedIdx = modelLabels.indexOf(modelChoice);
			if (selectedIdx < 0) return;
			const selectedModel = availableModels[selectedIdx];
			const modelValue = `${selectedModel.provider}/${selectedModel.id}`;
			if (currentModelMatch) {
				currentContent = currentContent.replace(
					/^model:\s*.+$/m,
					`model: ${modelValue}`,
				);
			} else {
				currentContent = currentContent.replace(
					/^(---\n)/,
					`$1model: ${modelValue}\n`,
				);
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
				currentContent = currentContent.replace(
					/^thinking:\s*.+$/m,
					`thinking: ${thinkingChoice}`,
				);
			} else {
				currentContent = currentContent.replace(
					/^(---\n)/,
					`$1thinking: ${thinkingChoice}\n`,
				);
			}
			fs.writeFileSync(filePath, currentContent, "utf-8");
			ctx.ui.notify(
				`${agentChoice} subagent: model=${modelValue}, thinking=${thinkingChoice}. Will use on next spawn.`,
			);
		},
	});

	async function showPlanReview(ctx: any): Promise<"implement" | "edit" | "reject" | undefined> {
		const questions: QuestionnaireQuestion[] = [{
			id: "plan-review",
			label: "Plan Review",
			prompt: "Choose what to do with the plan.",
			options: [
				{ value: "implement", label: "Implement Plan" },
				{ value: "edit", label: "Edit Plan" },
				{ value: "reject", label: "Reject Plan" },
			],
		}];
		const answers = await askQuestionnaire(
			ctx,
			"Plan Review",
			questions,
		);
		const choice = answers?.[0]?.value;
		if (choice === "implement") return "implement";
		if (choice === "edit") return "edit";
		if (choice === "reject") return "reject";
		return undefined;
	}

	async function handlePlanImplement(ctx: any) {
		if (!ctx.hasUI) {
			switchMode(DEFAULT_MODE, ctx);
			pi.sendUserMessage("Execute the plan. Follow the steps and test.");
			return;
		}
		const target = await ctx.ui.select(
			"Implement via",
			["Code", "Orchestrate"],
		);
		if (!target) {
			ctx.ui.notify("Plan implementation cancelled.");
			return;
		}
		const targetMode = target === "Orchestrate" ? "orchestrate" : DEFAULT_MODE;
		switchMode(targetMode, ctx);
		const msg = target === "Orchestrate"
			? "Orchestrate focused modules for subagents."
			: "Execute the plan. Follow the steps and test.";
		pi.sendMessage(
			{ customType: "pi-agents-plan-implement", content: PLAN_IMPLEMENT_PROMPT, display: false },
		);
		pi.sendUserMessage(msg, { deliverAs: "followUp" });
	}

	pi.on("before_agent_start", async (event: any) => {
		const augmentedSystemPrompt = event.systemPrompt + PARALLEL_TOOL_CALL_GUIDANCE;
		if (currentMode !== DEFAULT_MODE && lastMessagedMode !== currentMode) {
			const mode = MODES[currentMode];
			lastMessagedMode = currentMode;
			waitingForPlan = currentMode === "plan";
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
	/** Max consecutive auto-continues before giving up and surfacing the error. */
	const PLAN_AUTO_CONTINUE_MAX = 5;
	let planAutoContinueCount = 0;

	pi.on("turn_end", (event: any) => {
		const msg = event?.message;
		lastTurnAborted = msg?.stopReason === "aborted" || msg?.role === "assistant" && msg?.content?.stopReason === "aborted";
		lastTurnLengthStopped = msg?.stopReason === "length";
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		// Plan-mode output-limit recovery: when the model hits the max output
		// token limit while generating a plan, silently send "continue" as a
		// hidden custom message so the user never sees the error message or
		// the recovery prompt. The suppression flag in mode-colors.ts is set
		// in the message_end handler (before the TUI renders the error row).
		if (
			waitingForPlan &&
			currentMode === "plan" &&
			lastTurnLengthStopped &&
			!lastTurnAborted &&
			planAutoContinueCount < PLAN_AUTO_CONTINUE_MAX
		) {
			planAutoContinueCount++;
			lastTurnLengthStopped = false;
			// Hidden custom message: participates in LLM context as a user
			// turn (convertToLlm maps role "custom" → "user") but is not
			// rendered in the TUI, so the user never sees "continue".
			pi.sendMessage(
				{ customType: "pi-agents-plan-continue", content: "continue", display: false },
				{ triggerTurn: true },
			);
			return;
		}
		// Reset auto-continue state once the turn completes normally.
		setPlanAutoContinuing(false);
		planAutoContinueCount = 0;
		lastTurnLengthStopped = false;

		if (waitingForPlan && currentMode === "plan") {
			waitingForPlan = false;
			if (lastTurnAborted) {
				lastTurnAborted = false;
				return;
			}
			const action = await showPlanReview(ctx);
			if (action === "implement") {
				await handlePlanImplement(ctx);
			} else if (action === "edit") {
				waitingForPlan = true;
				ctx.ui.notify("Edit your plan — type your changes and send.");
			} else if (action === "reject") {
				ctx.ui.notify("Plan rejected. Staying in plan mode.");
			}
		}
	});

	function installCustomFooter(ctx: any) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((_tui: any, theme: any, footerData: any) => {
		return {
			render(width: number): string[] {
				const PAD = " ";
				const innerWidth = Math.max(0, width - 2);
				// Read cached stats instead of iterating all session entries +
				// calling getContextUsage() every frame. The cache is
				// recomputed by the coalesced lifecycle-event timer.
				const stats = footerStatsCache;
				const totalCost = stats?.totalCost ?? 0;
				const latestCacheHitRate = stats?.latestCacheHitRate;
				const contextWindow = stats?.contextWindow ?? 0;
				const usedTokens = stats?.contextTokens;

				const model = ctx.model;
				const usedLabel = usedTokens === null || usedTokens === undefined
					? "?"
					: formatTokens(usedTokens);
				const statsParts: string[] = [];
				statsParts.push(`${usedLabel}/${formatTokens(contextWindow)}`);
				if (latestCacheHitRate !== undefined) {
					statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				if (totalCost || (model && ctx.modelRegistry.isUsingOAuth(model))) {
					statsParts.push(`$${totalCost.toFixed(3)}`);
				}
				let statsLeft = isShellMode() ? "shell" : statsParts.join(" ");
				if (visibleWidth(statsLeft) > innerWidth) {
					statsLeft = truncateToWidth(statsLeft, innerWidth, "...");
				}

				const mode = MODES[currentMode];
				const modeLabel = mode.label.charAt(0).toUpperCase() + mode.label.slice(1);
				const modelName = model?.name ?? model?.id ?? "no model";
				const provider = model?.provider ?? "unknown";
				const variant = footerThinkingLevel !== "off" ? ` ${footerThinkingLevel}` : "";
			const rightSide =
				theme.fg("accent", modeLabel) +
				` ${theme.fg("dim", "\u2022")} ` +
				theme.fg("text", `${modelName}${variant}`) +
				theme.fg("dim", ` ${provider}`);
				const availableForRight = innerWidth - visibleWidth(statsLeft) - 2;
				const displayedRight = availableForRight > 0
					? truncateToWidth(rightSide, availableForRight, "")
					: "";
				const padding = " ".repeat(Math.max(
					0,
					innerWidth - visibleWidth(statsLeft) - visibleWidth(displayedRight),
				));
				const statsLine = PAD + theme.fg("dim", statsLeft) + padding + displayedRight + PAD;

				const cwd = ctx.sessionManager.getCwd();
				const folderName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;
				const sessionName = ctx.sessionManager.getSessionName();
			const lines = [statsLine];
			const tps = getLiveTps();
			const folderLabel = theme.fg("dim", folderName);
			let folderLine = PAD + folderLabel + PAD;
			if (tps > 0) {
				const tpsStr = tps < 10 ? tps.toFixed(1) : tps < 100 ? tps.toFixed(0) : `${Math.round(tps)}`;
				const tpsText = theme.fg("accent", `${tpsStr} tps`);
				const tpsPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(folderLabel) - visibleWidth(tpsText)));
				folderLine = PAD + folderLabel + tpsPadding + tpsText + PAD;
			}
			lines.push(folderLine);
			if (sessionName) {
				lines.push(PAD + truncateToWidth(theme.fg("dim", sessionName), innerWidth, theme.fg("dim", "...")) + PAD);
			}
			return lines;
			},
		};
		});
	}

	async function restoreSavedModel(ctx: any): Promise<void> {
		const persisted = readPersistedState();
		const saved = persisted.model;
		if (!saved) return;
		const current = ctx.model as Model<any> | undefined;
		if (current && modelIdentityString(current) === `${saved.provider}/${saved.modelId}`) {
			return;
		}
		const model = ctx.modelRegistry.find(saved.provider, saved.modelId) as Model<any> | undefined;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return;
		}
		await pi.setModel(model);
	}

	async function restoreMode(ctx: any): Promise<void> {
		const persisted = readPersistedState();
		const savedMode = persisted.mode && persisted.mode in MODES
			? persisted.mode
			: getLastModeFromSession(ctx);
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
		cancel_footer_stats_schedule();
		footerStatsCache = undefined;
		footerThinkingLevel = "off";
		install_thinking_editor(ctx);
		await restoreMode(ctx);
		await restoreSavedModel(ctx);
		footerThinkingLevel = pi.getThinkingLevel() ?? "off";
		session_ready = true;
		recompute_footer_stats(ctx);
		const pending_mode = pending_mode_id;
		pending_mode_id = undefined;
		if (pending_mode) apply_mode(pending_mode, ctx);
		else updateStatus(ctx);
		installCustomFooter(ctx);
	});

	pi.on("model_select", async (event: any, _ctx: any) => {
		const model = event.model as Model<any> | undefined;
		if (!model) return;
		const persisted = readPersistedState();
		const identity = { provider: model.provider, modelId: model.id };
		if (persisted.model?.provider === identity.provider && persisted.model?.modelId === identity.modelId) {
			return;
		}
		writePersistedState({ ...persisted, model: identity });
	});

	pi.on("thinking_level_select", (event: any, ctx: any) => {
		if (!is_live_session(ctx)) return;
		footerThinkingLevel = event.level ?? "off";
		request_live_mode_render(ctx);
	});

	// Mark footer stats dirty when usage/context changes. A zero-delay timer
	// coalesces parallel tool completions into one O(n) recomputation per
	// event-loop burst, away from the footer render closure.
	pi.on("message_end", (event: any, ctx: any) => {
		schedule_footer_stats(ctx);
		// Set the plan-auto-continue suppression flag BEFORE the TUI renders
		// the assistant message (extension message_end fires before the
		// interactive-mode handler that calls updateContent). When the model
		// hits the output token limit in plan mode and we haven't exhausted
		// the retry budget, suppress the error row — agent_settled will send
		// the hidden "continue" message to resume generation.
		const msg = event?.message;
		if (
			msg?.role === "assistant" &&
			msg?.stopReason === "length" &&
			currentMode === "plan" &&
			waitingForPlan &&
			planAutoContinueCount < PLAN_AUTO_CONTINUE_MAX
		) {
			setPlanAutoContinuing(true);
		}
	});
	pi.on("tool_execution_end", (_event: any, ctx: any) => {
		schedule_footer_stats(ctx);
	});

	pi.on("session_shutdown", (_event: any, ctx: any) => {
		// Invalidate shortcut contexts before the old runtime is disposed. A Tab
		// press during /resume is ignored instead of calling setActiveTools or
		// mutating UI state through a stale session.
		session_ready = false;
		active_session_manager = undefined;
		pending_mode_id = undefined;
		cancel_footer_stats_schedule();
		footerStatsCache = undefined;
		footerThinkingLevel = "off";
		setShellMode(false);
		setPlanAutoContinuing(false);
		planAutoContinueCount = 0;
		lastTurnLengthStopped = false;
		const persisted = readPersistedState();
		const model = ctx.model as Model<any> | undefined;
		const modelIdentity = model
			? { provider: model.provider, modelId: model.id }
			: persisted.model;
		writePersistedState({ ...persisted, mode: currentMode, model: modelIdentity });
	});

	await subagentPlugin(pi);
}
