export const MODE_COLORS: Record<string, string> = {
	code: "#EB6E00",
	plan: "#A78BFA",
	debug: "#34D399",
	orchestrate: "#FACC15",
};

export const MUTED_BULLET_COLOR = "#666666";
export const MUTED_COLOR = "#808080";

export const PAGE_BG = "#18181e";

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

let shellModeActive = false;

export function isShellMode(): boolean {
	return shellModeActive;
}

export function setShellMode(active: boolean): void {
	shellModeActive = active;
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
 * Whether any compact tool group (Exploring or Working) currently has at
 * least one running member. Set by pi-compact-tools lifecycle handlers and
 * read by the pi-ember-ui thinking widget render closure so the
 * Thinking/Working row can be hidden while a group header carries the
 * gradient.
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
	return `#${rgb
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

export function blendToHex(
	fgHex: string,
	bgHex: string,
	opacity: number,
): string {
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

export function buildThemeFgColors(accentHex: string): Record<string, string> {
	const accent90 = blendToHex(accentHex, PAGE_BG, 0.9);
	const accent60 = blendToHex(accentHex, PAGE_BG, 0.6);
	const accent30 = blendToHex(accentHex, PAGE_BG, 0.3);
	const accent20 = blendToHex(accentHex, PAGE_BG, 0.2);
	const accent15 = blendToHex(accentHex, PAGE_BG, 0.15);
	const accent25 = blendToHex(accentHex, PAGE_BG, 0.25);
	const accent35 = blendToHex(accentHex, PAGE_BG, 0.35);
	const accent45 = blendToHex(accentHex, PAGE_BG, 0.45);
	const accent75 = blendToHex(accentHex, PAGE_BG, 0.75);
	const TEXT_COLOR = "#d4d4d4";
	const accentDesat = blendToHex(accentHex, TEXT_COLOR, 0.8);

	return {
		// Accent-derived tokens (90% opacity blend)
		accent: accentDesat,
		border: accent90,
		borderAccent: accent90,
		customMessageLabel: accent90,
		toolTitle: accentDesat,
		mdHeading: accent90,
		mdListBullet: accent90,
		mdLink: accent90,

		// Inline code foreground uses normal text color; only the
		// background rectangle (buildCodeBgHex) carries the accent tint.
		mdCode: "#d4d4d4",

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
		dim: "#666666",
		text: "#d4d4d4",
		thinkingText: MUTED_COLOR,
		userMessageText: "#d4d4d4",
		customMessageText: "#d4d4d4",
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
		syntaxOperator: "#D4D4D4",
		syntaxPunctuation: "#D4D4D4",
		bashMode: "#b5bd68",
	};
}

export function buildThemeBgColors(accentHex: string): Record<string, string> {
	const userMsgBg = blendToHex(accentHex, PAGE_BG, 0.1);
	return {
		selectedBg: "#3a3a4a",
		userMessageBg: userMsgBg,
		subagentBg: blendToHex(accentHex, PAGE_BG, 0.09),
		customMessageBg: "#2d2838",
		toolPendingBg: "#282832",
		toolSuccessBg: "#283228",
		toolErrorBg: "#3c2828",
	};
}
