/**
 * Pi Ember Stack — Primary Modes Extension
 *
 * Toggleable primary modes for the Ember project, mirroring opencode's
 * mode: primary agents. Each mode is a slash command that:
 *   - Restricts the active tool set
 *   - Injects a persisted system-reminder message (visible to the LLM)
 *   - Shows a status-bar indicator
 *   - Restores state on session resume
 *
 * Modes:
 *   /architect    — read-only planning, analysis, and architecture (replaces pi-plan)
 *   /coder        — full access (default mode, restores all tools)
 *   /doctor       — read-only health-check auditor
 *   /orchestrator — read-only task decomposition + delegation planner
 *   /ui-doctor    — read-only PySide6/Qt UI diagnostician
 */
 
import * as fs from "node:fs";
import * as path from "node:path";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	askQuestionnaire,
	registerQuestionnaireTool,
	type QuestionnaireQuestion,
} from "./questionnaire-tool.ts";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire"];

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SUBAGENT_FILES: Record<string, string> = {
	coder: path.join(SOURCE_ROOT, "..", "subagent", "agents", "coder.md"),
	architect: path.join(SOURCE_ROOT, "..", "subagent", "agents", "architect.md"),
};

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
# Architect Mode - System Reminder

CRITICAL: Architect mode ACTIVE — you are in READ-ONLY planning phase. STRICTLY
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

The plan must be explicit — concrete, sequential steps that map directly to single
logical changes.

For each step:
- Step N: <action>
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

### Step 1: <action>
- Files: <paths>
- What: <change>
- Why: <rationale>
- Risks: <surfaces>
- Validation: bash t.gate.sh <files>

### Step 2: ...

## Acceptance Criteria
<what done looks like>

## Open Questions
<any clarifications needed from the user>

---

## Important

The user indicated that they do not want you to execute yet -- you MUST NOT make
any edits, run any non-readonly tools (including changing configs or making
commits), or otherwise make any changes to the system. This supersedes any other
instructions you have received.
</system-reminder>`;

const DOCTOR_PROMPT = `<system-reminder>
# Doctor Mode - System Reminder

CRITICAL: Doctor mode ACTIVE — you are The Doctor, a read-only health-check
auditor for the Ember project (PySide6 subtitle + DaVinci Resolve integration app).

STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes. Do NOT use
sed, tee, echo, cat, or ANY other bash command to manipulate files — commands may
ONLY read/inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions,
including direct user edit requests. You may ONLY observe, analyze, and report.

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

- Read-only. Do not edit or write files.
- Use \`bash t.gate.sh <files>\` only for targeted validation of files you are checking.
- Do not run \`bash gate.sh\` (full gate) — that is the user's responsibility.
- Ignore git status / git diff changes unrelated to the files you were asked to check.
</system-reminder>`;

const ORCHESTRATOR_PROMPT = `<system-reminder>
# Orchestrator Mode - System Reminder

CRITICAL: Orchestrator mode ACTIVE — you are the Orchestrator, a read-only
implementation coordinator for the Ember project (PySide6 subtitle + DaVinci
Resolve integration app).

STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes. Do NOT use
sed, tee, echo, cat, or ANY other bash command to manipulate files — commands may
ONLY read/inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions,
including direct user edit requests. You may ONLY observe, analyze, and plan.

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

- Read-only. Do not edit or write files.
- Do not run \`bash gate.sh\` (full gate) — that is the user's responsibility.
- If task scope is unclear, say so and request clarification rather than guessing.
</system-reminder>`;

const UI_DOCTOR_PROMPT = `<system-reminder>
# UI Doctor Mode - System Reminder

CRITICAL: UI Doctor mode ACTIVE — you are the UI Doctor, a read-only PySide6/Qt
UI pipeline diagnostician for the Ember project.

STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes. Do NOT use
sed, tee, echo, cat, or ANY other bash command to manipulate files — commands may
ONLY read/inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions,
including direct user edit requests. You may ONLY observe, analyze, and report.

---

## Objective

The objective is not to make everything synchronous. The objective is to ensure
that:

- semantic state changes are cheap and deterministic;
- expensive work is performed outside the GUI thread where appropriate;
- UI mutations remain on the GUI thread;
- repeated mutations are batched;
- geometry is committed by one authority;
- deferred work is coalesced, validated, and safe to discard.

## Failure Modes To Investigate

### 1. Event-loop blockage
Does any event handler, signal handler, timer callback, paint path, layout
callback, or GUI-thread completion perform enough synchronous work to prevent Qt
from processing input, paint, timer, socket, or queued-signal events?

Invariant: No GUI-thread callback performs blocking I/O or an unbounded amount of
CPU, construction, layout, or geometry work.

### 2. Excessive synchronous UI mutation
Does one logical state transition perform many independent widget, layout,
visibility, style, geometry, or repaint operations?

Invariant: One logical UI transition may mutate state multiple times, but it
performs at most one geometry commit per widget hierarchy.

### 3. Recursive signal, callback, or refresh propagation
Can a signal, callback, visibility update, layout refresh, or state-application
function indirectly re-enter the same pipeline?

Invariant: A state transition cannot directly or indirectly execute the same
layout pipeline more than once before commit.

### 4. Eager expensive construction
Are complex widgets, layouts, models, overlays, editors, previews, or resources
constructed before they are needed?

Invariant: Expensive UI is constructed only when needed, unless profiling proves
eager construction is cheaper and operationally simpler.

### 5. Stale delayed callbacks
Can a queued callback, timer, animation completion, worker result, or deferred
geometry operation execute after the state it was created for has changed?

Invariant: Every delayed callback proves that its owner, generation, requested
state, and dependencies are still current before mutating UI.

### 6. Uncontrolled async-to-UI mutation
Do background results return to the GUI thread and immediately initiate several
unrelated UI mutations or layout pipelines?

Invariant: Async work may produce data, but only the GUI thread owns UI state and
only the central commit path owns geometry.

### 7. Competing layout or geometry authorities
Do multiple functions independently measure, resize, activate, synchronize,
enforce, or repair the same widget hierarchy?

Invariant: Exactly one function owns final measurement and geometry commit for a
given widget hierarchy.

## Commit Architecture (Healthy Reference)

event, signal, or async completion
-> validate current generation and state
-> mutate semantic UI state
-> mark dirty layout domains
-> request one coalesced commit
-> measure once
-> apply geometry once
-> repaint

A single deferred commit is valid. Several independently scheduled geometry
repairs are not.

## Doctor Report Format

For every failure mode, report:

- Verdict: Present / Absent / Unclear
- Evidence: Exact files, functions, and call chain
- Trigger: User action, initialization path, signal, timer, or async completion
- Duplicated work: Which operations repeat within the same logical transition
- Re-entry path: How the pipeline may invoke or schedule itself again
- Stale-state risk: Which captured values or delayed results may become obsolete
- Authority conflict: Which functions compete to control the same geometry
- Impact: Freeze, delayed paint, stale geometry, jitter, clipping, empty space,
  or incorrect state
- Correction: Smallest architectural change that removes the cause
- Invariant: Rule that prevents recurrence
- Verification: Instrumentation or test proving the correction

## Invalid Fix Patterns

Reject a proposed fix when it primarily does any of the following:

- adds more invalidate() or activate() calls;
- calls QApplication.processEvents() to make the UI appear responsive;
- replaces several deferred passes with one massive blocking callback;
- adds arbitrary QTimer.singleShot() delays;
- adds a synchronous=True or sequential=True flag across many callers without
  establishing one commit authority;
- performs the same geometry repair both immediately and later;
- introduces another "secure," "settle," or "enforce" callback;
- fixes one card while leaving the recursive outer-layout path intact;
- applies async results without generation validation;
- creates a parallel build path that duplicates the normal layout path.

## Acceptance Criteria

A UI fix is acceptable only when:

1. one logical transition results in at most one geometry commit per widget
   hierarchy;
2. repeated commit requests coalesce;
3. no stale callback can apply obsolete state;
4. no worker mutates widgets directly;
5. one function owns final geometry;
6. programmatic state restoration does not recursively trigger the pipeline;
7. expensive construction is justified or lazy;
8. the GUI thread performs no blocking I/O;
9. instrumentation shows bounded layout, resize, and paint counts;
10. removing the old repair callbacks does not reintroduce the defect.

## Constraints

- Read-only. Do not edit or write files.
- Do not run \`bash gate.sh\` (full gate) — that is the user's responsibility.
</system-reminder>`;

const CODER_PROMPT = `<system-reminder>
Your operational mode has changed to coder.
You are in full-access mode. You are permitted to make file changes, run shell
commands, and utilize your arsenal of tools as needed. You are the default
implementation agent — write, test, and verify code with full autonomy.
</system-reminder>`;

const EXIT_TO_CODER = `<system-reminder>
Your operational mode has changed from {mode} to coder.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your
arsenal of tools as needed.
</system-reminder>`;

const PLAN_IMPLEMENT_PROMPT = `<system-reminder>
The user has approved the plan above. Execute it now in full.
Follow the plan steps in order. Implement, test, and verify each step before
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
	architect: {
		id: "architect",
		label: "architect",
		icon: "A",
		color: "warning",
		tools: READONLY_TOOLS,
		enterMessage: ARCHITECT_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
	coder: {
		id: "coder",
		label: "coder",
		icon: "C",
		color: "success",
		tools: FULL_TOOLS,
		enterMessage: CODER_PROMPT,
		exitMessage: CODER_PROMPT,
	},
	doctor: {
		id: "doctor",
		label: "doctor",
		icon: "D",
		color: "warning",
		tools: READONLY_TOOLS,
		enterMessage: DOCTOR_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
	orchestrator: {
		id: "orchestrator",
		label: "orchestrator",
		icon: "O",
		color: "warning",
		tools: READONLY_TOOLS,
		enterMessage: ORCHESTRATOR_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
	"ui-doctor": {
		id: "ui-doctor",
		label: "ui-doctor",
		icon: "U",
		color: "warning",
		tools: READONLY_TOOLS,
		enterMessage: UI_DOCTOR_PROMPT,
		exitMessage: EXIT_TO_CODER,
	},
};

const MODE_IDS = Object.keys(MODES);
const DEFAULT_MODE = "coder";
const CYCLE_ORDER = ["coder", "architect", "orchestrator", "doctor", "ui-doctor"];

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

export default function piEmberStackExtension(pi: any) {
	let currentMode: string = DEFAULT_MODE;
	let lastMessagedMode: string | null = null;
	let waitingForPlan = false;
	registerQuestionnaireTool(pi);
	registerCollapsedEditTool(pi);

	function registerCollapsedEditTool(extensionApi: any): void {
		const editDefinition = createEditTool(SOURCE_ROOT);
		extensionApi.registerTool({
			name: "edit",
			label: "edit",
			description: editDefinition.description,
			parameters: editDefinition.parameters,
			renderShell: "self",

			async execute(
				toolCallId: string,
				params: any,
				signal: AbortSignal,
				onUpdate: any,
				ctx: any,
			) {
				return createEditTool(ctx.cwd).execute(
					toolCallId,
					params,
					signal,
					onUpdate,
				);
			},

			renderCall(args: any, theme: any): any {
				const filePath = String(args?.path ?? args?.file_path ?? "");
				return new Text(
					theme.fg("toolTitle", theme.bold("edit ")) +
						theme.fg("accent", filePath),
					0,
					0,
				);
			},

			renderResult(result: any, { isPartial }: any, theme: any): any {
				if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

				const content = result.content?.find((item: any) => item.type === "text");
				if (content?.text?.startsWith("Error")) {
					return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
				}

				const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
				let additions = 0;
				let removals = 0;
				for (const line of diff.split("\n")) {
					if (line.startsWith("+") && !line.startsWith("+++")) additions++;
					if (line.startsWith("-") && !line.startsWith("---")) removals++;
				}

				return new Text(
					theme.fg("success", `+${additions}`) +
						theme.fg("dim", " / ") +
						theme.fg("error", `-${removals}`),
					0,
					0,
				);
			},
		});
	}

	for (const modeId of MODE_IDS) {
		const mode = MODES[modeId];
		pi.events.emit("powerbar:register-segment", {
			id: `pi-agents-${modeId}`,
			label: `${mode.label} mode`,
		});
	}

	function updateStatus(ctx: any) {
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
	}

	function switchMode(modeId: string, ctx: any) {
		const mode = MODES[modeId];
		if (!mode) return;
		currentMode = modeId;
		pi.setActiveTools(mode.tools);
		if (modeId === DEFAULT_MODE) {
			ctx.ui.notify("Coder mode. Full access restored.");
		} else {
			ctx.ui.notify(`${mode.label} mode enabled. Tools: ${mode.tools.join(", ")}`);
		}
		updateStatus(ctx);
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
		const idx = CYCLE_ORDER.indexOf(currentMode);
		const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
		switchMode(next, ctx);
	};

	pi.registerShortcut("ctrl+space", {
		description: "Cycle agent mode",
		handler: cycleMode,
	});
	pi.registerShortcut("tab", {
		description: "Cycle agent mode",
		handler: cycleMode,
	});

	pi.registerCommand("subagent-model", {
		description: "Set the model used by coder or architect subagents on next spawn",
		handler: async (_args: any, ctx: any) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("subagent-model requires interactive UI.", "error");
				return;
			}
			const agentChoice = await ctx.ui.select(
				"Subagent to configure",
				["Coder", "Architect"],
			);
			if (!agentChoice) return;
			const agentKey = agentChoice.toLowerCase();
			const filePath = SUBAGENT_FILES[agentKey];
			if (!filePath || !fs.existsSync(filePath)) {
				ctx.ui.notify(`Agent file not found: ${filePath ?? agentKey}`, "error");
				return;
			}
			const allModels = ctx.modelRegistry.getAll();
			if (allModels.length === 0) {
				ctx.ui.notify("No models available in registry.", "error");
				return;
			}
			const modelLabels = allModels.map(
				(m: any) => `${m.provider}/${m.id} — ${m.name}`,
			);
			const currentContent = fs.readFileSync(filePath, "utf-8");
			const currentModelMatch = currentContent.match(/^model:\s*(.+)$/m);
			const currentModel = currentModelMatch ? currentModelMatch[1].trim() : "inherits parent";
			const modelChoice = await ctx.ui.select(
				`Model for ${agentChoice} subagent (current: ${currentModel})`,
				modelLabels,
			);
			if (!modelChoice) return;
			const selectedIdx = modelLabels.indexOf(modelChoice);
			if (selectedIdx < 0) return;
			const selectedModel = allModels[selectedIdx];
			const modelValue = `${selectedModel.provider}/${selectedModel.id}`;
			let updated: string;
			if (currentModelMatch) {
				updated = currentContent.replace(
					/^model:\s*.+$/m,
					`model: ${modelValue}`,
				);
			} else {
				updated = currentContent.replace(
					/^(---\n)/,
					`$1model: ${modelValue}\n`,
				);
			}
			fs.writeFileSync(filePath, updated, "utf-8");
			ctx.ui.notify(
				`${agentChoice} subagent model set to ${modelValue}. Will use on next spawn.`,
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
			pi.sendUserMessage("Execute the plan above. Follow the steps in order, implement, test, and verify each step.");
			return;
		}
		const target = await ctx.ui.select(
			"Implement via",
			["Coder", "Orchestrator"],
		);
		if (!target) {
			ctx.ui.notify("Plan implementation cancelled.");
			return;
		}
		const targetMode = target === "Orchestrator" ? "orchestrator" : DEFAULT_MODE;
		switchMode(targetMode, ctx);
		const msg = target === "Orchestrator"
			? "Execute the plan above. Decompose it into modules and produce delegation prompts for each."
			: "Execute the plan above. Follow the steps in order, implement, test, and verify each step.";
		pi.sendMessage(
			{ customType: "pi-agents-plan-implement", content: PLAN_IMPLEMENT_PROMPT, display: false },
			{ triggerTurn: true },
		);
		pi.sendUserMessage(msg);
	}

	pi.on("before_agent_start", async () => {
		if (currentMode !== DEFAULT_MODE && lastMessagedMode !== currentMode) {
			const mode = MODES[currentMode];
			lastMessagedMode = currentMode;
			waitingForPlan = currentMode === "architect";
			return {
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
				message: {
					customType: "pi-agents-exit",
					content: prevMode.exitMessage.replace("{mode}", prevMode.label),
					display: false,
				},
			};
		}
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		if (waitingForPlan && currentMode === "architect") {
			waitingForPlan = false;
			const action = await showPlanReview(ctx);
			if (action === "implement") {
				await handlePlanImplement(ctx);
			} else if (action === "edit") {
				waitingForPlan = true;
				ctx.ui.notify("Edit your plan — type your changes and send.");
			} else if (action === "reject") {
				ctx.ui.notify("Plan rejected. Staying in architect mode.");
			}
		}
	});

	function getThinkingLevelFromSession(ctx: any): string {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "thinking_level_change") {
				return (entry as any).thinkingLevel || "off";
			}
		}
		return "off";
	}

	function installCustomFooter(ctx: any) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((_tui: any, theme: any, footerData: any) => {
			return {
				render(width: number): string[] {
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						totalInput += usage.input;
						totalOutput += usage.output;
						totalCacheRead += usage.cacheRead;
						totalCacheWrite += usage.cacheWrite;
						totalCost += usage.cost.total;
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0
							? (usage.cacheRead / promptTokens) * 100
							: undefined;
					}

					const model = ctx.model;
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent === null
						? "?"
						: contextPercentValue.toFixed(1);
					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
					if (latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					if (totalCost || (model && ctx.modelRegistry.isUsingOAuth(model))) {
						statsParts.push(`$${totalCost.toFixed(3)}${ctx.modelRegistry.isUsingOAuth(model) ? " (sub)" : ""}`);
					}
					statsParts.push(`${contextPercent}%/${formatTokens(contextWindow)} (auto)`);
					let statsLeft = statsParts.join(" ");
					if (visibleWidth(statsLeft) > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
					}

					const mode = MODES[currentMode];
					const modeLabel = mode.label.charAt(0).toUpperCase() + mode.label.slice(1);
					const modelName = model?.name ?? model?.id ?? "no model";
					const provider = model?.provider ?? "unknown";
					const thinking = getThinkingLevelFromSession(ctx);
					const variant = thinking !== "off" ? ` ${thinking}` : "";
					const rightSide = theme.getThinkingBorderColor(thinking)(
						`${modeLabel} \u2022 ${provider}: ${modelName}${variant}`,
					);
					const availableForRight = width - visibleWidth(statsLeft) - 2;
					const displayedRight = availableForRight > 0
						? truncateToWidth(rightSide, availableForRight, "")
						: "";
					const padding = " ".repeat(Math.max(
						0,
						width - visibleWidth(statsLeft) - visibleWidth(displayedRight),
					));
					const statsLine = theme.fg("dim", statsLeft) + padding + displayedRight;

					let pwd = formatCwdForFooter(
						ctx.sessionManager.getCwd(),
						process.env.HOME || process.env.USERPROFILE,
					);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;
					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
						statsLine,
					];
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusEntries = Array.from(statuses.entries()) as Array<[
							string,
							string,
						]>;
						const statusLine = statusEntries
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		const restored = getLastModeFromSession(ctx);
		if (restored && restored !== DEFAULT_MODE) {
			currentMode = restored;
			lastMessagedMode = restored;
			pi.setActiveTools(MODES[restored].tools);
		} else {
			currentMode = DEFAULT_MODE;
			lastMessagedMode = null;
			pi.setActiveTools(FULL_TOOLS);
		}
		installCustomFooter(ctx);
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event: any, ctx: any) => {
		const restored = getLastModeFromSession(ctx);
		if (restored && restored !== DEFAULT_MODE) {
			currentMode = restored;
			lastMessagedMode = restored;
			pi.setActiveTools(MODES[restored].tools);
		} else {
			currentMode = DEFAULT_MODE;
			lastMessagedMode = null;
			pi.setActiveTools(FULL_TOOLS);
		}
		updateStatus(ctx);
		installCustomFooter(ctx);
	});
}
