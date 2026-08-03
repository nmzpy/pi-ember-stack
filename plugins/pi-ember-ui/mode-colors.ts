export const ORANGE = "#EB6E00";

export const MUTED_BULLET_COLOR = "#666666";
export const DIM_COLOR = MUTED_BULLET_COLOR;
export const MUTED_COLOR = "#808080";

export const PAGE_BG = "#18181e";
export const TEXT_COLOR = "#d4d4d4";

/** Tokens-per-second color thresholds used by the footer meter. */
export const TPS_TEXT_THRESHOLD = 50;
export const TPS_ACCENT_THRESHOLD = 100;

/**
 * Shared muted background for user messages, subagent completed/failed rows,
 * and custom/compaction messages. White (#ffffff) at 5% opacity over PAGE_BG,
 * then desaturated to a pure neutral grey so the PAGE_BG blue bias does not
 * bleed through. Mode-independent — no orange/purple/green/yellow accent
 * tint. Matches the neutral character of MUTED_COLOR text.
 */
export const MUTED_MESSAGE_BG = desaturateHex(
	blendToHex("#ffffff", PAGE_BG, 0.05),
	1,
);

export const MODE_COLORS: Record<string, string> = {
	code: MUTED_COLOR,
	plan: MUTED_COLOR,
	orchestrate: MUTED_COLOR,
};

let activeModeId = "code";

export function getModeColor(modeId: string): string {
	return MODE_COLORS[modeId] ?? MODE_COLORS.code;
}

export function getActiveModeId(): string {
	return activeModeId;
}

export function getActiveModeColor(): string {
	return getModeColor(activeModeId);
}

export function setActiveMode(modeId: string): void {
	activeModeId = modeId || "code";
}

/** Shell-mode flag stored on `globalThis` via a `Symbol.for` key so it
 *  survives jiti module duplication. `mode-colors.ts` can be loaded as
 *  separate module instances when imported via different importer chains
 *  (shell-mode.ts vs index.ts vs pi-custom-agents/index.ts); a module-level
 *  `let` would be duplicated per instance, so `setShellMode(true)` in one
 *  instance wouldn't be visible to `isShellMode()` in another. `Symbol.for`\ *  returns the same symbol from the global registry regardless of which
 *  module instance calls it, and `globalThis` is a true singleton — same
 *  pattern used for `THEME_KEY` in index.ts. */
const SHELL_MODE_KEY = Symbol.for("pi-ember-ui:shell-mode");

type GlobalThis = typeof globalThis & Record<symbol, unknown>;

export function isShellMode(): boolean {
	return (globalThis as GlobalThis)[SHELL_MODE_KEY] === true;
}

export function setShellMode(active: boolean): void {
	(globalThis as GlobalThis)[SHELL_MODE_KEY] = active;
}

/** User `!` bash is actively streaming in the transcript (not shell-mode typing). */
const USER_BASH_RUNNING_KEY = Symbol.for("pi-ember-ui:user-bash-running");

export function isUserBashRunning(): boolean {
	return (globalThis as GlobalThis)[USER_BASH_RUNNING_KEY] === true;
}

export function setUserBashRunning(active: boolean): void {
	(globalThis as GlobalThis)[USER_BASH_RUNNING_KEY] = active;
}

/** Quiz-overlay-active flag stored on `globalThis` via `Symbol.for`
 *  so it survives jiti module duplication (same pattern as SHELL_MODE_KEY).
 *  Set by the quiz tool when a custom overlay opens/closes. Read
 *  by the Thinking/Working widget to suppress itself while a quiz
 *  (e.g. Plan Review, Tool Loop Detected) is showing. */
const QUIZ_ACTIVE_KEY = Symbol.for("pi-ember-ui:quiz-active");

export function isQuizActive(): boolean {
	return (globalThis as GlobalThis)[QUIZ_ACTIVE_KEY] === true;
}

export function setQuizActive(active: boolean): void {
	(globalThis as GlobalThis)[QUIZ_ACTIVE_KEY] = active;
}

/** Whether tool rows have appeared in the current turn. Set on `tool_call` /
 *  Cursor tool updates; cleared on visible user `message_start` and
 *  `session_shutdown`. Switches the Thinking host from the in-message bubble
 *  (pre-tool wait) to the above-editor widget once tools are on screen. */
const TURN_TOOL_TRANSCRIPT_ACTIVE_KEY = Symbol.for("pi-ember-ui:turn-tool-transcript-active");

export function isTurnToolTranscriptActive(): boolean {
	return (globalThis as GlobalThis)[TURN_TOOL_TRANSCRIPT_ACTIVE_KEY] === true;
}

export function setTurnToolTranscriptActive(active: boolean): void {
	(globalThis as GlobalThis)[TURN_TOOL_TRANSCRIPT_ACTIVE_KEY] = active;
}

/** Agent-run pending flag — globalThis so jiti module duplication cannot desync wait state. */
const AGENT_RUN_PENDING_KEY = Symbol.for("pi-ember-ui:agent-run-pending");
const USER_TURN_COMMITTED_KEY = Symbol.for("pi-ember-ui:user-turn-committed");
const USER_TURN_ANCHOR_TIMESTAMP_KEY = Symbol.for("pi-ember-ui:user-turn-anchor-timestamp");
const TOOL_EXECUTION_IN_FLIGHT_KEY = Symbol.for("pi-ember-ui:tool-execution-in-flight");
const PENDING_TOOL_CALL_IDS_KEY = Symbol.for("pi-ember-ui:pending-tool-call-ids");
const PENDING_TOOL_CALL_COUNT_KEY = Symbol.for("pi-ember-ui:pending-tool-call-count");
const STARTED_TOOL_CALL_IDS_KEY = Symbol.for("pi-ember-ui:started-tool-call-ids");
const COMPLETED_TOOL_CALL_IDS_KEY = Symbol.for("pi-ember-ui:completed-tool-call-ids");

/** Whether Pi may still auto-retry, compact, or continue follow-ups this turn. */
export function isAgentRunPending(): boolean {
	return (globalThis as GlobalThis)[AGENT_RUN_PENDING_KEY] === true;
}

export function setAgentRunPending(active: boolean): void {
	(globalThis as GlobalThis)[AGENT_RUN_PENDING_KEY] = active;
}

/** Set on visible user `message_start`; cleared on `agent_settled` / `session_shutdown`. */

export function isCurrentTurnAssistantTimestamp(timestamp: number | undefined): boolean {
	if (timestamp === undefined) return false;
	const anchor = (globalThis as GlobalThis)[USER_TURN_ANCHOR_TIMESTAMP_KEY] as
		| number
		| undefined;
	if (anchor === undefined) {
		// Without an anchor, only assistants from an active turn qualify — never
		// historical bubbles after session load / resume.
		return isUserTurnCommitted() || isAgentRunPending();
	}
	return timestamp >= anchor;
}

export function setUserTurnAnchorTimestamp(timestamp: number | undefined): void {
	if (timestamp === undefined) {
		delete (globalThis as GlobalThis)[USER_TURN_ANCHOR_TIMESTAMP_KEY];
	} else {
		(globalThis as GlobalThis)[USER_TURN_ANCHOR_TIMESTAMP_KEY] = timestamp;
	}
}

export function isUserTurnCommitted(): boolean {
	return (globalThis as GlobalThis)[USER_TURN_COMMITTED_KEY] === true;
}

export function setUserTurnCommitted(active: boolean): void {
	(globalThis as GlobalThis)[USER_TURN_COMMITTED_KEY] = active;
	if (!active) setUserTurnAnchorTimestamp(undefined);
}

/**
 * SSOT: agent is in the idle-thinking wait state (no tool/subagent in flight).
 * `thinkingActive` is passed from pi-ember-ui when a thinking stream has started.
 *
 * `userTurnCommitted` gates idle display between turns. `agentRunPending` alone
 * is sufficient during compact-and-continue / auto-continue sub-runs where
 * `agent_settled` clears the user flag before the next `agent_start`.
 */
export function is_agent_thinking_wait(thinkingActive = false): boolean {
	if (!isAgentRunPending() && !thinkingActive) return false;
	if (!isUserTurnCommitted() && !isAgentRunPending()) return false;
	if (isToolExecutionInFlight()) return false;
	if (isToolCallPending()) return false;
	if (isSubagentDelegationActive()) return false;
	if ((globalThis as GlobalThis)[QUIZ_ACTIVE_KEY] === true) return false;
	return true;
}

function tool_execution_in_flight_count(): number {
	const value = (globalThis as GlobalThis)[TOOL_EXECUTION_IN_FLIGHT_KEY];
	return typeof value === "number" && value > 0 ? value : 0;
}

function tool_call_id_set(key: symbol): Set<string> {
	const g = globalThis as GlobalThis;
	if (!g[key]) g[key] = new Set<string>();
	return g[key] as Set<string>;
}

/** True from the first streamed toolCall until its matching execution starts. */
export function isToolCallPending(): boolean {
	const count = (globalThis as GlobalThis)[PENDING_TOOL_CALL_COUNT_KEY];
	return (typeof count === "number" && count > 0) || tool_call_id_set(PENDING_TOOL_CALL_IDS_KEY).size > 0;
}

function pending_tool_call_count(): number {
	const value = (globalThis as GlobalThis)[PENDING_TOOL_CALL_COUNT_KEY];
	return typeof value === "number" && value > 0 ? value : 0;
}

function adjust_pending_tool_call_count(delta: number): void {
	const next = Math.max(0, pending_tool_call_count() + delta);
	if (next === 0) delete (globalThis as GlobalThis)[PENDING_TOOL_CALL_COUNT_KEY];
	else (globalThis as GlobalThis)[PENDING_TOOL_CALL_COUNT_KEY] = next;
}

function consume_pending_tool_call_id(toolCallId?: string): boolean {
	const pending = tool_call_id_set(PENDING_TOOL_CALL_IDS_KEY);
	if (toolCallId) {
		if (!pending.delete(toolCallId)) return false;
		adjust_pending_tool_call_count(-1);
		return true;
	}
	const first = pending.values().next().value;
	if (typeof first !== "string") return false;
	pending.delete(first);
	adjust_pending_tool_call_count(-1);
	return true;
}

/**
 * Record a streamed/announced tool call before Pi begins executing it. This
 * closes the deterministic gap between a provider's tool-call delta and
 * tool_execution_start, so Thinking cannot occupy that interval. Some
 * providers do not expose an id until toolcall_end, so the count is the
 * authoritative fallback and the id set is only a deduplication aid.
 */
export function markToolCallAnnounced(toolCallId?: string): void {
	if (toolCallId) {
		if (tool_call_id_set(COMPLETED_TOOL_CALL_IDS_KEY).has(toolCallId)) return;
		if (tool_call_id_set(STARTED_TOOL_CALL_IDS_KEY).has(toolCallId)) return;
		const pending = tool_call_id_set(PENDING_TOOL_CALL_IDS_KEY);
		if (pending.has(toolCallId)) return;
		pending.add(toolCallId);
	}
	adjust_pending_tool_call_count(1);
}

export function isToolExecutionInFlight(): boolean {
	return tool_execution_in_flight_count() > 0;
}

export function markToolExecutionStarted(toolCallId?: string): void {
	const g = globalThis as GlobalThis;
	g[TOOL_EXECUTION_IN_FLIGHT_KEY] = tool_execution_in_flight_count() + 1;
	consume_pending_tool_call_id(toolCallId);
	if (toolCallId) tool_call_id_set(STARTED_TOOL_CALL_IDS_KEY).add(toolCallId);
}

export function markToolExecutionEnded(toolCallId?: string): void {
	const g = globalThis as GlobalThis;
	g[TOOL_EXECUTION_IN_FLIGHT_KEY] = Math.max(0, tool_execution_in_flight_count() - 1);
	consume_pending_tool_call_id(toolCallId);
	if (toolCallId) {
		tool_call_id_set(STARTED_TOOL_CALL_IDS_KEY).delete(toolCallId);
		tool_call_id_set(COMPLETED_TOOL_CALL_IDS_KEY).add(toolCallId);
	}
}

/** Clear the per-turn tool-call lifecycle bridge and execution counter. */
export function resetToolCallTracking(): void {
	delete (globalThis as GlobalThis)[TOOL_EXECUTION_IN_FLIGHT_KEY];
	delete (globalThis as GlobalThis)[PENDING_TOOL_CALL_COUNT_KEY];
	tool_call_id_set(PENDING_TOOL_CALL_IDS_KEY).clear();
	tool_call_id_set(STARTED_TOOL_CALL_IDS_KEY).clear();
	tool_call_id_set(COMPLETED_TOOL_CALL_IDS_KEY).clear();
}

export function resetToolExecutionInFlight(): void {
	resetToolCallTracking();
}

/** Between tool batches while the agent is still working (OpenAI/Codex planning text). */
export function isInterRunGap(): boolean {
	return isAgentRunPending() && !isToolExecutionInFlight() && isTurnToolTranscriptActive();
}

/** Latest-subagent-running flag stored on `globalThis` via a `Symbol.for` key
 *  so it survives jiti module duplication. `pi-ember-ui/index.ts` and
 *  `pi-custom-agents/subagent` may each load `mode-colors.ts` as a distinct
 *  module instance; a module-level `let` would let one instance set the flag
 *  while another instance (the one `is_agent_thinking_wait` reads) stays false.
 */
const LATEST_SUBAGENT_RUNNING_KEY = Symbol.for("pi-ember-ui:latest-subagent-running");

/**
 * Whether the latest tool call in the session is a running subagent.
 * Set by pi-ember-ui's editor border patch (which has session access)
 * and read by both the border patch and the subagent renderer (via
 * this shared module) to draw the integrated border + cap line.
 */
export function isLatestSubagentRunning(): boolean {
	return (globalThis as GlobalThis)[LATEST_SUBAGENT_RUNNING_KEY] === true;
}

export function setLatestSubagentRunning(active: boolean): void {
	(globalThis as GlobalThis)[LATEST_SUBAGENT_RUNNING_KEY] = active;
}

let toolGroupActive = false;

/**
 * Whether any compact tool group (Exploring, Editing, Writing, or Bashing) currently has at
 * least one running member. Set by pi-compact-tools lifecycle handlers for
 * shared group state and gradient rendering.
 */
export function isToolGroupActive(): boolean {
	return toolGroupActive;
}

export function setToolGroupActive(active: boolean): void {
	toolGroupActive = active;
}

let groupThinkingChildActive = false;

/** Whether a settled compact group is painting an in-group Thinking child row. */
export function isGroupThinkingChildActive(): boolean {
	return groupThinkingChildActive;
}

export function setGroupThinkingChildActive(active: boolean): void {
	groupThinkingChildActive = active;
}

let groupReopenableActive = false;

/** Settled compact group can host in-group Thinking instead of the external widget. */
export function isGroupReopenableActive(): boolean {
	return groupReopenableActive;
}

export function setGroupReopenableActive(active: boolean): void {
	groupReopenableActive = active;
}

/**
 * Live parent subagent tool-call ids. This is the sole lifecycle record for
 * Thinking suppression: a delegated call blocks the external Thinking host
 * from `tool_execution_start` until its matching `tool_execution_end`.
 *
 * The set lives on `globalThis` so jiti module duplication cannot split the
 * lifecycle writer from the Thinking predicate. The latest-session scan is
 * retained separately for the editor border; it is not a second Thinking
 * suppression source.
 */
const SUBAGENT_DELEGATION_IDS_KEY = Symbol.for("pi-ember-ui:subagent-delegation-ids");

function subagent_delegation_ids(): Set<string> {
	const g = globalThis as GlobalThis;
	if (!g[SUBAGENT_DELEGATION_IDS_KEY]) {
		g[SUBAGENT_DELEGATION_IDS_KEY] = new Set<string>();
	}
	return g[SUBAGENT_DELEGATION_IDS_KEY] as Set<string>;
}

/**
 * SSOT for suppressing parent Thinking while a subagent is being delegated or
 * running. The matching lifecycle id is the sole authority.
 */
export function isSubagentDelegationActive(): boolean {
	return subagent_delegation_ids().size > 0;
}

/** Idempotent — safe if lifecycle delivery is replayed during a rebuild. */
export function markSubagentDelegationStarted(toolCallId: string): void {
	if (!toolCallId) return;
	subagent_delegation_ids().add(toolCallId);
	setLatestSubagentRunning(true);
}

/** End one delegated call without unblocking Thinking while siblings remain. */
export function markSubagentDelegationEnded(toolCallId: string): void {
	if (!toolCallId) return;
	const ids = subagent_delegation_ids();
	ids.delete(toolCallId);
	setLatestSubagentRunning(ids.size > 0);
}

export function resetSubagentDelegation(): void {
	subagent_delegation_ids().clear();
	setLatestSubagentRunning(false);
}

let thinkingBlocksHidden = false;

type ThinkingBlocksVisibilityListener = (hidden: boolean) => void;
let thinkingBlocksVisibilityListener: ThinkingBlocksVisibilityListener | undefined;

/** Register a listener fired when thinking-block visibility toggles (Ctrl+T). */
export function set_thinking_blocks_visibility_listener(
	listener: ThinkingBlocksVisibilityListener | undefined,
): void {
	thinkingBlocksVisibilityListener = listener;
}

export function isThinkingBlocksHidden(): boolean {
	return thinkingBlocksHidden;
}

export function setThinkingBlocksHidden(hidden: boolean): void {
	const prev = thinkingBlocksHidden;
	thinkingBlocksHidden = hidden;
	if (prev !== hidden) thinkingBlocksVisibilityListener?.(hidden);
}

let work_group_boundary_suppression_depth = 0;

/** Suppress compact work-group stream boundaries during Ctrl+T rebuild replay. */
export function begin_work_group_boundary_suppression(): void {
	work_group_boundary_suppression_depth++;
}

export function end_work_group_boundary_suppression(): void {
	work_group_boundary_suppression_depth = Math.max(0, work_group_boundary_suppression_depth - 1);
}

export function is_work_group_boundary_suppressed(): boolean {
	return work_group_boundary_suppression_depth > 0;
}

let planAutoContinuing = false;

/** Whether the plan-mode auto-continue (output-limit recovery) is in progress. */
export function isPlanAutoContinuing(): boolean {
	return planAutoContinuing;
}

export function setPlanAutoContinuing(active: boolean): void {
	planAutoContinuing = active;
}

export function hexToRgb(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `${r};${g};${b}`;
}

export function colorize(hex: string, text: string): string {
	return `\x1b[38;2;${hexToRgb(hex)}m${text}\x1b[39m`;
}



export function mutedBullet(): string {
	return colorize(MUTED_BULLET_COLOR, "\u2022");
}

// --- Color math for dynamic theme ---

export function hexToRgbTriplet(hex: string): [number, number, number] {
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
	];
}

export function rgbTripletToHex(rgb: [number, number, number]): string {
	return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function blendToHex(fgHex: string, bgHex: string, opacity: number): string {
	const [fr, fg, fb] = hexToRgbTriplet(fgHex);
	const [br, bg, bb] = hexToRgbTriplet(bgHex);
	return rgbTripletToHex([
		Math.round(br + (fr - br) * opacity),
		Math.round(bg + (fg - bg) * opacity),
		Math.round(bb + (fb - bb) * opacity),
	]);
}

/** Live TPS foreground blended toward PAGE_BG by the supplied alpha. */
export function tps_color_hex(tps: number, opacity = 1): string {
	const base_color =
		tps < TPS_TEXT_THRESHOLD
			? MUTED_COLOR
			: tps < TPS_ACCENT_THRESHOLD
				? TEXT_COLOR
				: buildThemeFgColors(getActiveModeColor()).accent;
	const clamped_opacity = Math.max(0, Math.min(1, opacity));
	return blendToHex(base_color, PAGE_BG, clamped_opacity);
}

export function desaturateHex(hex: string, amount: number): string {
	const [r, g, b] = hexToRgbTriplet(hex);
	const mean = (r + g + b) / 3;
	return rgbTripletToHex([
		Math.round(r + (mean - r) * amount),
		Math.round(g + (mean - g) * amount),
		Math.round(b + (mean - b) * amount),
	]);
}

export function buildCodeBgHex(accentHex: string): string {
	return blendToHex(accentHex, PAGE_BG, 0.05);
}

/** User-message pill background — accent at 10% over PAGE_BG. */
export function buildUserMessageBgHex(accentHex: string): string {
	return blendToHex(accentHex, PAGE_BG, 0.1);
}

export function buildThemeFgColors(accentHex: string): Record<string, string> {
	const _userMsgBg = buildUserMessageBgHex(accentHex);
	const accent90 = blendToHex(accentHex, PAGE_BG, 0.9);
	const accent60 = blendToHex(accentHex, PAGE_BG, 0.6);
	const accent30 = blendToHex(accentHex, PAGE_BG, 0.3);
	const _accent20 = blendToHex(accentHex, PAGE_BG, 0.2);
	const accent15 = blendToHex(accentHex, PAGE_BG, 0.15);
	const accent25 = blendToHex(accentHex, PAGE_BG, 0.25);
	const accent35 = blendToHex(accentHex, PAGE_BG, 0.35);
	const accent45 = blendToHex(accentHex, PAGE_BG, 0.45);
	const accent75 = blendToHex(accentHex, PAGE_BG, 0.75);
	const accentDesat = blendToHex(accentHex, TEXT_COLOR, 0.8);

	// Markdown chrome tokens stay non-mode-colored:
	// - mdHeading / mdListBullet ("1." / "-") use MUTED_COLOR
	// mdLink follows the live mode accent via accent90.

	return {
		// Accent-derived tokens (90% opacity blend)
		accent: accentDesat,
		border: accent90,
		borderAccent: accent90,
		customMessageLabel: accent90,
		toolTitle: accentDesat,
		mdHeading: MUTED_COLOR,
		mdListBullet: MUTED_COLOR,
		mdLink: accent90,

		// Inline code foreground uses normal text color; the background
		// rectangle uses the fixed MUTED_MESSAGE_BG (no accent tint).
		mdCode: TEXT_COLOR,

		// Border muted (30% opacity)
		borderMuted: accent30,

		// Thinking intensity ladder
		thinkingOff: accent15,
		thinkingMinimal: accent25,
		thinkingLow: accent35,
		thinkingMedium: accent45,
		thinkingHigh: accent60,
		thinkingXhigh: accent75,
		thinkingMax: accent90,

		// Non-accent tokens (same as ember.json)
		success: "#b5bd68",
		error: "#cc6666",
		warning: "#ffff00",
		muted: MUTED_COLOR,
		dim: MUTED_BULLET_COLOR,
		text: TEXT_COLOR,
		thinkingText: MUTED_COLOR,
		userMessageText: TEXT_COLOR,
		customMessageText: TEXT_COLOR,
		toolOutput: MUTED_COLOR,
		mdLinkUrl: "#666666",
		mdCodeBlock: "#b5bd68",
		mdCodeBlockBorder: MUTED_COLOR,
		mdQuote: MUTED_COLOR,
		mdQuoteBorder: MUTED_COLOR,
		mdHr: MUTED_COLOR,
		toolDiffAdded: "#b5bd68",
		toolDiffRemoved: "#cc6666",
		toolDiffContext: MUTED_COLOR,
		syntaxComment: "#6A9955",
		syntaxKeyword: "#569CD6",
		syntaxFunction: "#DCDCAA",
		syntaxVariable: "#9CDCFE",
		syntaxString: "#CE9178",
		syntaxNumber: "#B5CEA8",
		syntaxType: "#4EC9B0",
		syntaxOperator: TEXT_COLOR,
		syntaxPunctuation: TEXT_COLOR,
		bashMode: "#b5bd68",
	};
}

/** Slash-menu / autocomplete selected-row background (neutral, no accent tint). */
export const SELECTED_BG = blendToHex(TEXT_COLOR, PAGE_BG, 0.1);

export function buildThemeBgColors(_accentHex: string): Record<string, string> {
	return {
		selectedBg: SELECTED_BG,
		userMessageBg: MUTED_MESSAGE_BG,
		subagentBg: MUTED_MESSAGE_BG,
		customMessageBg: MUTED_MESSAGE_BG,
		toolPendingBg: "#282832",
		toolSuccessBg: "#283228",
		toolErrorBg: "#3c2828",
	};
}

/** Build the `export` section colors (pageBg, cardBg, infoBg) from the
 *  active accent and PAGE_BG. These are used by Pi's HTML export feature
 *  and by the curator page. Derived from the SSOT accent — never hardcode
 *  hex values for export backgrounds. */
export function buildThemeExportColors(accentHex: string): {
	pageBg: string;
	cardBg: string;
	infoBg: string;
} {
	return {
		pageBg: PAGE_BG,
		cardBg: blendToHex(accentHex, PAGE_BG, 0.04),
		infoBg: blendToHex(accentHex, PAGE_BG, 0.12),
	};
}
