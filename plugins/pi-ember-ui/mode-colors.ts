export const MODE_COLORS: Record<string, string> = {
	code: "#EB6E00",
	plan: "#A78BFA",
	debug: "#34D399",
	orchestrate: "#FACC15",
};

export const MUTED_BULLET_COLOR = "#666666";
export const DIM_COLOR = MUTED_BULLET_COLOR;
export const MUTED_COLOR = "#808080";
export const PAGE_BG = "#18181e";
export const TEXT_COLOR = "#d4d4d4";

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
	activeModeId = modeId in MODE_COLORS ? modeId : "code";
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

export function isShellMode(): boolean {
	return (globalThis as any)[SHELL_MODE_KEY] === true;
}

export function setShellMode(active: boolean): void {
	(globalThis as any)[SHELL_MODE_KEY] = active;
}

/** Quiz-overlay-active flag stored on `globalThis` via `Symbol.for`
 *  so it survives jiti module duplication (same pattern as SHELL_MODE_KEY).
 *  Set by the quiz tool when a custom overlay opens/closes. Read
 *  by the Thinking/Working widget to suppress itself while a quiz
 *  (e.g. Plan Review, Tool Loop Detected) is showing. */
const QUIZ_ACTIVE_KEY = Symbol.for("pi-ember-ui:quiz-active");

export function isQuizActive(): boolean {
	return (globalThis as any)[QUIZ_ACTIVE_KEY] === true;
}

export function setQuizActive(active: boolean): void {
	(globalThis as any)[QUIZ_ACTIVE_KEY] = active;
}

let latestSubagentRunningFlag = false;

/**
 * Whether the latest tool call in the session is a running subagent.
 * Set by pi-ember-ui's editor border patch (which has session access)
 * and read by both the border patch and the subagent renderer (via
 * this shared module) to draw the integrated border + cap line.
 */
export function isLatestSubagentRunning(): boolean {
	return latestSubagentRunningFlag;
}

export function setLatestSubagentRunning(active: boolean): void {
	latestSubagentRunningFlag = active;
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

let thinkingBlocksHidden = false;

export function isThinkingBlocksHidden(): boolean {
	return thinkingBlocksHidden;
}

export function setThinkingBlocksHidden(hidden: boolean): void {
	thinkingBlocksHidden = hidden;
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

/**
 * Render `text` in the live accent color, bypassing `theme.fg("accent")`
 * which reads from the global theme proxy that can briefly hold the
 * disk-seed Coder accent after Pi's theme watcher reloads `ember.json`.
 * Uses the same accent derivation as `buildThemeFgColors` (`accentDesat`
 * = accent blended 80% toward TEXT_COLOR) so the footer matches the
 * theme's own accent token exactly.
 */
export function liveAccentFg(text: string): string {
	return colorize(blendToHex(getActiveModeColor(), TEXT_COLOR, 0.8), text);
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
	const userMsgBg = buildUserMessageBgHex(accentHex);
	const accent90 = blendToHex(accentHex, PAGE_BG, 0.9);
	const accent60 = blendToHex(accentHex, PAGE_BG, 0.6);
	const accent30 = blendToHex(accentHex, PAGE_BG, 0.3);
	const accent20 = blendToHex(accentHex, PAGE_BG, 0.2);
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

export function buildThemeBgColors(accentHex: string): Record<string, string> {
	return {
		selectedBg: "#3a3a4a",
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
