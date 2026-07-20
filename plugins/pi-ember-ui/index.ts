import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CompactionSummaryMessageComponent,
	DynamicBorder,
	InteractiveMode,
	Theme,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Editor,
	getCapabilities,
	hyperlink,
	Markdown,
	Spacer,
	Text,
	type DefaultTextStyle,
	type MarkdownTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	DIM_COLOR,
	MUTED_MESSAGE_BG,
	buildThemeBgColors,
	buildThemeExportColors,
	buildThemeFgColors,
	getActiveModeColor,
	isQuizActive,
	isShellMode,
	isLatestSubagentRunning,
	MUTED_COLOR,
	PAGE_BG,
	setLatestSubagentRunning,
	setPlanAutoContinuing,
	setShellMode,
	setThinkingBlocksHidden,
	setToolGroupActive,
	TEXT_COLOR,
} from "./mode-colors.ts";
import {
	activate_gradient,
	clamp_lerp,
	deactivate_gradient,
	EDGE_PADDING,
	gaussian_intensity,
	get_gradient_phase,
	get_gradient_phase_with_offset,
	get_logo_phase,
	GRADIENT_SIGMA,
	type GradientPreset,
	MUTED_GROUP_GRADIENT_PRESET,
	invalidate_gradient_cache,
	render_gradient,
	set_gradient_render_request,
	shutdown_gradient_clock,
} from "./gradient.ts";
import {
	bind_slash_command_exit_render,
	disable_tui_clear_on_shrink,
	ensure_chatbox_leading_spacer,
	reset_slash_command_tracking,
	snap_tui_to_bottom,
} from "./layout.ts";
import {
	bind_model_picker_session,
	install_model_picker_patches,
	reset_model_picker_session,
} from "./model-picker.ts";

export { pick_model_in_editor as pickModelInEditor } from "./model-picker.ts";
export { cancel_pending_model_pick as cancelPendingModelPick } from "./model-picker.ts";
export { wrap_model_picker_editor as wrapModelPickerEditor } from "./model-picker.ts";
export {
	finalize_editor_input_after as finalizeEditorInputAfter,
	reset_slash_command_tracking as resetSlashCommandTracking,
	snap_tui_to_bottom as snapTuiToBottom,
	sync_slash_command_active as syncSlashCommandActive,
} from "./layout.ts";
export {
	intercept_shell_input as interceptShellInput,
	process_shell_input as processShellInput,
	sync_shell_mode_from_editor_text as syncShellModeFromEditorText,
	set_shell_sync_callback as setShellSyncCallback,
	install_shell_history_sync_patch as installShellHistorySyncPatch,
	type ShellModeEditor,
} from "./shell-mode.ts";
export {
	cancel_footer_stats_schedule as cancelFooterStatsSchedule,
	get_baked_thinking_variant as getBakedThinkingVariant,
	init_footer_thinking_level as initFooterThinkingLevel,
	installEmberFooter,
	model_name_has_thinking_variant as modelNameHasThinkingVariant,
	recompute_footer_stats as recomputeFooterStats,
	refresh_footer as refreshFooter,
	reset_footer_state as resetFooterState,
	schedule_footer_stats as scheduleFooterStats,
	set_footer_thinking_level as setFooterThinkingLevel,
	set_mode_label_resolver as setModeLabelResolver,
} from "./footer.ts";
import { notify_theme_refresh } from "./theme-refresh.ts";
import {
	cancel_footer_stats_schedule,
	init_footer_thinking_level,
	installEmberFooter,
	recompute_footer_stats,
	refresh_footer,
	reset_footer_state,
	schedule_footer_stats,
	set_footer_thinking_level,
} from "./footer.ts";
import {
	process_shell_input as processShellInput,
	sync_shell_mode_from_editor_text as syncShellModeFromEditorText,
	set_shell_sync_callback as setShellSyncCallback,
	install_shell_history_sync_patch as installShellHistorySyncPatch,
	type ShellModeEditor,
} from "./shell-mode.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const THEME_JSON = path.join(SOURCE_ROOT, "ember.json");
const THEME_NAME = "ember";

const MIN_RENDER_INTERVAL_MS = 50;
const LOGO = [
	"  ██████   ██",
	"  ██   ██  ██",
	"  ██████   ██",
	"  ██       ██",
	"  ██       ██",
	"  ██       ██",
];

const SHADOW_OFFSET_X = 1;
const SHADOW_OFFSET_Y = 1;
const SHADOW_OPACITY = 0.25;

type GridCell = { ch: string; rgb?: [number, number, number] };
type Grid = GridCell[][];

const BOX_SHADOW_GLYPHS: readonly string[] = [
	" ",
	"\u2500",
	"\u2500",
	"\u2500",
	"\u2502",
	"\u2510",
	"\u250c",
	"\u252c",
	"\u2502",
	"\u2518",
	"\u2514",
	"\u2534",
	"\u2502",
	"\u2524",
	"\u251c",
	"\u253c",
];

function gridToLines(grid: Grid): string[] {
	return grid.map((rowCells) =>
		rowCells
			.map((cell) => {
				if (cell.rgb) {
					const [r, g, b] = cell.rgb;
					return `\x1b[38;2;${r};${g};${b}m${cell.ch}\x1b[39m`;
				}
				return cell.ch;
			})
			.join(""),
	);
}

function placeBoxShadow(
	grid: Grid,
	gridRows: number,
	gridCols: number,
	colorForRow: (row: number) => [number, number, number],
): void {
	const connections = Array.from({ length: gridRows }, () => new Array<number>(gridCols).fill(0));
	const isLogoCell = (row: number, col: number): boolean => LOGO[row]?.[col] === "\u2588";
	const addConnections = (row: number, col: number, bits: number): void => {
		if (row < 0 || row >= gridRows || col < 0 || col >= gridCols) return;
		connections[row][col] |= bits;
	};

	// Store edge endpoints, not whole line cells, so concave logo corners join
	// cleanly rather than rendering as crossed vertical and horizontal strokes.
	for (let row = 0; row < LOGO.length; row++) {
		for (let col = 0; col < LOGO[row].length; col++) {
			if (!isLogoCell(row, col)) continue;
			const rightExposed = !isLogoCell(row, col + 1);
			const bottomExposed = !isLogoCell(row + 1, col);
			if (rightExposed) {
				addConnections(row, col + SHADOW_OFFSET_X, 4);
				addConnections(row + SHADOW_OFFSET_Y, col + SHADOW_OFFSET_X, 8);
			}
			if (bottomExposed) {
				const bottomRow = row + SHADOW_OFFSET_Y;
				addConnections(bottomRow, col, isLogoCell(row, col - 1) ? 2 : 10);
				addConnections(row + SHADOW_OFFSET_Y, col + 1, 1);
			}
		}
	}

	const [bgR, bgG, bgB] = hexToRgbTriplet(PAGE_BG);
	for (let row = 0; row < gridRows; row++) {
		for (let col = 0; col < gridCols; col++) {
			if (connections[row][col] === 0 || grid[row][col].ch !== " ") continue;
			const [cr, cg, cb] = colorForRow(row);
			const sr = Math.round(bgR + (cr - bgR) * SHADOW_OPACITY);
			const sg = Math.round(bgG + (cg - bgG) * SHADOW_OPACITY);
			const sb = Math.round(bgB + (cb - bgB) * SHADOW_OPACITY);
			grid[row][col] = { ch: BOX_SHADOW_GLYPHS[connections[row][col]], rgb: [sr, sg, sb] };
		}
	}
}

let thinkingActive = false;
let workingActive = false;
/** Whether the agent loop is still running across retries/compactions/
 *  queued follow-ups. `agent_end` fires between each low-level run, but
 *  Pi may auto-retry, auto-compact and retry, or continue with queued
 *  follow-ups afterwards — only `agent_settled` means Pi will not run
 *  again automatically. This flag keeps the Thinking/Working widget
 *  visible during those inter-run gaps so the header state is never
 *  lost while the agent is still working on the user's task. Cleared on
 *  `agent_settled` and `session_shutdown` (the safety floor). */
let agentRunPending = false;
/** Whether context compaction (manual, threshold, or overflow recovery)
 *  is in progress. When true the Thinking widget displays `Summarizing`
 *  with the Thinking accent gradient and hides Thinking/Working labels.
 *  Cleared on compaction_end and `session_shutdown`. */
let summarizingActive = false;
let logoAnimating = false;
let logoStatic = false;
const EMBER_PATCH_MARKER = Symbol.for("pi-ember-ui:patched");

let userPromptAt = 0;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

const CURSOR_BLINK_INTERVAL_MS = 500;
let cursorVisible = true;
let cursorBlinkTimer: ReturnType<typeof setInterval> | undefined;

function startCursorBlink(): void {
	if (cursorBlinkTimer !== undefined) return;
	cursorVisible = true;
	cursorBlinkTimer = setInterval(() => {
		cursorVisible = !cursorVisible;
		requestRender?.();
	}, CURSOR_BLINK_INTERVAL_MS);
}

function stopCursorBlink(): void {
	if (cursorBlinkTimer !== undefined) {
		clearInterval(cursorBlinkTimer);
		cursorBlinkTimer = undefined;
	}
	cursorVisible = true;
}
let requestRender: ((force?: boolean) => void) | undefined;
let renderCallback: ((force?: boolean) => void) | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let renderGeneration = 0;
let lastRenderAt = 0;
let forceRenderPending = false;
let sessionCtx: any;
let shellInputUnsubscribe: (() => void) | undefined;
let getShellEditor: (() => ShellModeEditor | undefined) | undefined;

type EditorWithBorder = Editor & {
	borderColor: (text: string) => string;
	getText: () => string;
};

export type { EditorWithBorder };

/**
 * Recompute whether the latest tool call in the session is a `subagent`
 * that has not yet produced a toolResult. Scans session entries
 * (available via module-level sessionCtx) and writes the result to the
 * shared mode-colors flag. Called only from tool-execution event
 * handlers — never from the render path.
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
	setLatestSubagentRunning(running);
	return running;
}

function resetRenderScheduler(): void {
	renderGeneration += 1;
	if (renderTimer !== undefined) clearTimeout(renderTimer);
	renderTimer = undefined;
	renderCallback = undefined;
	lastRenderAt = 0;
	forceRenderPending = false;
}

function scheduleRender(force = false): void {
	if (force) {
		forceRenderPending = true;
		if (renderCallback === undefined) return;
		// Match Pi's requestRender(true): run immediately so a normal
		// post-handleInput differential render cannot win with stale rows.
		if (renderTimer !== undefined) {
			clearTimeout(renderTimer);
			renderTimer = undefined;
		}
		const generation = renderGeneration;
		const shouldForce = forceRenderPending;
		forceRenderPending = false;
		if (generation !== renderGeneration || renderCallback === undefined) return;
		renderCallback(shouldForce);
		lastRenderAt = Date.now();
		return;
	}

	if (renderCallback === undefined || renderTimer !== undefined) return;

	const generation = renderGeneration;
	const elapsed = Date.now() - lastRenderAt;
	const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
	renderTimer = setTimeout(() => {
		renderTimer = undefined;
		if (generation !== renderGeneration || renderCallback === undefined) return;
		const shouldForce = forceRenderPending;
		forceRenderPending = false;
		renderCallback(shouldForce);
		lastRenderAt = Date.now();
	}, delay);
}

/** Live-gradient tick subscribers are managed by gradient.ts.
 *  Re-export subscribe/unsubscribe so existing consumers
 *  (pi-compact-tools, subagent renderer) keep working without import changes. */
export { subscribe_gradient_tick as subscribeGradientTick } from "./gradient.ts";
export { unsubscribe_gradient_tick as unsubscribeGradientTick } from "./gradient.ts";
export { MUTED_GROUP_GRADIENT_PRESET } from "./gradient.ts";

/**
 * Request a TUI re-render from outside this plugin. Normal requests are
 * throttled (MIN_RENDER_INTERVAL_MS); forced requests run immediately and
 * clear Pi's differential-render buffer. Safe to call from editor handleInput —
 * it never
 * iterates session entries or does synchronous fs.
 */
export function requestTuiRender(force = false): void {
	requestRender?.(force);
}

/**
 * Request a render starting from a live editor instance. Use this when the
 * editor is known (e.g. inside a handleInput wrapper) and module-level
 * requestRender might be stale due to jiti module duplication. Falls back to
 * the module-level scheduler if the editor has no live TUI.
 */
export function requestTuiRenderFromEditor(
	editor: { tui?: { requestRender?: (force?: boolean) => void } },
	force = false,
): void {
	if (editor?.tui?.requestRender) {
		editor.tui.requestRender(force);
		return;
	}
	requestRender?.(force);
}

/** Request a non-forced render of the live editor and refresh the footer so
 *  shell-mode visual indicators (prompt glyph, border, footer left stats)
 *  update together. Use the captured session ctx when available.
 */
export function requestShellModeVisualRefresh(
	editor: { tui?: { requestRender?: (force?: boolean) => void } },
	ctx?: any,
): void {
	requestTuiRenderFromEditor(editor, false);
	if (ctx?.mode === "tui") {
		refresh_footer(ctx);
	}
}

/**
 * Apply the shell-aware straight-rule chatbox render wrap to a concrete
 * Editor instance. Needed in addition to the prototype patch because Pi's
 * loader can load `@earendil-works/pi-tui` from a different copy than the
 * extension, so prototype-only decoration may miss the live Editor class.
 */
export function wrapEditorRenderForShell(editor: EditorWithBorder): void {
	const marker = Symbol.for("pi-ember-ui:shell-render-wrapped");
	if ((editor as any)[marker]) return;
	(editor as any)[marker] = true;
	const originalRender = editor.render.bind(editor);
	editor.render = function shellAwareRender(width: number): string[] {
		return render_shell_aware_editor(editor, originalRender, width);
	};
}

/**
 * Pin the chatbox to the bottom of the viewport while preserving terminal
 * scrollback. This is the scrollback-safe replacement for
 * `requestTuiRender(true)`: it clears only the visible screen (`2J`, never
 * `3J`), resets Pi's differential bookkeeping, and requests a normal render
 * whose first-render path re-anchors `previousViewportTop` to the bottom.
 *
 * Use this for any snap that must re-pin the viewport after a line-count
 * shrink (compact-group collapse, thinking-toggle rebuild). Never call
 * `requestTuiRender(true)` from render/lifecycle paths — it emits `3J` and
 * destroys scrollback.
 *
 * Returns true when the snap was applied. Returns false when no live TUI is
 * bound (e.g. pre-`session_start` or post-`session_shutdown`); callers MUST
 * NOT fall back to `requestTuiRender(true)` on a false return — a missing
 * TUI means we are outside a live TUI session where a snap is meaningless.
 */
export function requestTuiRenderSnapToBottom(): boolean {
	return snap_tui_to_bottom(tuiRef);
}

/** Install a TUI-level input listener that intercepts shell-mode `!` before
 *  the focused editor sees it. This is more reliable than the per-instance
 *  handleInput wrap because Pi may replace or unwrap the focused editor,
 *  while `tui.addInputListener` persists for the TUI session.
 */
function installShellModeInputListener(ctx: any): void {
	const tui = tuiRef ?? ctx?.ui;
	if (!tui?.addInputListener) return;
	if (shellInputUnsubscribe) {
		shellInputUnsubscribe();
		shellInputUnsubscribe = undefined;
	}

	getShellEditor = (): ShellModeEditor | undefined => {
		const focused = tui.focusedComponent as any;
		if (!focused) return undefined;
		// Only wrap actual editor instances. Custom UI components (e.g. the
		// quiz overlay) sit in the editor container while focused but are
		// not Editors; wrapping their render with the shell-aware Editor transform
		// corrupts their cached output and can overdraw the terminal width.
		if (typeof focused.getText !== "function" || typeof focused.setText !== "function") {
			return undefined;
		}
		wrapEditorRenderForShell(focused);
		return focused as ShellModeEditor;
	};

	shellInputUnsubscribe = tui.addInputListener((data: string) => {
		const editor = getShellEditor?.();
		if (!editor) return undefined;

		// Ignore shell mode while an overlay is visible (quiz,
		// model picker, etc.) because the editor does not have input focus.
		if (tui.hasOverlay?.()) return undefined;

		const result = processShellInput(data, editor);
		if (result?.consume) {
			requestShellModeVisualRefresh(editor, ctx);
			return result;
		}

		return result;
	});
}

function stopThinkingAnimation(): void {
	thinkingActive = false;
	deactivate_gradient("thinking");
	requestRender?.();
}

function startThinkingAnimation(): void {
	thinkingActive = true;
	activate_gradient("thinking");
	if (tuiRef) ensure_chatbox_leading_spacer(tuiRef);
}

function startWorkingAnimation(): void {
	workingActive = true;
	activate_gradient("working");
	if (tuiRef) ensure_chatbox_leading_spacer(tuiRef);
}

function stopWorkingAnimation(): void {
	workingActive = false;
	deactivate_gradient("working");
	requestRender?.();
}

function startSummarizingAnimation(): void {
	summarizingActive = true;
	activate_gradient("summarizing");
	if (tuiRef) ensure_chatbox_leading_spacer(tuiRef);
}

function stopSummarizingAnimation(): void {
	summarizingActive = false;
	deactivate_gradient("summarizing");
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
							" " +
							text +
							" " +
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

/** Pi's theme file watcher reloads ember.json 100ms after any disk write
 *  (ensureThemeInstalled / updateInstalledThemeExport). That reload goes
 *  through createTheme(), which only knows the built-in ThemeBg keys and
 *  drops our custom subagentBg — then theme.bg("subagentBg") crashes.
 *  Re-assert our live Theme (which carries subagentBg in bgColors) onto
 *  the global slots after every apply, and again after the watcher debounce. */
let themeReassertTimer: ReturnType<typeof setTimeout> | undefined;
const THEME_REASSERT_MS = 150;

function reassertLiveTheme(): void {
	if (!liveTheme) return;
	const wrapped = wrapThemeWithCodeBg(liveTheme);
	(globalThis as any)[THEME_KEY] = wrapped;
	(globalThis as any)[THEME_KEY_OLD] = wrapped;
}

function scheduleThemeReassert(): void {
	if (themeReassertTimer !== undefined) clearTimeout(themeReassertTimer);
	themeReassertTimer = setTimeout(() => {
		themeReassertTimer = undefined;
		reassertLiveTheme();
	}, THEME_REASSERT_MS);
}

function installProxiedTheme(
	fgColors: Record<string, string>,
	bgColors: Record<string, string>,
	codeBg: string,
): void {
	const base = new Theme(fgColors as any, bgColors as any, "truecolor", { name: "ember" });
	liveTheme = base;
	liveCodeBgAnsi = bgAnsi(codeBg);
	reassertLiveTheme();
}

function applyDynamicTheme(options: { invalidate?: boolean; render?: boolean } = {}): void {
	markdownThemeGeneration += 1;
	clearMarkdownRenderCache();
	invalidate_gradient_cache();
	const accent = getActiveModeColor();
	const fgColors = buildThemeFgColors(accent);
	const bgColors = buildThemeBgColors(accent);
	const codeBg = MUTED_MESSAGE_BG;
	// Export colors for HTML export are written once at install
	// (ensureThemeInstalled + updateInstalledThemeExport) — never mid-session.
	// Writing ember.json while Pi's theme watcher is active reloads a Theme
	// via createTheme() that drops custom bg keys (subagentBg) and crashes.

	if (liveTheme) {
		liveCodeBgAnsi = bgAnsi(codeBg);
		updateLiveThemeColors(fgColors, bgColors);
		notify_theme_refresh(liveTheme);
		// ensureThemeInstalled may have just written the file; re-assert
		// our live Theme (with subagentBg) now and after the watcher debounce.
		reassertLiveTheme();
		scheduleThemeReassert();
		if (options.invalidate !== false) (tuiRef as any)?.invalidate();
		if (options.render !== false) requestRender?.();
		return;
	}
	installProxiedTheme(fgColors, bgColors, codeBg);
	if (liveTheme) notify_theme_refresh(liveTheme);
	scheduleThemeReassert();
	if (options.render !== false) requestRender?.();
}

function updateLiveThemeColors(
	fgColors: Record<string, string>,
	bgColors: Record<string, string>,
): void {
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

/**
 * Render a live animated gradient using the shared clock phase and the
 * canonical gradient engine. Thinking/Working use the accent palette;
 * MUTED_GROUP_GRADIENT_PRESET (compact group headers, running subagents)
 * uses the muted→text palette.
 */
export function renderLiveGradient(
	text: string,
	preset: GradientPreset,
	phaseOffsetMs: number = 0,
): string {
	return render_gradient(text, preset, get_gradient_phase_with_offset(phaseOffsetMs));
}

/** Compatibility wrapper: render the Thinking-style accent gradient.
 *  Subagent renderer calls this for running agent labels. */
export function renderLiveThinkingGradient(text: string): string {
	return render_gradient(text, MUTED_GROUP_GRADIENT_PRESET, get_gradient_phase());
}

/** Compatibility wrapper: render the muted→text gradient for compact
 *  tool group headers. */
export function renderMutedGradientLabel(text: string): string {
	return render_gradient(text, MUTED_GROUP_GRADIENT_PRESET, get_gradient_phase());
}

/** Compatibility wrapper: render an accent gradient with an optional
 *  phase offset. Used by callers that pass an explicit accent color. */
export function renderGradientLabel(text: string, _accent?: string, _phaseOffset?: number): string {
	return render_gradient(text, "thinking", get_gradient_phase());
}

function installThinkingBorderOverride(): void {
	const proto = Editor.prototype as any;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;
	const originalRender = proto.render;
	const wrapMarker = Symbol.for("pi-ember-ui:shell-render-wrapped");
	proto.render = function renderThinkingBorder(this: EditorWithBorder, width: number): string[] {
		// If the instance was already wrapped by wrapEditorRenderForShell(),
		// do not re-apply the shell-aware border/prompt transformation or the
		// prompt glyph and gutter will render twice.
		if ((this as any)[wrapMarker]) return originalRender.call(this, width);
		return render_shell_aware_editor(this, originalRender, width);
	};
}

/**
 * Render an Editor instance with shell-mode prompt/border styling.
 * Extracted from `installThinkingBorderOverride` so it can also be applied
 * per-instance, which is necessary when `@earendil-works/pi-tui` is loaded
 * from multiple module copies and prototype patching only lands on one.
 */
function render_shell_aware_editor(
	instance: EditorWithBorder,
	originalRender: (width: number) => string[],
	width: number,
): string[] {
	const borderColor =
		isShellMode() || workingActive || agentRunPending || summarizingActive
			? MUTED_COLOR
			: TEXT_COLOR;
	const border = (text: string): string => colorize(text, borderColor);
	const dimBorder = (text: string): string => colorize(text, DIM_COLOR);
	const INSET = 0;
	const INNER_PAD = 1;
	const SLASH_MIDDLE_INSET = 1;
	const innerWidth = Math.max(1, width - INSET * 2 - 2 - INNER_PAD * 2);
	const originalBorderColor = instance.borderColor;
	instance.borderColor = border;
	const lines = originalRender.call(instance, innerWidth);
	instance.borderColor = originalBorderColor;

	if (!cursorVisible) {
		for (let i = 0; i < lines.length; i++) {
			lines[i] = lines[i].replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/g, (_m: string, p1: string) => p1);
		}
	}

	const stripped = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
	const isBorderLine = (s: string): boolean => {
		const raw = stripped(s);
		return (
			raw.length > 0 &&
			[...raw].some((ch) => ch === "\u2500") &&
			[...raw].every((ch) => ch === "\u2500" || ch === " ")
		);
	};
	const borderIndices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (isBorderLine(lines[i])) borderIndices.push(i);
	}
	const topIdx = borderIndices[0] ?? 0;
	const bottomBorderIdx = borderIndices.length > 1 ? borderIndices[borderIndices.length - 1] : -1;
	const isSlashMode = instance.getText?.().trimStart().startsWith("/") === true;
	const hasAutocompleteRows = bottomBorderIdx >= 0 && lines.length > bottomBorderIdx + 1;
	// Slash autocomplete menu expands downward from the chatbox. The
	// autocomplete rows stay after the editor body, so the menu grows below.
	const middleBorderIdx = -1;

	const pad = " ".repeat(INSET);
	const innerPad = " ".repeat(INNER_PAD);
	const promptGlyph = isShellMode() ? "!" : ">";
	const promptStr = border(`${promptGlyph} `);
	const gutter = "  ";
	const padRight = (s: string): string => {
		const visLen = visibleWidth(s);
		return s + " ".repeat(Math.max(0, width - visLen));
	};
	const bottomRule = " " + chatboxBorderColor("\u2500".repeat(Math.max(1, width - 2))) + " ";
	const topRule = bottomRule;
	const slashMiddleSep =
		" ".repeat(SLASH_MIDDLE_INSET) +
		dimBorder("\u2500".repeat(Math.max(1, width - SLASH_MIDDLE_INSET * 2)));
	const middleSep = padRight(
		isSlashMode
			? slashMiddleSep
			: `${pad}${innerPad}${gutter}${border("\u2500".repeat(innerWidth))}`,
	);

	let firstBody = true;
	for (let i = 1; i < lines.length; i++) {
		const borderIdxPos = borderIndices.indexOf(i);
		const isMiddleBorder =
			i === middleBorderIdx ||
			(middleBorderIdx < 0 && borderIdxPos > 0 && borderIdxPos < borderIndices.length - 1);
		if (i === bottomBorderIdx && !isMiddleBorder) continue;
		if (isMiddleBorder) {
			lines[i] = middleSep;
			firstBody = false;
			continue;
		}
		const gutterStr = firstBody ? promptStr : gutter;
		lines[i] = padRight(`${pad}${innerPad}${gutterStr}${lines[i]}`);
		firstBody = false;
	}
	lines[topIdx] = topRule;
	if (bottomBorderIdx >= 0) {
		lines[bottomBorderIdx] = middleBorderIdx >= 0 ? middleSep : bottomRule;
	}
	const lastLineIdx = lines.length - 1;
	if (lastLineIdx > bottomBorderIdx && lastLineIdx > 0) {
		lines.push(bottomRule);
	}
	if (hasAutocompleteRows && bottomBorderIdx >= 0) {
		// The loop above has already applied the chatbox gutter to
		// autocomplete rows and appended the shell's bottom rule. Keep
		// them after the editor body so the slash menu expands downward.
		const bottomRuleIdx = lines.length - 1;
		const autocompleteLines = lines.slice(bottomBorderIdx + 1, bottomRuleIdx);
		const editorLines = lines.slice(topIdx + 1, bottomBorderIdx);
		return [topRule, ...editorLines, middleSep, ...autocompleteLines, bottomRule];
	}
	if (lines.length === 0) return lines;
	return lines;
}

function installAssistantMessagePatch(): void {
	const proto = (AssistantMessageComponent as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

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
		// Skip the full rebuild only when nothing that affects output changed.
		// Must include:
		// - markdownThemeGeneration: live accent mode switches bump this so
		//   MD headers/links/bullets rebuild with the new accent (CachedMarkdown
		//   re-parse alone is not enough if the heading closure or baked ANSI
		//   outlives the theme).
		// - content length signature: streaming mutates the same message ref;
		//   without a content sig the 3rd+ delta would freeze the transcript.
		// Thinking-toggle changes `hide` so it still rebuilds. Spurious
		// invalidate() with identical inputs still skips (no freezes).
		const sameMessage = this._emberContentMessage === message;
		let contentSig = "";
		if (Array.isArray(message?.content)) {
			for (const c of message.content) {
				if (c?.type === "text") contentSig += `t${c.text?.length ?? 0}`;
				else if (c?.type === "thinking") contentSig += `h${c.thinking?.length ?? 0}`;
				else if (c?.type === "toolCall") contentSig += `c${c.id ?? ""}`;
			}
		}
		const cacheKey = `${sameMessage ? "same" : "diff"}|${hide}|${outputPad}|${markdownThemeGeneration}|${contentSig}`;
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

		// Always rebuild the markdown theme so heading (and any other
		// overrides) resolve against the current live Theme. Never close
		// over a Theme reference from a previous mode — mdHeading must
		// track the live accent on every rebuild.
		// Heading style: colon-split accent ("Module 3:" accent, rest text).
		// emberHeadingStyle resolves liveTheme at call time (not closed over).
		this._emberMarkdownThemeBase = this.markdownTheme;
		this._emberMarkdownTheme = bind_live_markdown_theme({
			...this.markdownTheme,
		});
		const mdTheme = this._emberMarkdownTheme;

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text?.trim()) {
				this.contentContainer.addChild(
					new CachedMarkdown(content.text.trim(), this.outputPad, 0, mdTheme, undefined, "text"),
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
							color: (text: string) => resolve_live_theme().fg("thinkingText", text),
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
		// Suppress the output-limit error row entirely — auto-continue
		// handles recovery within budget; when the budget is exhausted the
		// model simply stops and no error noise is useful to the user.
		const suppressLengthError = message.stopReason === "length";
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
				// User-canceled runs should not print a red "Operation aborted" row.
				// If the assistant had no visible content and no custom errorMessage,
				// skip the default status text entirely. A non-generic errorMessage
				// (e.g. from a tool or provider) still surfaces as an error row.
				if (
					message.errorMessage &&
					message.errorMessage !== "Request was aborted" &&
					message.errorMessage !== "Operation aborted"
				) {
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(
						new Text(theme.fg("error", message.errorMessage), this.outputPad, 0),
					);
				}
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0),
				);
			}
		}

		// Mirror user-message Box paddingY: keep a blank row below visible
		// assistant text when tool rows are not about to follow in the transcript.
		if (hasVisibleContent && !hasToolCalls) {
			this.contentContainer.addChild(new Spacer(1));
		}
	};
}

/** Patch Text.prototype.invalidate so that ExpandableText instances (used
 *  by the [Context]/[Skills]/[Extensions]/[Themes] loaded-resources
 *  sections and the built-in header) re-evaluate their collapsed/expanded
 *  text from the getter callbacks. The base Text class stores ANSI-baked
 *  text once at construction; invalidate() only clears the wrap/pad cache,
 *  so the old accent color persists across mode switches. Re-calling the
 *  getters on invalidate refreshes the ANSI codes with the live theme.
 *
 *  ExpandableText extends Text but does not store an `expanded` property
 *  — `setExpanded(expanded)` calls `setText()` without persisting the
 *  boolean. We determine the current expansion state by comparing the
 *  ANSI-stripped visible text against the stripped collapsed/expanded
 *  getter outputs. */
function installExpandableTextPatch(): void {
	const proto = (Text as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;
	const originalInvalidate = proto.invalidate;
	proto.invalidate = function (this: any): void {
		originalInvalidate?.call(this);
		if (typeof this.getCollapsedText !== "function" || typeof this.getExpandedText !== "function") {
			return;
		}
		const collapsedText = this.getCollapsedText();
		const expandedText = this.getExpandedText();
		const currentStripped = this.text?.replace(ANSI_STRIP, "") ?? "";
		this.text =
			currentStripped === expandedText.replace(ANSI_STRIP, "") ? expandedText : collapsedText;
	};
}

/** CLI name used in Pi's update-notice action strings (`pi update`). */
const UPDATE_APP_NAME = "pi";
const CHANGELOG_URL = "https://pi.dev/changelog";

/**
 * Pi bakes `theme.fg("accent", …)` into the startup update notice
 * (`pi update`, changelog URL). That follows the live mode accent, so a
 * plan-mode startup paints those strings purple. Force muted/text instead —
 * update notices are informational chrome, not mode-colored UI.
 */
function installUpdateNotificationPatch(): void {
	const proto = (InteractiveMode as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

	// Helper: does the component tree render a blank line as its last line?
	// We only walk Container children recursively; leaf components like Spacer
	// are terminal. This avoids adding a second blank row when the previous
	// assistant message (or compact tool block) already ends with one.
	function component_ends_with_blank_row(component: any): boolean {
		if (!component) return false;
		if (component instanceof Spacer) {
			return component.render(1).length > 0;
		}
		if (component.children) {
			for (let i = component.children.length - 1; i >= 0; i--) {
				const child = component.children[i];
				if (child instanceof Spacer) {
					return child.render(1).length > 0;
				}
				if (child?.children || child?.contentContainer?.children) {
					return component_ends_with_blank_row(child);
				}
			}
		}
		return false;
	}

	const originalShowStatus = proto.showStatus;
	proto.showStatus = function emberShowStatus(this: any, message: string): void {
		const theme = resolve_live_theme();
		if (!theme || !this.chatContainer) {
			originalShowStatus.call(this, message);
			return;
		}

		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		// Consecutive info statuses still update the previous status line.
		if (
			last &&
			last === this.lastStatusText &&
			secondLast &&
			secondLast === this.lastStatusSpacer
		) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		// Only add a spacer if the previous component does not already end
		// with a blank row. This prevents two blank rows after an assistant
		// message or a compact tool block that already ends with a spacer.
		if (!component_ends_with_blank_row(last)) {
			const spacer = new Spacer(1);
			this.chatContainer.addChild(spacer);
			this.lastStatusSpacer = spacer;
		} else {
			this.lastStatusSpacer = undefined;
		}

		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(text);
		this.lastStatusText = text;
		this.ui.requestRender();
	};

	const originalShowNewVersion = proto.showNewVersionNotification;
	proto.showNewVersionNotification = function emberShowNewVersionNotification(
		this: any,
		release: { version?: string; note?: string },
	): void {
		const theme = resolve_live_theme();
		if (!theme || !this.chatContainer) {
			originalShowNewVersion.call(this, release);
			return;
		}

		const version = release?.version ?? "";
		const action = theme.fg("text", `${UPDATE_APP_NAME} update`);
		const updateInstruction =
			theme.fg("muted", `New version ${version} is available. Run `) + action;
		const changelogLink = getCapabilities().hyperlinks
			? hyperlink(theme.fg("muted", CHANGELOG_URL), CHANGELOG_URL)
			: theme.fg("muted", CHANGELOG_URL);
		const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
		const note = release?.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`,
				1,
				0,
			),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			const markdownTheme =
				typeof this.getMarkdownThemeWithSettings === "function"
					? this.getMarkdownThemeWithSettings()
					: undefined;
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, markdownTheme, {
					color: (text: string) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new Text(changelogLine, 1, 0));
		this.chatContainer.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		this.ui?.requestRender?.();
	};

	const originalShowPackageUpdate = proto.showPackageUpdateNotification;
	proto.showPackageUpdateNotification = function emberShowPackageUpdateNotification(
		this: any,
		packages: string[],
	): void {
		const theme = resolve_live_theme();
		if (!theme || !this.chatContainer) {
			originalShowPackageUpdate.call(this, packages);
			return;
		}

		const action = theme.fg("text", `${UPDATE_APP_NAME} update --extensions`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		this.ui?.requestRender?.();
	};
}

const STATUS_PATCH_MARKER = Symbol.for("pi-ember-ui:status-patched");

function installCompactionStatusPatch(): void {
	const proto = (InteractiveMode as any).prototype;
	if (proto[STATUS_PATCH_MARKER]) return;
	proto[STATUS_PATCH_MARKER] = true;

	const originalShowStatusIndicator = proto.showStatusIndicator;
	const originalClearStatusIndicator = proto.clearStatusIndicator;

	function suppress_compaction_status_indicator(indicator: any): void {
		if (indicator?.kind !== "compaction") return;
		// Stop Pi's spinner/timer so it does not keep requesting renders.
		if (typeof indicator.stop === "function") indicator.stop();
		// Replace render so the status row contributes no visible lines.
		indicator.render = () => [];
	}

	proto.showStatusIndicator = function emberShowStatusIndicator(this: any, indicator: any): any {
		if (indicator?.kind === "compaction") {
			startSummarizingAnimation();
			suppress_compaction_status_indicator(indicator);
			// Still flow through original so activeStatusIndicator is set and
			// clearStatusIndicator can dispose it. The suppressed render makes
			// the container empty.
		}
		return originalShowStatusIndicator.call(this, indicator);
	};

	proto.clearStatusIndicator = function emberClearStatusIndicator(this: any, kind?: string): any {
		const active = this.activeStatusIndicator;
		const wasCompaction =
			active?.kind === "compaction" &&
			(kind === undefined || kind === "compaction" || kind === active.kind);
		if (wasCompaction) stopSummarizingAnimation();
		return originalClearStatusIndicator.call(this, kind);
	};
}

function installBashExecutionPatch(): void {
	const proto = (BashExecutionComponent as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

	const originalRender = proto.render;
	const originalUpdateDisplay = proto.updateDisplay;

	proto.updateDisplay = function emberBashUpdateDisplay(this: any): void {
		originalUpdateDisplay.call(this);
		const theme = liveTheme ?? (globalThis as any)[THEME_KEY];
		if (!theme) return;
		const status = this.status;
		const dollarColor =
			status === "error"
				? "error"
				: status === "complete" || status === "cancelled"
					? "success"
					: "text";
		const header = this.contentContainer?.children?.[0];
		if (header instanceof Text) {
			header.setText(`${theme.fg(dollarColor, theme.bold("$"))} ${theme.fg("text", this.command)}`);
		}
	};

	proto.render = function renderEmberBash(this: any, width: number): string[] {
		const theme = liveTheme ?? (globalThis as any)[THEME_KEY];
		if (!theme) return originalRender.call(this, width);

		const innerWidth = Math.max(1, width - 2);
		const rawLines = originalRender.call(this, innerWidth) as string[];

		const result: string[] = [];
		const pad = " ";
		for (const line of rawLines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			if (/^[\s\u2500]*$/.test(stripped)) {
				if (stripped.includes("\u2500")) {
					result.push(chatboxBorderColor("\u2500".repeat(width)));
				}
				continue;
			}

			const padded = pad + line;
			const visLen = visibleWidth(padded);
			const padNeeded = Math.max(0, width - visLen);
			const fullLine = padded + " ".repeat(padNeeded);
			result.push(fullLine);
		}
		return result;
	};
}

/** Chatbox-style horizontal-rule color using the dim token. */
export function chatboxBorderColor(text: string): string {
	return colorize(text, DIM_COLOR);
}

/**
 * Wrap a content component in chatbox-style horizontal lines: top and bottom
 * `──` rules at 50% opacity, with 1-column left/right inner padding and no
 * background fill. Replaces the old `userMessageBg` block style for user
 * messages and quiz rows.
 */
export function chatboxBorderContainer(content: any, paddingX = 1): any {
	const wrapper = new Container();
	wrapper.addChild(new DynamicBorder(chatboxBorderColor));
	const inner = new Box(paddingX, 0, undefined);
	inner.addChild(content);
	wrapper.addChild(inner);
	wrapper.addChild(new DynamicBorder(chatboxBorderColor));
	return wrapper;
}

function installUserMessagePatch(): void {
	const proto = (UserMessageComponent as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

	proto.rebuild = function emberUserMessageRebuild(this: any): void {
		this.outputPad = 1;
		this.clear();
		const theme = resolve_live_theme();
		const markdown = new Markdown(
			this.text,
			0,
			0,
			this.markdownTheme,
			{
				color: (text: string) => theme.fg("userMessageText", text),
			},
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		this.addChild(chatboxBorderContainer(markdown, this.outputPad));
	};
}

function installCompactionSummaryPatch(): void {
	const proto = (CompactionSummaryMessageComponent as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

	proto.updateDisplay = function emberCompactionUpdateDisplay(this: any): void {
		this.setBgFn(undefined);
		this.paddingX = 0;
		this.paddingY = 0;
		this.clear();

		const theme = resolve_live_theme();
		const before = this.message.tokensBefore.toLocaleString();
		const after = Math.ceil(this.message.summary.length / 4).toLocaleString();

		const wrapper = new Container();
		const header = new Text(theme.fg("text", "\x1b[1mCompaction\x1b[22m"), 0, 0);
		wrapper.addChild(header);
		wrapper.addChild(new Spacer(1));

		const bodyText = `Summarized ${before} tokens into ~${after}.`;
		let body: any;
		if (this.expanded) {
			body = new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
		} else {
			const expandKey = (globalThis as any).process?.env?.["PI_EXPAND_KEY"] || "ctrl+o";
			body = new Text(
				theme.fg("customMessageText", bodyText) + theme.fg("dim", ` (${expandKey} to expand)`),
				0,
				0,
			);
		}

		const bodyWrapper = new Box(0, 0, undefined);
		bodyWrapper.addChild(body);
		wrapper.addChild(bodyWrapper);

		this.addChild(chatboxBorderContainer(wrapper, 1));
	};
}

function colorWithOpacity(text: string, hex: string, opacity: number): string {
	const source = hex.slice(1);
	const base = hexToRgbTriplet(PAGE_BG);
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
		i++;
	}
	return [text, ""];
}

/**
 * Resolve the live Theme at call time so MD headers always track the
 * active mode accent. Never close over a Theme from construction time —
 * mode switches mutate (or replace) the live Theme after messages exist.
 */
function resolve_live_theme(): any {
	return liveTheme ?? (globalThis as any)[THEME_KEY];
}

/**
 * Custom markdown heading style: when the heading text contains a colon,
 * only the portion up to and including the first colon is accent-colored;
 * the remainder reverts to plain text color. When there is no colon the
 * entire heading is accent-colored (the default behavior).
 *
 * Always reads `mdHeading` from the live Theme so mode switches recolor
 * existing transcript headers. The input `text` may already carry ANSI
 * codes (bold, underline) from the markdown renderer before `heading()`.
 */
function emberHeadingStyle(text: string): string {
	const theme = resolve_live_theme();
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
	const hasUnderline =
		text.includes("\x1b[4m") || text.includes("\x1b[1;4m") || text.includes("\x1b[4;1m");
	const stylePrefix = (s: string): string => {
		let styled = theme.bold(s);
		if (hasUnderline) styled = theme.underline(styled);
		return styled;
	};
	return (
		theme.fg("mdHeading", stylePrefix(prefixStripped)) +
		theme.fg("text", stylePrefix(suffixStripped))
	);
}

/**
 * Canonical Markdown-theme binding for Ember. Pi creates Markdown instances
 * through several component types (assistant, custom, compaction, branch,
 * skills, changelog). Every one must share this live heading callback rather
 * than retaining getMarkdownTheme()'s global-theme closure.
 */
function bind_live_markdown_theme(markdown_theme: MarkdownTheme): MarkdownTheme {
	markdown_theme.heading = emberHeadingStyle;
	return markdown_theme;
}

/**
 * Enforce the canonical live heading callback at the Markdown boundary. This
 * covers every Pi Markdown-bearing component without duplicating patches per
 * component. TUI invalidation clears each Markdown render cache on mode changes;
 * CachedMarkdown additionally keys its bounded cache by theme generation.
 */
function install_markdown_theme_patch(): void {
	type MarkdownPrototype = {
		[EMBER_PATCH_MARKER]?: boolean;
		render(this: Markdown, width: number): string[];
	};
	const proto = Markdown.prototype as unknown as MarkdownPrototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;
	const originalRender = proto.render;
	proto.render = function renderWithLiveHeading(this: Markdown, width: number): string[] {
		const markdown_theme = (this as unknown as { theme?: MarkdownTheme }).theme;
		if (markdown_theme) bind_live_markdown_theme(markdown_theme);
		return originalRender.call(this, width);
	};
}

function folderNameFromCwd(cwd: string): string {
	return cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;
}

function welcomeConfigPath(): string {
	return path.join(
		process.env.PI_HOME ||
			path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent"),
		"welcome.json",
	);
}

function setWelcomeUpdates(enabled: boolean): void {
	const file = welcomeConfigPath();
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		/* first-run, no file yet */
	}
	config.updates = enabled;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`);
}

type RadialPoint = { x: number; y: number; r: number; g: number; b: number; falloff: number };

function radialColorForCell(x: number, y: number, points: RadialPoint[]): [number, number, number] {
	let totalWeight = 0;
	let r = 0,
		g = 0,
		b = 0;
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
	return [Math.round(r / totalWeight), Math.round(g / totalWeight), Math.round(b / totalWeight)];
}

function startLogoAnimation(): void {
	if (logoAnimating) return;
	logoAnimating = true;
	logoStatic = false;
	activate_gradient("logo");
}

function stopLogoAnimation(): void {
	logoAnimating = false;
	logoStatic = true;
	deactivate_gradient("logo");
	requestRender?.();
}

function renderLogoWithGradient(accent: string): string[] {
	const logoRows = LOGO.length;
	const logoCols = LOGO[0].length;
	const gridCols = logoCols + SHADOW_OFFSET_X + 1;
	const gridRows = logoRows + SHADOW_OFFSET_Y;

	// Static state: 2-stop vertical gradient (top = muted, bottom = text).
	// No radial points, no per-frame sweep.
	if (!logoAnimating && logoStatic) {
		const mutedRgb = hexToRgbTriplet(MUTED_COLOR);
		const textRgb = hexToRgbTriplet(TEXT_COLOR);
		const grid: Grid = [];
		for (let row = 0; row < gridRows; row++) {
			grid.push(new Array(gridCols).fill(null).map(() => ({ ch: " " })));
		}
		const colorForRow = (row: number): [number, number, number] => {
			const t = logoRows > 1 ? row / (logoRows - 1) : 0;
			return clamp_lerp(mutedRgb, textRgb, t);
		};
		for (let row = 0; row < logoRows; row++) {
			const rgb = colorForRow(row);
			for (let col = 0; col < LOGO[row].length; col++) {
				if (LOGO[row][col] === "\u2588") {
					grid[row][col] = { ch: "\u2588", rgb };
				}
			}
		}
		placeBoxShadow(grid, gridRows, gridCols, colorForRow);
		return gridToLines(grid);
	}

	const [ar, ag, ab] = hexToRgbTriplet(accent);
	const accent70 = blendToHex(accent, PAGE_BG, 0.7);
	const [s7r, s7g, s7b] = hexToRgbTriplet(accent70);
	const accent40 = blendToHex(accent, PAGE_BG, 0.4);
	const [s4r, s4g, s4b] = hexToRgbTriplet(accent40);
	const points: RadialPoint[] = [
		{ x: 2, y: 0, r: 255, g: 255, b: 255, falloff: 3 },
		{ x: 10, y: 1, r: ar, g: ag, b: ab, falloff: 4 },
		{ x: 5, y: 3, r: s7r, g: s7g, b: s7b, falloff: 3.5 },
		{ x: 11, y: 5, r: s4r, g: s4g, b: s4b, falloff: 2.5 },
		{ x: 0, y: 4, r: 200, g: 180, b: 140, falloff: 2 },
	];

	const grid: Grid = [];
	for (let row = 0; row < gridRows; row++) {
		grid.push(new Array(gridCols).fill(null).map(() => ({ ch: " " })));
	}

	// Logo-specific ping-pong phase so the sweep travels right then left
	// smoothly instead of snapping back to the start.
	const phase = get_logo_phase();
	const sweep_center = -EDGE_PADDING + phase * (Math.max(0, logoCols - 1) + 2 * EDGE_PADDING);

	for (let row = 0; row < logoRows; row++) {
		for (let col = 0; col < LOGO[row].length; col++) {
			const ch = LOGO[row][col];
			if (ch === "\u2588") {
				let [r, g, b] = radialColorForCell(col, row, points);
				if (logoAnimating) {
					const dist = col - sweep_center;
					const intensity = gaussian_intensity(dist, GRADIENT_SIGMA);
					r = Math.round(r + (255 - r) * intensity);
					g = Math.round(g + (255 - g) * intensity);
					b = Math.round(b + (255 - b) * intensity);
				}
				grid[row][col] = { ch: "\u2588", rgb: [r, g, b] };
			}
		}
	}

	const centerCol = logoCols / 2;
	const animatingColorForRow = (row: number): [number, number, number] => {
		const [r, g, b] = radialColorForCell(centerCol, row, points);
		return [r, g, b];
	};
	placeBoxShadow(grid, gridRows, gridCols, animatingColorForRow);
	return gridToLines(grid);
}

let tuiRef: any;

/** Known plain-accent Text rows that Pi builds once with baked ANSI and
 *  never re-evaluates. On a mode switch we re-color them through the live
 *  Theme so they track the new accent. The visible string is the key; the
 *  value is a function that re-renders the full ANSI for that row using the
 *  live Theme. SSOT: no hardcoded hex — all color flows through
 *  resolve_live_theme(). */
const ACCENT_TEXT_RECOLORERS: Array<{
	match: (stripped: string) => boolean;
	recolor: (theme: any) => string;
}> = [
	{
		match: (s) => s === "\u2713 New session started",
		recolor: (theme) => `${theme.fg("text", "\u2713 New session started")}`,
	},
	{
		match: (s) => s === "What's New",
		recolor: (theme) => theme.bold(theme.fg("accent", "What's New")),
	},
	{
		match: (s) => s === "Keyboard Shortcuts",
		recolor: (theme) => theme.bold(theme.fg("accent", "Keyboard Shortcuts")),
	},
];

/** Recursively walk a TUI component tree and recolor every node that
 *  depends on the live accent. Two cases:
 *
 *  1. ExpandableText ([Context]/[Skills]/[Extensions]/[Themes] and the
 *     built-in header): call invalidate() so the
 *     installExpandableTextPatch re-runs getCollapsedText/getExpandedText
 *     with the live mdHeading/accent.
 *  2. Plain accent Text rows (e.g. "✓ New session started", "What's New",
 *     "Keyboard Shortcuts"): Pi bakes their ANSI once at construction and
 *     never refreshes them. We match the ANSI-stripped visible text against
 *     ACCENT_TEXT_RECOLORERS and rewrite via setText() with the live Theme.
 *
 *  Bounded by the live TUI tree (header + chat container + loaded-resources
 *  container). Visited set guards against cycles. O(nodes) — typically a
 *  few dozen — well within the per-frame budget. */
function invalidateLoadedResources(): void {
	const root = tuiRef;
	if (!root) return;
	const theme = resolve_live_theme();
	if (!theme) return;
	const visited = new WeakSet();
	const stack: any[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object" || visited.has(node)) continue;
		visited.add(node);

		// ExpandableText: re-run getters via the patched invalidate.
		if (typeof node.getCollapsedText === "function") {
			node.invalidate?.();
		}

		// Plain accent Text: match visible text and rewrite ANSI.
		if (typeof node.setText === "function" && typeof node.text === "string") {
			const stripped = node.text.replace(ANSI_STRIP, "");
			for (const entry of ACCENT_TEXT_RECOLORERS) {
				if (entry.match(stripped)) {
					node.setText(entry.recolor(theme));
					break;
				}
			}
		}

		// Recurse into children.
		const children = node.children;
		if (Array.isArray(children)) {
			for (const child of children) stack.push(child);
		}
	}
}

function installStartupHeader(ctx: any): void {
	if (ctx.mode !== "tui") return;

	ctx.ui.setHeader((tui: any, theme: any) => {
		tuiRef = tui;
		disable_tui_clear_on_shrink(tui);
		ensure_chatbox_leading_spacer(tui);
		return {
			render(width: number): string[] {
				// Re-read every render so model/dir/mode changes are reflected.
				const dir = folderNameFromCwd(ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd());
				const model = ctx.model;
				const modelName = model?.name ?? model?.id ?? "no model";

				// The animated startup logo and header bullet follow the live mode
				// accent (plan/code/orchestrate/debug). After the first assistant
				// token the logo goes static gray and the bullet goes dim.
				// mdListBullet is muted (list "1." / "-" markers); do not reuse it here.
				const accent = getActiveModeColor();
				const logoLines = renderLogoWithGradient(accent);
				const logoWidth = visibleWidth(logoLines[0] ?? "");
				const leftPad = Math.max(0, Math.floor((width - logoWidth) / 2));
				const padStr = " ".repeat(leftPad);
				// Once the logo turns static/gray (after the first assistant token
				// or at shutdown), the header bullet goes dim to match the model/dir.
				const headerBullet = logoStatic
					? theme.fg("dim", "\u2022")
					: `${fgAnsi(accent)}\u2022\x1b[39m`;

				const infoLine = `${theme.fg("text", modelName)} ${headerBullet} ${theme.fg("dim", dir)}`;
				const infoPad = Math.max(0, Math.floor((width - visibleWidth(infoLine)) / 2));
				const infoPadStr = " ".repeat(infoPad);

				const lines = [...logoLines.map((line) => padStr + line), infoPadStr + infoLine];
				return lines.map((line) =>
					visibleWidth(line) > width ? truncateToWidth(line, width) : line,
				);
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
	} else {
		const srcContent = fs.readFileSync(THEME_JSON, "utf-8");
		const destContent = fs.readFileSync(dest, "utf-8");
		if (srcContent !== destContent) {
			fs.copyFileSync(THEME_JSON, dest);
		}
	}
	// Seed export colors from the SSOT builder (default accent). Do this
	// only at install — mid-session writes trigger Pi's theme watcher,
	// which reloads a Theme without custom bg keys (subagentBg) and crashes.
	updateInstalledThemeExport(buildThemeExportColors(getActiveModeColor()));
}

/** Update the `export` section of the installed ember.json on disk so
 *  Pi's HTML export feature has accent-derived pageBg/cardBg/infoBg.
 *  Call only from ensureThemeInstalled (before the live Theme is installed
 *  or with scheduleThemeReassert pending). Never call mid-session without
 *  re-asserting the live Theme — the file watcher will clobber it. */
function updateInstalledThemeExport(exportColors: {
	pageBg: string;
	cardBg: string;
	infoBg: string;
}): void {
	const dest = path.join(getThemesDir(), `${THEME_NAME}.json`);
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(fs.readFileSync(dest, "utf-8"));
	} catch {
		return;
	}
	const current = json.export as Record<string, string> | undefined;
	if (
		current?.pageBg === exportColors.pageBg &&
		current?.cardBg === exportColors.cardBg &&
		current?.infoBg === exportColors.infoBg
	) {
		return;
	}
	json.export = exportColors;
	try {
		fs.writeFileSync(dest, `${JSON.stringify(json, null, "\t")}\n`);
	} catch {
		/* best-effort — export colors are non-critical */
	}
}

/**
 * Install the Thinking/Working widget flush above the editor. Leading padding
 * above the chatbox (or above this label when visible) comes from
 * ensure_chatbox_leading_spacer() in layout.ts (CHATBOX_LEADING_ROWS).
 * The live animated gradient label remains visible while compact tool groups
 * render their own transcript headers, so the chatbox state is never hidden.
 */
function installThinkingWidget(ctx: any): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget("ember-thinking", (_tui: any, _theme: any) => ({
		render(_width: number): string[] {
			if (isQuizActive() || isLatestSubagentRunning()) return [];
			const elapsedMs = userPromptAt > 0 ? performance.now() - userPromptAt : 0;
			const elapsedText =
				elapsedMs >= 1000 && !summarizingActive ? ` ${formatElapsed(elapsedMs)}` : "";
			const WIDGET_INSET = 1;
			const widgetPad = " ".repeat(WIDGET_INSET);
			const theme = resolve_live_theme();
			const elapsedColored = elapsedText ? theme.fg("dim", elapsedText) : "";
			if (summarizingActive) {
				const labelGradient = renderLiveGradient("Summarizing", "thinking");
				return [`${widgetPad}${labelGradient}${elapsedColored}${widgetPad}`];
			}
			if (!thinkingActive && !workingActive && !agentRunPending) return [];
			const isThinking = thinkingActive || (!workingActive && agentRunPending);
			const preset: GradientPreset = isThinking ? "thinking" : "working";
			const labelText = isThinking ? "Thinking" : "Working";
			const labelGradient = renderLiveGradient(labelText, preset);
			return [`${widgetPad}${labelGradient}${elapsedColored}${widgetPad}`];
		},
		invalidate() {},
	}));
}

export default function piEmberUiPlugin(pi: ExtensionAPI): void {
	bind_slash_command_exit_render((force) => requestTuiRender(force));
	// /model + /resume: prototype intercepts only (no registerCommand — that
	// conflicts with built-ins and shows in Extension issues).
	install_model_picker_patches();
	installShellHistorySyncPatch();
	ensureThemeInstalled();
	installThinkingBorderOverride();
	install_markdown_theme_patch();
	installAssistantMessagePatch();
	installExpandableTextPatch();
	installBashExecutionPatch();
	installUserMessagePatch();
	installCompactionSummaryPatch();
	installCompactionStatusPatch();
	installUpdateNotificationPatch();
	applyDynamicTheme();

	pi.on("session_start", (event, ctx) => {
		resetRenderScheduler();
		sessionCtx = ctx;
		tuiRef = undefined;
		requestRender = undefined;
		liveTheme = undefined;
		if (ctx.mode === "tui") {
			bind_model_picker_session(ctx, pi);
			renderCallback = (force = false) => {
				if (tuiRef?.requestRender) {
					tuiRef.requestRender(force);
					return;
				}
				ctx.ui.setStatus("pi-ember-ui-thinking-tick", undefined);
			};
			requestRender = scheduleRender;
			set_gradient_render_request(scheduleRender);
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHiddenThinkingLabel("");
			installThinkingWidget(ctx);
			startCursorBlink();
			setShellSyncCallback(() => {
				const focused = tuiRef?.focusedComponent as any;
				if (focused) requestShellModeVisualRefresh(focused, ctx);
			});
		}
		applyDynamicTheme();
		if (ctx.mode === "tui") {
			installStartupHeader(ctx);
			if (tuiRef) ensure_chatbox_leading_spacer(tuiRef);
			// Only animate the logo on genuinely fresh sessions where the
			// header is visible. On /resume, /fork, and /reload the header
			// is scrolled off-screen (or it is a hot reload); even the
			// bounded logo timer would otherwise add needless full renders.
			if (event.reason === "startup" || event.reason === "new") {
				startLogoAnimation();
			}
			installEmberFooter(ctx);
			init_footer_thinking_level(pi);
			recompute_footer_stats(ctx);
			installShellModeInputListener(ctx);
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
			// Mode switches rebuild live theme colors (mdHeading, accent, …)
			// and invalidate the TUI. applyDynamicTheme bumps
			// markdownThemeGeneration; the updateContent skip-guard includes
			// that generation so assistant messages fully rebuild their
			// CachedMarkdown children with the new accent — MD headers
			// and links recolor; list markers stay muted.
			applyDynamicTheme({ invalidate: true, render: false });
			invalidateLoadedResources();
			requestRender?.();
			return;
		}
		applyDynamicTheme();
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const ev = event.assistantMessageEvent;
		if (ev?.type === "thinking_delta" || ev?.type === "text_delta") {
			stopLogoAnimation();
		}
		if (ev && (ev.type === "thinking_start" || ev.type === "thinking_delta")) {
			if (!thinkingActive) startThinkingAnimation();
		}
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message?.role === "user") {
			userPromptAt = performance.now();
		}
	});

	pi.on("message_end", (_event, ctx) => {
		stopThinkingAnimation();
		schedule_footer_stats(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Context has just been compacted; refresh the footer token count
		// immediately so it shows the new post-compaction usage instead of
		// the old full value.
		recompute_footer_stats(ctx);
		requestRender?.();
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		set_footer_thinking_level(event.level ?? "off");
		refresh_footer(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentRunPending = true;
		startWorkingAnimation();
	});

	pi.on("agent_end", (_event, ctx) => {
		stopThinkingAnimation();
		stopWorkingAnimation();
		// When the agent loop ends (including after abort/cancel/error), no
		// subagent can still be running. Reset the flag so the editor border
		// reverts from the dim inset to the full-opacity accent line.
		setLatestSubagentRunning(false);
		const duration = userPromptAt > 0 ? performance.now() - userPromptAt : 0;
		userPromptAt = 0;
		try {
			if (ctx.mode === "tui" && duration >= 1000) {
				const model = ctx.model;
				const modelName = model?.name ?? model?.id ?? "model";
				ctx.ui.notify(`${modelName} · ${formatElapsed(duration)}`, "info");
			}
		} catch {
			/* stale ctx after replacement/dispose; skip notify */
		}
		requestRender?.();
	});

	// `agent_settled` is the only event that means Pi will not auto-retry,
	// auto-compact and retry, or continue with queued follow-ups. Drop the
	// inter-run hold here so the widget finally hides once the agent is truly
	// done. `agent_end` only fires for the current low-level run and may be
	// followed by another `agent_start` after compaction/retry/follow-ups.
	pi.on("agent_settled", (_event, ctx) => {
		agentRunPending = false;
		stopThinkingAnimation();
		stopWorkingAnimation();
		try {
			if (ctx.mode === "tui") requestRender?.();
		} catch {
			/* stale ctx after replacement/dispose; no render */
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.toolName === "subagent") recompute_latest_subagent_running();
		if (!thinkingActive) startWorkingAnimation();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
		} catch {
			return;
		}
		schedule_footer_stats(ctx);
		if (event.toolName === "subagent") {
			// The subagent tool has finished executing. Recompute would race the
			// toolResult being appended to the session branch and could keep the
			// flag true until agent_end, leaving the cap line visible for the
			// rest of the task. Set it false directly; a subsequent
			// tool_execution_start for a new subagent will recompute as needed.
			setLatestSubagentRunning(false);
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
		reset_model_picker_session();
		reset_slash_command_tracking();
		resetRenderScheduler();
		sessionCtx = undefined;
		requestRender = undefined;
		tuiRef = undefined;
		liveTheme = undefined;
		liveCodeBgAnsi = "";
		if (themeReassertTimer !== undefined) {
			clearTimeout(themeReassertTimer);
			themeReassertTimer = undefined;
		}
		markdownThemeGeneration = 0;
		clearMarkdownRenderCache();
		stopLogoAnimation();
		shutdown_gradient_clock();
		stopCursorBlink();
		thinkingActive = false;
		workingActive = false;
		agentRunPending = false;
		summarizingActive = false;
		userPromptAt = 0;
		setShellMode(false);
		setLatestSubagentRunning(false);
		setThinkingBlocksHidden(false);
		setToolGroupActive(false);
		setPlanAutoContinuing(false);
		setShellSyncCallback(undefined);
		reset_footer_state();
		if (ctx.hasUI) {
			ctx.ui.setWidget("ember-thinking", undefined);
			ctx.ui.setHeader(undefined);
		}
		if (shellInputUnsubscribe) {
			shellInputUnsubscribe();
			shellInputUnsubscribe = undefined;
		}
		getShellEditor = undefined;
	});
}
