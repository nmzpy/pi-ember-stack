import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	Theme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Markdown,
	Spacer,
	Text,
	type DefaultTextStyle,
	type MarkdownTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	buildCodeBgHex,
	buildThemeBgColors,
	buildThemeFgColors,
	getActiveModeColor,
	getActiveModeId,
	isPlanAutoContinuing,
	isShellMode,
	isToolGroupActive,
	MUTED_COLOR,
	PAGE_BG,
	setLatestSubagentRunning,
	setPlanAutoContinuing,
	setShellMode,
	setThinkingBlocksHidden,
	setToolGroupActive,
} from "./mode-colors.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const THEME_JSON = path.join(SOURCE_ROOT, "ember.json");
const THEME_NAME = "ember";

const LOGO_FRAME_INTERVAL_MS = 100;
const LOGO_ANIMATION_FRAMES = 20;
const MIN_RENDER_INTERVAL_MS = 100;
const THINKING_TICK_MS = 72;
const THINKING_FRAME_STEP = 0.048;
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
let logoAnimating = false;
let logoStatic = false;
let logoFrame = 0;
let logoAnimationFrameCount = 0;
let logoTimer: ReturnType<typeof setInterval> | undefined;
let editorRenderPatched = false;
let assistantMessagePatched = false;
let requestRender: (() => void) | undefined;
let renderCallback: (() => void) | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let renderGeneration = 0;
let lastRenderAt = 0;
let sessionCtx: any;

type EditorWithBorder = Editor & {
	borderColor: (text: string) => string;
	getText: () => string;
};

/**
 * Cached result of the subagent-running scan. The scan itself is O(n)
 * over the session branch (getBranch + two passes), so it MUST NOT run
 * inside the per-frame Editor.prototype.render path. It is recomputed
 * only on subagent tool_execution_start / tool_execution_end events and reset
 * on session replacement. The render path reads this cached flag via
 * subagentRunningCached.
 */
let subagentRunningCached = false;

/**
 * Recompute whether the latest tool call in the session is a `subagent`
 * that has not yet produced a toolResult. Scans session entries
 * (available via module-level sessionCtx) and writes the result to both
 * the shared mode-colors flag and the local cache. Called only from
 * tool-execution event handlers — never from the render path.
 */
function recompute_latest_subagent_running(): boolean {
	const entries = sessionCtx?.sessionManager?.getBranch?.() ?? [];
	let latestSubagentCallId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part?.type === "toolCall" && part?.name === "subagent") {
				latestSubagentCallId = part.id;
				break;
			}
		}
		if (latestSubagentCallId) break;
	}
	let running = false;
	if (latestSubagentCallId) {
		running = true;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (msg?.role === "toolResult" && msg?.toolCallId === latestSubagentCallId) {
				running = false;
				break;
			}
		}
	}
	subagentRunningCached = running;
	setLatestSubagentRunning(running);
	return running;
}

function resetRenderScheduler(): void {
	renderGeneration += 1;
	if (renderTimer !== undefined) clearTimeout(renderTimer);
	renderTimer = undefined;
	renderCallback = undefined;
	lastRenderAt = 0;
}

function scheduleRender(): void {
	if (renderCallback === undefined || renderTimer !== undefined) return;

	const generation = renderGeneration;
	const elapsed = Date.now() - lastRenderAt;
	const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
	renderTimer = setTimeout(() => {
		renderTimer = undefined;
		if (generation !== renderGeneration || renderCallback === undefined) return;
		renderCallback();
		lastRenderAt = Date.now();
	}, delay);
}

let thinkingTimer: ReturnType<typeof setInterval> | undefined;

/** Group-header tick subscribers. The compact renderer registers the
 *  active group owner's invalidate here so the group header gradient
 *  sweeps at the same THINKING_TICK_MS cadence as the Thinking/Working
 *  widget. The tick timer stays alive while any subscriber is active,
 *  even if thinking/working are inactive. */
const groupTickCallbacks = new Set<() => void>();

export function subscribeGroupTick(cb: () => void): void {
	groupTickCallbacks.add(cb);
	startThinkingTick();
}

export function unsubscribeGroupTick(cb: () => void): void {
	groupTickCallbacks.delete(cb);
	maybeStopThinkingTick();
}

function startThinkingTick(): void {
	if (thinkingTimer) return;
	thinkingTimer = setInterval(() => {
		thinkingFrame += THINKING_FRAME_STEP;
		if (thinkingFrame > 1) thinkingFrame -= 1;
		requestRender?.();
		for (const cb of groupTickCallbacks) {
			try { cb(); } catch { /* best effort */ }
		}
	}, THINKING_TICK_MS);
}

function stopThinkingTick(): void {
	if (thinkingTimer) {
		clearInterval(thinkingTimer);
		thinkingTimer = undefined;
	}
}

/** Stop the tick timer only when no animation and no group subscribers
 *  are active. */
function maybeStopThinkingTick(): void {
	if (!thinkingActive && !workingActive && groupTickCallbacks.size === 0) {
		stopThinkingTick();
	}
}

function stopThinkingAnimation(): void {
	thinkingActive = false;
	maybeStopThinkingTick();
	requestRender?.();
}

function startThinkingAnimation(): void {
	if (!thinkingActive && !workingActive) thinkingFrame = 0;
	thinkingActive = true;
	startThinkingTick();
}

function startWorkingAnimation(): void {
	if (!thinkingActive && !workingActive) thinkingFrame = 0;
	workingActive = true;
	startThinkingTick();
}

function stopWorkingAnimation(): void {
	workingActive = false;
	maybeStopThinkingTick();
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

const MARKDOWN_RENDER_CACHE_MAX_ENTRIES = 512;
const MARKDOWN_RENDER_CACHE_MAX_BYTES = 8 * 1024 * 1024;

type MarkdownBlockType = "text" | "thinking";

type MarkdownRenderCacheEntry = {
	lines: string[];
	bytes: number;
};

/**
 * Markdown instances are recreated when Pi rebuilds assistant components. Keep
 * the rendered result shared across those instances so a thinking-toggle does
 * not re-lex every historical block. Width is part of the key because Markdown
 * wrapping is width-dependent; the generation changes whenever the live theme
 * changes so cached ANSI output can never outlive its theme.
 */
const markdownRenderCache = new Map<string, MarkdownRenderCacheEntry>();
let markdownRenderCacheBytes = 0;
let markdownThemeGeneration = 0;

function clearMarkdownRenderCache(): void {
	markdownRenderCache.clear();
	markdownRenderCacheBytes = 0;
}

function getCachedMarkdownLines(key: string): string[] | undefined {
	const entry = markdownRenderCache.get(key);
	if (!entry) return undefined;
	markdownRenderCache.delete(key);
	markdownRenderCache.set(key, entry);
	return entry.lines;
}

function setCachedMarkdownLines(key: string, lines: string[]): void {
	const bytes = key.length + lines.reduce((total, line) => total + line.length, 0);
	if (bytes > MARKDOWN_RENDER_CACHE_MAX_BYTES) return;

	const previous = markdownRenderCache.get(key);
	if (previous) {
		markdownRenderCacheBytes -= previous.bytes;
		markdownRenderCache.delete(key);
	}
	while (
		markdownRenderCache.size >= MARKDOWN_RENDER_CACHE_MAX_ENTRIES ||
		markdownRenderCacheBytes + bytes > MARKDOWN_RENDER_CACHE_MAX_BYTES
	) {
		const oldestKey = markdownRenderCache.keys().next().value;
		if (oldestKey === undefined) break;
		const oldest = markdownRenderCache.get(oldestKey);
		if (oldest) markdownRenderCacheBytes -= oldest.bytes;
		markdownRenderCache.delete(oldestKey);
	}
	markdownRenderCache.set(key, { lines, bytes });
	markdownRenderCacheBytes += bytes;
}

class CachedMarkdown {
	private readonly text: string;
	private readonly paddingX: number;
	private readonly paddingY: number;
	private readonly markdownTheme: MarkdownTheme;
	private readonly defaultTextStyle: DefaultTextStyle | undefined;
	private readonly blockType: MarkdownBlockType;
	private cachedGeneration: number | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		markdownTheme: MarkdownTheme,
		defaultTextStyle: DefaultTextStyle | undefined,
		blockType: MarkdownBlockType,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.markdownTheme = markdownTheme;
		this.defaultTextStyle = defaultTextStyle;
		this.blockType = blockType;
	}

	render(width: number): string[] {
		if (
			this.cachedLines !== undefined &&
			this.cachedGeneration === markdownThemeGeneration &&
			this.cachedWidth === width
		) {
			return this.cachedLines;
		}

		const key = JSON.stringify([
			markdownThemeGeneration,
			this.blockType,
			this.text,
			this.paddingX,
			this.paddingY,
			width,
		]);
		const cached = getCachedMarkdownLines(key);
		if (cached !== undefined) {
			this.cachedGeneration = markdownThemeGeneration;
			this.cachedWidth = width;
			this.cachedLines = cached;
			return cached;
		}

		const markdown = new Markdown(
			this.text,
			this.paddingX,
			this.paddingY,
			this.markdownTheme,
			this.defaultTextStyle,
		);
		const lines = markdown.render(width);
		setCachedMarkdownLines(key, lines);
		this.cachedGeneration = markdownThemeGeneration;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedGeneration = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

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

function applyDynamicTheme(options: { invalidate?: boolean; render?: boolean } = {}): void {
	markdownThemeGeneration += 1;
	clearMarkdownRenderCache();
	const accent = getActiveModeColor();
	const fgColors = buildThemeFgColors(accent);
	const bgColors = buildThemeBgColors(accent);
	const codeBg = buildCodeBgHex(accent);

	if (liveTheme) {
		liveCodeBgAnsi = bgAnsi(codeBg);
		updateLiveThemeColors(fgColors, bgColors);
		if (options.invalidate !== false) (tuiRef as any)?.invalidate();
		if (options.render !== false) requestRender?.();
		return;
	}
	installProxiedTheme(fgColors, bgColors, codeBg);
	if (options.render !== false) requestRender?.();
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

/** Linear interpolation between two RGB triplets. */
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

/** Gradient RGB cache. Invalidated when the theme generation changes so
 *  cached ANSI output can never outlive its theme. O(1) per render call. */
let gradientCacheGeneration = -1;
let gradientAccentCache = new Map<string, [number, number, number]>();
let gradientBgRgb: [number, number, number] | undefined;

function cachedAccentRgb(accentHex: string): [number, number, number] {
	if (gradientCacheGeneration !== markdownThemeGeneration) {
		gradientAccentCache = new Map();
		gradientBgRgb = undefined;
		gradientCacheGeneration = markdownThemeGeneration;
	}
	let rgb = gradientAccentCache.get(accentHex);
	if (!rgb) {
		rgb = hexToRgbTriplet(accentHex);
		gradientAccentCache.set(accentHex, rgb);
	}
	return rgb;
}

function cachedBgRgb(): [number, number, number] {
	if (!gradientBgRgb) {
		gradientBgRgb = hexToRgbTriplet(PAGE_BG);
	}
	return gradientBgRgb;
}

function renderGradientLabel(text: string, accent: string, phaseOffset = 0): string {
	const chars = [...text];
	const len = chars.length;
	if (len === 0) return "";
	const accentRgb = cachedAccentRgb(accent);
	const bgRgb = cachedBgRgb();
	// 3 stops: muted 10% tail, dim 40%, accent peak — all in RGB space.
	const mutedTail = lerpRgb(bgRgb, accentRgb, 0.1);
	const dim = lerpRgb(bgRgb, accentRgb, 0.4);
	const peak = accentRgb;
	const result: string[] = [];
	const phase = (thinkingFrame + phaseOffset) % 1;
	for (let i = 0; i < len; i++) {
		const charPos = i / Math.max(1, len - 1);
		const dist = charPos - phase;
		const wrapped = dist < -0.5 ? dist + 1 : dist > 0.5 ? dist - 1 : dist;
		const intensity = Math.exp(-(wrapped * wrapped) * 8);
		// Piecewise 3-stop blend: muted tail -> dim mid -> accent peak.
		const lower = lerpRgb(mutedTail, dim, Math.min(1, intensity * 2));
		const rgb = lerpRgb(lower, peak, Math.max(0, Math.min(1, (intensity - 0.5) * 2)));
		result.push(`\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${chars[i]}\x1b[39m`);
	}
	return result.join("");
}

/** Render the same animated gradient used by the live Thinking label. */
export function renderLiveThinkingGradient(text: string): string {
	return renderGradientLabel(text, getActiveModeColor());
}

/** Render an animated gradient with a stable per-row phase offset. */
export { renderGradientLabel };

function installThinkingBorderOverride(): void {
	if (editorRenderPatched) return;
	editorRenderPatched = true;
	const originalRender = Editor.prototype.render;
	Editor.prototype.render = function renderThinkingBorder(this: EditorWithBorder, width: number): string[] {
	const accent = getActiveModeColor();
	const accentLight = lightenHex(accent, 0.5);
	const borderColor = isShellMode() ? MUTED_COLOR : accentLight;
	const accentBorder = (text: string): string => colorize(text, borderColor);
	const dimInsetBorder = (): string =>
		` ${colorWithOpacity("\u2500".repeat(Math.max(0, width - 2)), borderColor, 0.1875)} `;
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
	const subagentActive = subagentRunningCached;
	if (subagentActive) {
		lines[topIdx] = dimInsetBorder();
	} else {
		lines[topIdx] = accentBorder("\u2500".repeat(width));
	}
	if (bottomBorderIdx >= 0) {
		const inputText = this.getText?.() ?? "";
		if (inputText.trimStart().startsWith("/")) {
			lines[bottomBorderIdx] = dimInsetBorder();
		} else {
			lines[bottomBorderIdx] = accentBorder("\u2500".repeat(width));
		}
	}
		const lastLineIdx = lines.length - 1;
		if (lastLineIdx > bottomBorderIdx && lastLineIdx > 0) {
			lines[lastLineIdx] = accentBorder("\u2500".repeat(width));
		}
		if (lines.length === 0) return lines;
		return lines;
	};
}

function installAssistantMessagePatch(): void {
	if (assistantMessagePatched) return;
	assistantMessagePatched = true;

	const assistantPrototype = (AssistantMessageComponent as any).prototype;
	const originalSetHideThinkingBlock = assistantPrototype.setHideThinkingBlock;
	if (typeof originalSetHideThinkingBlock === "function") {
		assistantPrototype.setHideThinkingBlock = function (this: any, hide: boolean): void {
			setThinkingBlocksHidden(hide === true);
			originalSetHideThinkingBlock.call(this, hide);
		};
	}

	assistantPrototype.updateContent = function (this: any, message: any): void {
		const hide = this.hideThinkingBlock;
		setThinkingBlocksHidden(hide === true);
		const outputPad = this.outputPad;
		// Skip the full rebuild when nothing that affects the rendered output
		// has changed. invalidate() (from theme change, thinking toggle,
		// output-pad change) calls updateContent with the SAME message —
		// recreating every Markdown child and clearing contentContainer is
		// O(blocks) per assistant message per rebuild, which freezes long
		// transcripts on thinking-toggle. The child Markdown caches were
		// already cleared by the invalidate() propagation, so the next
		// render() will re-parse regardless — but we avoid the object
		// churn and container rebuild.
		const sameMessage = this._emberContentMessage === message;
		const cacheKey = `${sameMessage ? "same" : "diff"}|${hide}|${outputPad}`;
		if (sameMessage && this._emberContentKey === cacheKey) {
			this.lastMessage = message;
			return;
		}
		this._emberContentKey = cacheKey;
		this._emberContentMessage = message;
		this.lastMessage = message;

		this.contentContainer.clear();

		const isVisibleBlock = (c: any): boolean => {
			if (c.type === "text" && c.text?.trim()) return true;
			if (c.type === "thinking" && c.thinking?.trim() && !hide) return true;
			return false;
		};

		const hasVisibleContent = message.content.some(isVisibleBlock);
		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		const theme = liveTheme ?? (globalThis as any)[THEME_KEY];

		// Override the heading function so that when a heading contains a
		// colon, only the portion before (and including) the colon is
		// accent-colored — the remainder reverts to plain text. This makes
		// headings like "### Module 3: Implementation" render with
		// "Module 3:" in accent and " Implementation" in plain text.
		if (!this._emberMarkdownTheme || this._emberMarkdownThemeBase !== this.markdownTheme) {
			const base = this.markdownTheme;
			this._emberMarkdownThemeBase = base;
			this._emberMarkdownTheme = {
				...base,
				heading: (text: string) => emberHeadingStyle(text, theme),
			};
		}
		const mdTheme = this._emberMarkdownTheme;

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text?.trim()) {
				this.contentContainer.addChild(
					new CachedMarkdown(
						content.text.trim(),
						this.outputPad,
						0,
						mdTheme,
						undefined,
						"text",
					),
				);
			} else if (content.type === "thinking" && content.thinking?.trim()) {
				if (hide) continue;
				const hasVisibleContentAfter = message.content.slice(i + 1).some(isVisibleBlock);
				this.contentContainer.addChild(
					new CachedMarkdown(
						content.thinking.trim(),
						this.outputPad,
						0,
						mdTheme,
						{
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						},
						"thinking",
					),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		const hasToolCalls = message.content.some((c: any) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		// Suppress the output-limit error when plan-mode auto-continue is
		// active — the extension silently sends "continue" so the user never
		// sees this error or the recovery message.
		const suppressLengthError =
			message.stopReason === "length" &&
			getActiveModeId() === "plan" &&
			isPlanAutoContinuing();
		if (message.stopReason === "length" && !suppressLengthError) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
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

const ANSI_STRIP = /\x1b\[[0-9;]*m/g;

/**
 * Split an ANSI-laden string at the first visible occurrence of `sep`,
 * returning the two halves with their ANSI codes intact.
 * Returns `[full, ""]` when the separator is not found.
 */
function splitAtVisibleChar(text: string, sep: string): [string, string] {
	let visiblePos = 0;
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			// Skip the full escape sequence
			const m = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
			if (m) {
				i += m[0].length;
				continue;
			}
		}
		if (text[i] === sep) {
			// Include the separator in the prefix
			const prefix = text.slice(0, i + 1);
			const suffix = text.slice(i + 1);
			return [prefix, suffix];
		}
		visiblePos++;
		i++;
	}
	return [text, ""];
}

/**
 * Custom markdown heading style: when the heading text contains a colon,
 * only the portion up to and including the first colon is accent-colored;
 * the remainder reverts to plain text color. When there is no colon the
 * entire heading is accent-colored (the default behavior).
 *
 * The input `text` may already carry ANSI codes (bold, underline) applied
 * by the markdown renderer before calling `heading()`. We strip ANSI to
 * detect the colon, split at that visible position, then re-apply colors.
 */
function emberHeadingStyle(text: string, theme: any): string {
	const visible = text.replace(ANSI_STRIP, "");
	// Hide the leading hash prefix ("### ", "## ", etc.) that pi-tui's
	// markdown renderer prepends for h3+ headings. The heading text
	// itself is rendered as a separate call, so suppressing the prefix
	// here removes the raw hashes from the rendered row.
	if (/^#+\s*$/.test(visible)) {
		return "";
	}
	const colonIdx = visible.indexOf(":");
	if (colonIdx < 0) {
		return theme.fg("mdHeading", text);
	}
	const [prefix, suffix] = splitAtVisibleChar(text, ":");
	// prefix includes the colon; suffix is the rest (may start with a space).
	// Re-color: accent for prefix, plain text for suffix. We strip any
	// existing foreground ANSI from each part first to avoid color stacking.
	const prefixStripped = prefix.replace(ANSI_STRIP, "");
	const suffixStripped = suffix.replace(ANSI_STRIP, "");
	// Preserve bold/underline from the original by re-applying via theme.
	// The markdown renderer wraps h1 as bold+underline, h2+ as bold.
	// We re-apply bold to both parts; underline only if it was in the original.
	const hasUnderline = text.includes("\x1b[4m") || text.includes("\x1b[1;4m") || text.includes("\x1b[4;1m");
	const stylePrefix = (s: string): string => {
		let styled = theme.bold(s);
		if (hasUnderline) styled = theme.underline(styled);
		return styled;
	};
	return theme.fg("mdHeading", stylePrefix(prefixStripped)) + theme.fg("text", stylePrefix(suffixStripped));
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
	logoStatic = false;
	logoFrame = 0;
	logoAnimationFrameCount = 0;
	logoTimer = setInterval(() => {
		logoFrame += 0.04;
		if (logoFrame > 1) logoFrame -= 1;
		logoAnimationFrameCount += 1;
		requestRender?.();
		if (logoAnimationFrameCount >= LOGO_ANIMATION_FRAMES) stopLogoAnimation();
	}, LOGO_FRAME_INTERVAL_MS);
}

function stopLogoAnimation(): void {
	logoAnimating = false;
	logoStatic = true;
	logoAnimationFrameCount = 0;
	if (logoTimer) {
		clearInterval(logoTimer);
		logoTimer = undefined;
	}
	requestRender?.();
}

function renderLogoWithGradient(accent: string): string[] {
	const logoRows = LOGO.length;
	const logoCols = LOGO[0].length;
	const gridCols = logoCols + SHADOW_OFFSET_X;
	const gridRows = logoRows + Math.ceil(SHADOW_OFFSET_Y);

	// Static state: 2-stop vertical gradient (top = muted #808080, bottom =
	// text #d4d4d4). No radial points, no per-frame sweep.
	if (!logoAnimating && logoStatic) {
		const mutedRgb = hexToRgbTriplet(MUTED_COLOR);
		const textRgb = hexToRgbTriplet("#d4d4d4");
		const grid: Array<Array<{ ch: string; rgb?: [number, number, number] }>> = [];
		for (let row = 0; row < gridRows; row++) {
			grid.push(new Array(gridCols).fill(null).map(() => ({ ch: " " })));
		}
		for (let row = 0; row < logoRows; row++) {
			const t = logoRows > 1 ? row / (logoRows - 1) : 0;
			const rgb = lerpRgb(mutedRgb, textRgb, t);
			for (let col = 0; col < LOGO[row].length; col++) {
				if (LOGO[row][col] === "\u2588") {
					grid[row][col] = { ch: "\u2588", rgb };
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

/**
 * Install the Thinking/Working widget one row above the editor. The widget
 * renders the live animated gradient label while the agent is reasoning or
 * executing tools, and hides itself (returns []) when a compact tool group
 * (Exploring or Working) is active — the group header carries the gradient
 * in that case, so the two never compete for the same visual slot.
 */
function installThinkingWidget(ctx: any): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget("ember-thinking", (_tui: any, _theme: any) => ({
		render(_width: number): string[] {
			if (isToolGroupActive()) return [];
			if (!thinkingActive && !workingActive) return [];
			const labelText = thinkingActive ? "Thinking" : "Working";
			return [renderGradientLabel(labelText, getActiveModeColor())];
		},
		invalidate() {},
	}));
}

export default function piEmberUiPlugin(pi: ExtensionAPI): void {
	ensureThemeInstalled();
	installThinkingBorderOverride();
	installAssistantMessagePatch();
	applyDynamicTheme();

	pi.on("session_start", (event, ctx) => {
		resetRenderScheduler();
		sessionCtx = ctx;
		tuiRef = undefined;
		requestRender = undefined;
		liveTheme = undefined;
		subagentRunningCached = false;
		if (ctx.mode === "tui") {
			renderCallback = () => {
				if (tuiRef?.requestRender) {
					tuiRef.requestRender();
					return;
				}
				ctx.ui.setStatus("pi-ember-ui-thinking-tick", undefined);
			};
			requestRender = scheduleRender;
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHiddenThinkingLabel("");
			installThinkingWidget(ctx);
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
			// Only animate the logo on genuinely fresh sessions where the
			// header is visible. On /resume, /fork, and /reload the header
			// is scrolled off-screen (or it is a hot reload); even the
			// bounded logo timer would otherwise add needless full renders.
			if (event.reason === "startup" || event.reason === "new") {
				startLogoAnimation();
			}
		}
	});

	// Re-render header when model changes so the name updates live.
	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode === "tui") requestRender?.();
	});

	// Re-render header/footer when the active agent mode changes. Emitted by
	// pi-custom-agents (and any other extension) via the shared event bus.
	pi.events.on("pi-ember-ui:mode-change", (event: any) => {
		if (event?.liveOnly === true) {
			// Mode switches update the live editor/footer only. Invalidating the
			// whole TUI makes a large resumed transcript re-render synchronously.
			// The custom-agents extension supplies the single live render tick.
			applyDynamicTheme({ invalidate: false, render: false });
			return;
		}
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

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopLogoAnimation();
		startWorkingAnimation();
	});

	pi.on("agent_end", () => {
		stopThinkingAnimation();
		stopWorkingAnimation();
		// When the agent loop ends (including after abort/cancel/error), no
		// subagent can still be running. Reset the flag so the editor border
		// reverts from the dim inset to the full-opacity accent line.
		subagentRunningCached = false;
		setLatestSubagentRunning(false);
		requestRender?.();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.toolName === "subagent") recompute_latest_subagent_running();
		if (!thinkingActive) startWorkingAnimation();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.toolName === "subagent") {
			recompute_latest_subagent_running();
			// Always request a render after a subagent finishes so the editor
			// border updates from dim-inset back to the accent line.
			requestRender?.();
			return;
		}
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

	// Reset ALL session-bound module state on shutdown so a subsequent
	// /resume (which re-runs the factory against a fresh runtime but keeps
	// the cached module) does not call into the dead session's TUI/ctx via
	// stale closures. The factory body calls applyDynamicTheme() on load,
	// which would otherwise invoke the old requestRender/tuiRef.
	pi.on("session_shutdown", (_event, ctx) => {
		resetRenderScheduler();
		sessionCtx = undefined;
		requestRender = undefined;
		tuiRef = undefined;
		liveTheme = undefined;
		liveCodeBgAnsi = "";
		markdownThemeGeneration = 0;
		clearMarkdownRenderCache();
		subagentRunningCached = false;
		groupTickCallbacks.clear();
		stopLogoAnimation();
		stopThinkingTick();
		stopThinkingAnimation();
		stopWorkingAnimation();
		setShellMode(false);
		setLatestSubagentRunning(false);
		setThinkingBlocksHidden(false);
		setToolGroupActive(false);
		setPlanAutoContinuing(false);
		if (ctx.hasUI) {
			ctx.ui.setWidget("ember-thinking", undefined);
			ctx.ui.setHeader(undefined);
		}
	});
}
