export const MODE_COLORS: Record<string, string> = {
	code: "#EB6E00",
	plan: "#A78BFA",
	debug: "#34D399",
	orchestrate: "#FACC15",
};

export const MUTED_BULLET_COLOR = "#666666";

export const PAGE_BG = "#18181e";

let activeModeId = "code";

export function getModeColor(modeId: string): string {
	return MODE_COLORS[modeId] ?? MODE_COLORS.code;
}

export function getActiveModeColor(): string {
	return getModeColor(activeModeId);
}

export function setActiveMode(modeId: string): void {
	activeModeId = modeId in MODE_COLORS ? modeId : "code";
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
		mdHeading: "#d4d4d4",
		mdListBullet: "#d4d4d4",
		mdLink: "#d4d4d4",

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
		muted: "#808080",
		dim: "#666666",
		text: "#d4d4d4",
		thinkingText: "#808080",
		userMessageText: "#d4d4d4",
		customMessageText: "#d4d4d4",
		toolOutput: "#808080",
		mdLinkUrl: "#666666",
		mdCodeBlock: "#b5bd68",
		mdCodeBlockBorder: "#808080",
		mdQuote: "#808080",
		mdQuoteBorder: "#808080",
		mdHr: "#808080",
		toolDiffAdded: "#b5bd68",
		toolDiffRemoved: "#cc6666",
		toolDiffContext: "#808080",
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
		customMessageBg: "#2d2838",
		toolPendingBg: "#282832",
		toolSuccessBg: "#283228",
		toolErrorBg: "#3c2828",
	};
}
