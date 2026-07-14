import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	Theme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildCodeBgHex,
	buildThemeBgColors,
	buildThemeFgColors,
	getActiveModeColor,
} from "./mode-colors.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const THEME_JSON = path.join(SOURCE_ROOT, "ember.json");
const THEME_NAME = "ember";

const THINKING_FRAME_INTERVAL_MS = 60;
const LOGO = [
	"  ██████   ██",
	"  ██   ██  ██",
	"  ██████   ██",
	"  ██       ██",
	"  ██       ██",
	"  ██       ██",
];

const SHADOW_OFFSET_X = 1;
const SHADOW_OFFSET_Y = 0;
const SHADOW_GLYPH = "\u2591";
const SHADOW_OPACITY = 0.4;

let thinkingActive = false;
let workingActive = false;
let thinkingFrame = 0;
let thinkingInterval: ReturnType<typeof setInterval> | undefined;
let logoAnimating = false;
let logoFrame = 0;
let logoTimer: ReturnType<typeof setInterval> | undefined;
let editorRenderPatched = false;
let requestRender: (() => void) | undefined;
let sessionCtx: any;

type EditorWithBorder = Editor & {
	borderColor: (text: string) => string;
	getText: () => string;
};

function currentLabelText(): string {
	return thinkingActive ? "Thinking" : "Working";
}

function stopThinkingAnimation(): void {
	thinkingActive = false;
	if (!workingActive) {
		if (thinkingInterval) clearInterval(thinkingInterval);
		thinkingInterval = undefined;
	}
	requestRender?.();
}

function startThinkingAnimation(): void {
	thinkingActive = true;
	if (!thinkingInterval) {
		thinkingFrame = 0;
		thinkingInterval = setInterval(() => {
			thinkingFrame += 0.06;
			if (thinkingFrame > 1) thinkingFrame -= 1;
			requestRender?.();
		}, THINKING_FRAME_INTERVAL_MS);
	}
}

function startWorkingAnimation(): void {
	workingActive = true;
	if (!thinkingInterval) {
		thinkingFrame = 0;
		thinkingInterval = setInterval(() => {
			thinkingFrame += 0.06;
			if (thinkingFrame > 1) thinkingFrame -= 1;
			requestRender?.();
		}, THINKING_FRAME_INTERVAL_MS);
	}
}

function stopWorkingAnimation(): void {
	workingActive = false;
	if (!thinkingActive && thinkingInterval) {
		clearInterval(thinkingInterval);
		thinkingInterval = undefined;
	}
	requestRender?.();
}

function wrapThemeWithCodeBg(base: Theme): Theme {
	return new Proxy(base, {
		get(target: Theme, prop: string | symbol, receiver: any) {
			if (prop === "fg") {
				return (color: string, text: string) => {
					if (color === "mdCode") {
						return (
							liveCodeBgAnsi +
							target.getFgAnsi("mdCode" as any) +
							" " + text + " " +
							"\x1b[39m\x1b[49m"
						);
					}
					return target.fg(color as any, text);
				};
			}
			const val = Reflect.get(target, prop, receiver);
			return typeof val === "function" ? val.bind(target) : val;
		},
	});
}

function fgAnsi(hex: string): string {
	const [r, g, b] = hexToRgbTriplet(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string): string {
	const [r, g, b] = hexToRgbTriplet(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

let liveTheme: Theme | undefined;
let liveCodeBgAnsi = "";

function installProxiedTheme(fgColors: Record<string, string>, bgColors: Record<string, string>, codeBg: string): void {
	const base = new Theme(
		fgColors as any,
		bgColors as any,
		"truecolor",
		{ name: "ember" },
	);
	liveTheme = base;
	liveCodeBgAnsi = bgAnsi(codeBg);
	const wrapped = wrapThemeWithCodeBg(base);
	(globalThis as any)[THEME_KEY] = wrapped;
	(globalThis as any)[THEME_KEY_OLD] = wrapped;
}

function applyDynamicTheme(): void {
	const accent = getActiveModeColor();
	const fgColors = buildThemeFgColors(accent);
	const bgColors = buildThemeBgColors(accent);
	const codeBg = buildCodeBgHex(accent);

	if (liveTheme) {
		liveCodeBgAnsi = bgAnsi(codeBg);
		updateLiveThemeColors(fgColors, bgColors);
		(tuiRef as any)?.invalidate();
		requestRender?.();
		return;
	}
	installProxiedTheme(fgColors, bgColors, codeBg);
	requestRender?.();
}

function updateLiveThemeColors(fgColors: Record<string, string>, bgColors: Record<string, string>): void {
	if (!liveTheme) return;
	const fgMap = (liveTheme as any).fgColors as Map<string, string>;
	const bgMap = (liveTheme as any).bgColors as Map<string, string>;
	for (const [key, hex] of Object.entries(fgColors)) {
		fgMap.set(key, fgAnsi(hex));
	}
	for (const [key, hex] of Object.entries(bgColors)) {
		bgMap.set(key, bgAnsi(hex));
	}
}

function renderGradientLabel(text: string, accent: string): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return "";
	const textHex = "#808080";
	const result: string[] = [];
	for (let i = 0; i < len; i++) {
		const charPos = i / Math.max(1, len - 1);
		const dist = charPos - thinkingFrame;
		const wrapped = dist < -0.5 ? dist + 1 : dist > 0.5 ? dist - 1 : dist;
		const intensity = Math.exp(-(wrapped * wrapped) * 8);
		const hex = blendToHex(textHex, accent, intensity);
		result.push(colorize(chars[i], hex));
	}
	return result.join("");
}

function installThinkingBorderOverride(): void {
	if (editorRenderPatched) return;
	editorRenderPatched = true;
	const originalRender = Editor.prototype.render;
	Editor.prototype.render = function renderThinkingBorder(this: EditorWithBorder, width: number): string[] {
	const accent = getActiveModeColor();
	const accentLight = lightenHex(accent, 0.5);
	const accentBorder = (text: string): string => colorize(text, accentLight);
	const originalBorderColor = this.borderColor;
	this.borderColor = accentBorder;
	const innerWidth = Math.max(1, width - 2);
	const lines = originalRender.call(this, innerWidth);
	this.borderColor = originalBorderColor;

	const stripped = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
	const isBorderLine = (s: string): boolean => {
		const raw = stripped(s);
		return raw.length > 0 && [...raw].every((ch) => ch === "\u2500" || ch === " ");
	};
	const borderIndices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (isBorderLine(lines[i])) borderIndices.push(i);
	}
	const topIdx = borderIndices[0] ?? 0;
	const bottomBorderIdx = borderIndices.length > 1 ? borderIndices[borderIndices.length - 1] : -1;

	for (let i = 1; i < lines.length; i++) {
		if (i === bottomBorderIdx) continue;
		lines[i] = ` ${lines[i]} `;
	}
	lines[topIdx] = accentBorder("\u2500".repeat(width));
	if (bottomBorderIdx >= 0) {
		const inputText = this.getText?.() ?? "";
		if (inputText.trimStart().startsWith("/")) {
			lines[bottomBorderIdx] = ` ${colorWithOpacity("\u2500".repeat(width - 2), accentLight, 0.1875)} `;
		} else {
			lines[bottomBorderIdx] = accentBorder("\u2500".repeat(width));
		}
	}
		const lastLineIdx = lines.length - 1;
		if (lastLineIdx > bottomBorderIdx && lastLineIdx > 0) {
			lines[lastLineIdx] = accentBorder("\u2500".repeat(width));
		}
		if (lines.length === 0) return lines;
		if (!thinkingActive && !workingActive) return lines;

		const labelText = thinkingActive ? "Thinking" : "Working";
		const label = ` ${renderGradientLabel(labelText, accent)} `;
		const prefixLen = 2 + visibleWidth(label);
		const remaining = Math.max(0, width - prefixLen);
		lines[topIdx] = accentBorder("\u2500".repeat(2)) + label +
			accentBorder("\u2500".repeat(remaining));
		return lines;
	};
}

function colorWithOpacity(text: string, hex: string, opacity: number): string {
	const source = hex.slice(1);
	const base = [24, 24, 30];
	const rgb = [
		parseInt(source.slice(0, 2), 16),
		parseInt(source.slice(2, 4), 16),
		parseInt(source.slice(4, 6), 16),
	].map((value, index) => Math.round(base[index] + (value - base[index]) * opacity));
	return `\u001b[38;2;${rgb.join(";")}m${text}\u001b[39m`;
}

function hexToRgbTriplet(hex: string): [number, number, number] {
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
	];
}

function blendToHex(fgHex: string, bgHex: string, opacity: number): string {
	const [fr, fg, fb] = hexToRgbTriplet(fgHex);
	const [br, bg, bb] = hexToRgbTriplet(bgHex);
	const r = Math.round(br + (fr - br) * opacity);
	const g = Math.round(bg + (fg - bg) * opacity);
	const b = Math.round(bb + (fb - bb) * opacity);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function lightenHex(hex: string, amount: number): string {
	const [r, g, b] = hexToRgbTriplet(hex);
	const lr = Math.round(r + (255 - r) * amount);
	const lg = Math.round(g + (255 - g) * amount);
	const lb = Math.round(b + (255 - b) * amount);
	return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}

function colorize(text: string, hex: string): string {
	const [r, g, b] = hexToRgbTriplet(hex);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function folderNameFromCwd(cwd: string): string {
	return cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;
}

function welcomeConfigPath(): string {
	return path.join(
		process.env.PI_HOME || path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"),
		"welcome.json",
	);
}

function setWelcomeUpdates(enabled: boolean): void {
	const file = welcomeConfigPath();
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch { /* first-run, no file yet */ }
	config.updates = enabled;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
}

type RadialPoint = { x: number; y: number; r: number; g: number; b: number; falloff: number };

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function radialColorForCell(x: number, y: number, points: RadialPoint[]): [number, number, number] {
	let totalWeight = 0;
	let r = 0, g = 0, b = 0;
	for (const p of points) {
		const dx = x - p.x;
		const dy = y - p.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const weight = Math.exp(-(dist * dist) / (p.falloff * p.falloff));
		r += p.r * weight;
		g += p.g * weight;
		b += p.b * weight;
		totalWeight += weight;
	}
	return [
		Math.round(r / totalWeight),
		Math.round(g / totalWeight),
		Math.round(b / totalWeight),
	];
}

function startLogoAnimation(): void {
	if (logoTimer) return;
	logoAnimating = true;
	logoFrame = 0;
	logoTimer = setInterval(() => {
		logoFrame += 0.04;
		if (logoFrame > 1) logoFrame -= 1;
		requestRender?.();
	}, 60);
}

function stopLogoAnimation(): void {
	logoAnimating = false;
	if (logoTimer) {
		clearInterval(logoTimer);
		logoTimer = undefined;
	}
}

function renderLogoWithGradient(accent: string): string[] {
	const [ar, ag, ab] = hexToRgbTriplet(accent);
	const accent70 = blendToHex(accent, "#18181e", 0.7);
	const [s7r, s7g, s7b] = hexToRgbTriplet(accent70);
	const accent40 = blendToHex(accent, "#18181e", 0.4);
	const [s4r, s4g, s4b] = hexToRgbTriplet(accent40);
	const points: RadialPoint[] = [
		{ x: 2, y: 0, r: 255, g: 255, b: 255, falloff: 3 },
		{ x: 10, y: 1, r: ar, g: ag, b: ab, falloff: 4 },
		{ x: 5, y: 3, r: s7r, g: s7g, b: s7b, falloff: 3.5 },
		{ x: 11, y: 5, r: s4r, g: s4g, b: s4b, falloff: 2.5 },
		{ x: 0, y: 4, r: 200, g: 180, b: 140, falloff: 2 },
	];

	const logoRows = LOGO.length;
	const logoCols = LOGO[0].length;
	const gridCols = logoCols + SHADOW_OFFSET_X;
	const gridRows = logoRows + Math.ceil(SHADOW_OFFSET_Y);

	const grid: Array<Array<{ ch: string; rgb?: [number, number, number] }>> = [];
	for (let row = 0; row < gridRows; row++) {
		grid.push(new Array(gridCols).fill(null).map(() => ({ ch: " " })));
	}

	for (let row = 0; row < logoRows; row++) {
		for (let col = 0; col < LOGO[row].length; col++) {
			const ch = LOGO[row][col];
			if (ch === "\u2588") {
				let [r, g, b] = radialColorForCell(col, row, points);
				if (logoAnimating) {
					const charPos = col / Math.max(1, logoCols - 1);
					const dist = charPos - logoFrame;
					const wrapped = dist < -0.5 ? dist + 1 : dist > 0.5 ? dist - 1 : dist;
					const intensity = Math.exp(-(wrapped * wrapped) * 6);
					r = Math.round(r + (255 - r) * intensity);
					g = Math.round(g + (255 - g) * intensity);
					b = Math.round(b + (255 - b) * intensity);
				}
				grid[row][col] = { ch: "\u2588", rgb: [r, g, b] };
			}
		}
	}

	const halfOpacity = SHADOW_OPACITY / 2;
	const placeShadow = (sRow: number, sCol: number, opacity: number): void => {
		if (sRow < 0 || sRow >= gridRows || sCol < 0 || sCol >= gridCols) return;
		const existing = grid[sRow][sCol];
		if (existing.ch !== " ") return;
		const [gr, gg, gb] = radialColorForCell(sCol, sRow, points);
		const bgR = 24, bgG = 24, bgB = 30;
		const sr = Math.round(bgR + (gr - bgR) * opacity);
		const sg = Math.round(bgG + (gg - bgG) * opacity);
		const sb = Math.round(bgB + (gb - bgB) * opacity);
		grid[sRow][sCol] = { ch: SHADOW_GLYPH, rgb: [sr, sg, sb] };
	};

	for (let row = 0; row < logoRows; row++) {
		for (let col = 0; col < LOGO[row].length; col++) {
			const ch = LOGO[row][col];
			if (ch === "\u2588") {
				const sCol = col + SHADOW_OFFSET_X;
				const sRowBase = row + Math.floor(SHADOW_OFFSET_Y);
				placeShadow(sRowBase, sCol, halfOpacity);
				placeShadow(sRowBase + 1, sCol, halfOpacity);
			}
		}
	}

	return grid.map((rowCells) =>
		rowCells.map((cell) => {
			if (cell.rgb) {
				const [r, g, b] = cell.rgb;
				return `\x1b[38;2;${r};${g};${b}m${cell.ch}\x1b[39m`;
			}
			return cell.ch;
		}).join("")
	);
}

let tuiRef: any;

function installStartupHeader(ctx: any): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setHeader((tui: any, theme: any) => {
		tuiRef = tui;
		return {
		render(width: number): string[] {
			// Re-read every render so model/dir/mode changes are reflected.
			const dir = folderNameFromCwd(ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd());
			const model = ctx.model;
			const modelName = model?.name ?? model?.id ?? "no model";

			const accent = getActiveModeColor();
			const logoLines = renderLogoWithGradient(accent);
			const logoWidth = visibleWidth(logoLines[0] ?? "");
			const leftPad = Math.max(0, Math.floor((width - logoWidth) / 2));
			const padStr = " ".repeat(leftPad);

			const infoLine = `${theme.fg("text", modelName)} ${theme.fg("accent", "\u2022")} ${theme.fg("dim", dir)}`;
			const infoPad = Math.max(0, Math.floor((width - visibleWidth(infoLine)) / 2));
			const infoPadStr = " ".repeat(infoPad);

			const lines = [
				...logoLines.map((line) => padStr + line),
				"",
				infoPadStr + infoLine,
			];
			return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
		},
		invalidate() {},
	};
	});
}

function getAgentDir(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return path.join(home, ".pi", "agent");
}

function getThemesDir(): string {
	return path.join(getAgentDir(), "themes");
}

function ensureThemeInstalled(): void {
	const themesDir = getThemesDir();
	fs.mkdirSync(themesDir, { recursive: true });
	const dest = path.join(themesDir, `${THEME_NAME}.json`);
	if (!fs.existsSync(dest)) {
		fs.copyFileSync(THEME_JSON, dest);
		return;
	}
	const srcContent = fs.readFileSync(THEME_JSON, "utf-8");
	const destContent = fs.readFileSync(dest, "utf-8");
	if (srcContent !== destContent) {
		fs.copyFileSync(THEME_JSON, dest);
	}
}

export default function piEmberUiPlugin(pi: ExtensionAPI): void {
	ensureThemeInstalled();
	installThinkingBorderOverride();
	applyDynamicTheme();

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		liveTheme = undefined;
		if (ctx.mode === "tui") {
			requestRender = () => ctx.ui.setStatus("pi-ember-ui-thinking-tick", undefined);
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHiddenThinkingLabel("");
		}
		applyDynamicTheme();
		if (ctx.mode === "tui") {
			installStartupHeader(ctx);
			if (tuiRef?.children) {
				for (const child of tuiRef.children) {
					if (child?.children?.length > 1 && typeof child.addChild === "function" && child !== tuiRef) {
						const nonSpacers = child.children.filter((c: any) => c?.constructor?.name !== "Spacer");
						child.children.length = 0;
						child.children.push(...nonSpacers);
						break;
					}
				}
			}
			startLogoAnimation();
			ctx.ui.onTerminalInput((data: string) => {
				if (logoAnimating && data !== "\t" && !data.startsWith("/")) stopLogoAnimation();
				return undefined;
			});
		}
	});

	// Re-render header when model changes so the name updates live.
	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode === "tui") requestRender?.();
	});

	// Re-render header/footer when the active agent mode changes. Emitted by
	// pi-custom-agents (and any other extension) via the shared event bus.
	pi.events.on("pi-ember-ui:mode-change", () => {
		applyDynamicTheme();
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const ev = event.assistantMessageEvent;
		if (ev && (ev.type === "thinking_start" || ev.type === "thinking_delta")) {
			if (!thinkingActive) startThinkingAnimation();
		}
	});

	pi.on("message_end", () => {
		stopThinkingAnimation();
	});

	pi.on("message_start", () => {
		stopLogoAnimation();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		startWorkingAnimation();
	});

	pi.on("agent_end", () => {
		stopThinkingAnimation();
		stopWorkingAnimation();
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!thinkingActive) startWorkingAnimation();
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (workingActive && !thinkingActive) requestRender?.();
	});

	pi.registerCommand("welcome", {
		description: "Configure the startup welcome header",
		handler: async (args: string, ctx: any) => {
			const normalized = args.trim().toLowerCase();
			if (normalized === "updates on") {
				setWelcomeUpdates(true);
				ctx.ui.notify("Welcome update notices enabled for future sessions", "info");
				return;
			}
			if (normalized === "updates off") {
				setWelcomeUpdates(false);
				ctx.ui.notify("Welcome update notices disabled for future sessions", "info");
				return;
			}
			ctx.ui.notify("Usage: /welcome updates on | /welcome updates off", "info");
		},
	});

	pi.registerEntryRenderer("ember-turn-separator", (_entry, _opts, theme) => {
		return {
			render(width: number): string[] {
				return [theme.fg("accent", "\u2500".repeat(Math.max(0, width)))];
			},
			invalidate() {},
		} as any;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		pi.appendEntry("ember-turn-separator");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = undefined;
		stopLogoAnimation();
		stopThinkingAnimation();
		stopWorkingAnimation();
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
}
