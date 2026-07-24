import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CompactionSummaryMessageComponent,
	DynamicBorder,
	type ExtensionAPI,
	InteractiveMode,
	Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	type DefaultTextStyle,
	Editor,
	getKeybindings,
	Key,
	Markdown,
	type MarkdownTheme,
	isKeyRelease,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	activate_gradient,
	clamp_lerp,
	deactivate_gradient,
	EDGE_PADDING,
	GRADIENT_SIGMA,
	type GradientPreset,
	gaussian_intensity,
	get_gradient_phase,
	get_gradient_phase_with_offset,
	get_logo_phase,
	neutral_pulse_hex,
	invalidate_gradient_cache,
	MUTED_GROUP_GRADIENT_PRESET,
	render_gradient,
	set_gradient_render_request,
	shutdown_gradient_clock,
} from "./gradient.ts";
import {
	bind_slash_command_exit_render,
	reset_scroll_review_state,
	resume_scroll_follow_from_editor,
	reset_slash_command_tracking,
} from "./layout.ts";
import {
	buildThemeBgColors,
	buildThemeExportColors,
	buildThemeFgColors,
	DIM_COLOR,
	getActiveModeColor,
	isLatestSubagentRunning,
	isQuizActive,
	isScrollReviewActive,
	isShellMode,
	isGroupReopenableActive,
	isGroupThinkingChildActive,
	isSubagentActivityActive,
	isToolGroupActive,
	MUTED_COLOR,
	MUTED_MESSAGE_BG,
	PAGE_BG,
	markSubagentActivityEnded,
	markSubagentActivityStarted,
	resetSubagentActivity,
	setLatestSubagentRunning,
	setPlanAutoContinuing,
	setScrollReviewActive,
	setShellMode,
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
	setGroupReopenableActive,
	setToolGroupActive,
	setGroupThinkingChildActive,
	setTurnToolTranscriptActive,
	TEXT_COLOR,
	isTurnToolTranscriptActive,
} from "./mode-colors.ts";
import {
	bind_model_picker_session,
	install_model_picker_patches,
	reset_model_picker_session,
} from "./model-picker.ts";
import {
	is_model_picker_active,
	is_model_picker_editor,
	render_model_picker_rows,
} from "./model-selector.ts";
import {
	bind_select_list_theme_resolver,
	install_select_list_theme_patches,
} from "./select-list-theme.ts";

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
export {
	finalize_editor_input_after as finalizeEditorInputAfter,
	reset_scroll_review_state as resetScrollReviewState,
	resume_scroll_follow_from_editor as resumeScrollFollowFromEditor,
	reset_slash_command_tracking as resetSlashCommandTracking,
	sync_slash_command_active as syncSlashCommandActive,
} from "./layout.ts";
export {
	cancel_pending_model_pick as cancelPendingModelPick,
	pick_model_in_editor as pickModelInEditor,
	wrap_model_picker_editor as wrapModelPickerEditor,
} from "./model-picker.ts";
export {
	consume_pending_shell_submit_enter as consumePendingShellSubmitEnter,
	install_shell_history_sync_patch as installShellHistorySyncPatch,
	intercept_shell_input as interceptShellInput,
	process_shell_input as processShellInput,
	type ShellModeEditor,
	set_shell_sync_callback as setShellSyncCallback,
	sync_shell_mode_from_editor_text as syncShellModeFromEditorText,
} from "./shell-mode.ts";

import {
	init_footer_thinking_level,
	installEmberFooter,
	recompute_footer_stats,
	refresh_footer,
	reset_footer_state,
	schedule_footer_stats,
	set_footer_thinking_level,
} from "./footer.ts";
import {
	install_shell_history_sync_patch as installShellHistorySyncPatch,
	process_shell_input as processShellInput,
	type ShellModeEditor,
	set_shell_sync_callback as setShellSyncCallback,
} from "./shell-mode.ts";
import { notify_theme_refresh } from "./theme-refresh.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const THEME_JSON = path.join(SOURCE_ROOT, "ember.json");
const THEME_NAME = "ember";

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
/** Whether the agent loop is still running across retries/compaction/
 *  queued follow-ups. `agent_end` fires between each low-level run, but
 *  Pi may auto-retry, auto-compact and retry, or continue with queued
 *  follow-ups afterwards — only `agent_settled` means Pi will not run
 *  again automatically. This flag keeps the `Thinking` label
 *  visible during inter-run gaps so the header state is never
 *  lost while the agent is still working on the user's task. Cleared on
 *  `agent_settled` and `session_shutdown` (the safety floor). */
let agentRunPending = false;
/** Whether context compaction (manual, threshold, or overflow recovery)
 *  is in progress. When true the Thinking widget displays `Summarizing`
 *  with the Thinking accent gradient and hides the Thinking label.
 *  Cleared on compaction_end and `session_shutdown`. */
let summarizingActive = false;
let logoAnimating = false;
let logoStatic = true;
/** Cleared on session_start; set when the user sends their first visible message. */
let logo_settled_by_user_message = false;
const EMBER_PATCH_MARKER = Symbol.for("pi-ember-ui:patched");

/** Monotonic start of the visible user turn — used only for the final elapsed notify. */
let turnStartedAt = 0;
let latestAssistantMessageTimestamp: number | undefined;
/** Latest assistant message has mounted an in-transcript Thinking host. */
let assistantThinkingHostReady = false;
/** Hide the gradient Thinking header while the model emits visible text or tools. */
let thinkingHeaderSuppressed = false;
/** Tracks whether the Thinking/Summarizing status line was painted last
 *  frame so a hide can snap instead of leaving ghost rows. */

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

/** Whether the in-transcript assistant bubble should host Thinking (only the
 *  pre-tool wait right below the user message). After any tool rows appear,
 *  the above-editor widget owns Thinking so it stays near the live tail. */
function thinking_uses_in_message_host(): boolean {
	return assistantThinkingHostReady && !isTurnToolTranscriptActive();
}

/** Whether any Thinking/Summarizing host should paint a status line. */
function thinking_status_should_show(): boolean {
	if (isQuizActive() || isLatestSubagentRunning() || isSubagentActivityActive()) return false;
	if (summarizingActive) return true;
	if (!agentRunPending && !thinkingActive) return false;
	if (thinkingHeaderSuppressed || isToolGroupActive()) return false;
	// In-group Thinking owns the status row for settled/reopenable compact groups.
	if (isThinkingBlocksHidden() && (isGroupThinkingChildActive() || isGroupReopenableActive())) {
		return false;
	}
	return true;
}

/** Keep the thinking gradient clock aligned with visible Thinking/Summarizing UI. */
export function sync_thinking_gradient_clock(): void {
	if (summarizingActive) return;
	// In-group Thinking rows under settled compact groups use the same
	// "thinking" preset even though the external widget is suppressed.
	if (thinking_status_should_show() || isGroupThinkingChildActive()) {
		activate_gradient("thinking");
	} else {
		deactivate_gradient("thinking");
	}
}

/** Shared Thinking / Summarizing status row used by the above-editor widget
 *  (pre-assistant) and the in-message ThinkingStatusComponent. */
function render_thinking_status_lines(): string[] {
	if (!thinking_status_should_show()) return [];
	const WIDGET_INSET = 1;
	const widgetPad = " ".repeat(WIDGET_INSET);
	const label = summarizingActive ? "Summarizing" : "Thinking";
	const labelGradient = renderLiveGradient(label, "thinking");
	const row = `${widgetPad}${labelGradient}${widgetPad}`;
	const in_compact_group =
		isThinkingBlocksHidden() && (isGroupThinkingChildActive() || isGroupReopenableActive());
	if (in_compact_group) return [row];
	// One blank row above and below the in-message Thinking host.
	if (thinking_uses_in_message_host()) return ["", row, ""];
	return [row, ""];
}

/** Update status state and let Pi perform the normal component-tree render. */
function refresh_thinking_status(): void {
	sync_thinking_gradient_clock();
	requestRender?.();
}

/** Hide the gradient Thinking header while tools or visible assistant text run. */
export function suppress_thinking_header_for_work(): void {
	if (!thinkingHeaderSuppressed) {
		thinkingHeaderSuppressed = true;
		refresh_thinking_status();
	}
}

/** Re-show the gradient Thinking header when a thinking stream resumes. */
export function resume_thinking_header_for_think_stream(): void {
	if (thinkingHeaderSuppressed) {
		thinkingHeaderSuppressed = false;
		refresh_thinking_status();
	}
}

class ThinkingStatusComponent implements Component {
	messageTimestamp: number | undefined;
	render(_width: number): string[] {
		if (latestAssistantMessageTimestamp === undefined) return [];
		if (this.messageTimestamp !== latestAssistantMessageTimestamp) return [];
		if (!thinking_uses_in_message_host()) return [];
		return render_thinking_status_lines();
	}
	invalidate(): void {
		/* Lifecycle handlers request the normal native render. */
	}
}

let requestRender: (() => void) | undefined;
let sessionCtx: any;
let shellInputUnsubscribe: (() => void) | undefined;
let scrollReviewInputUnsubscribe: (() => void) | undefined;
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

/** Live-gradient tick subscribers are managed by gradient.ts.
 *  Re-export subscribe/unsubscribe so existing consumers
 *  (pi-compact-tools, subagent renderer) keep working without import changes. */
export {
	MUTED_GROUP_GRADIENT_PRESET,
	subscribe_gradient_tick as subscribeGradientTick,
	unsubscribe_gradient_tick as unsubscribeGradientTick,
} from "./gradient.ts";

export { sync_thinking_gradient_clock as syncThinkingGradientClock };

/** Request a normal render through Pi's public UI API. */
export function requestTuiRender(_force = false): void {
	requestRender?.();
}

/**
 * Request a render starting from a live editor instance. Use this when the
 * editor is known (e.g. inside a handleInput wrapper) and module-level
 * requestRender might be stale due to jiti module duplication. Falls back to
 * the module-level scheduler if the editor has no live TUI.
 */
export function requestTuiRenderFromEditor(
	editor: { tui?: { requestRender?: () => void } },
): void {
	if (editor?.tui?.requestRender) {
		editor.tui.requestRender();
		return;
	}
	requestRender?.();
}

/** Request a non-forced render of the live editor and refresh the footer so
 *  shell-mode visual indicators (prompt glyph, border, footer left stats)
 *  update together. Use the captured session ctx when available.
 */
export function requestShellModeVisualRefresh(
	editor: { tui?: { requestRender?: () => void } },
	ctx?: any,
): void {
	requestTuiRenderFromEditor(editor);
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

/** Pause live TUI updates while the user reads terminal scrollback. */
function installScrollReviewInputListener(ctx: any): void {
	const tui = tuiRef ?? ctx?.ui;
	if (!tui?.addInputListener) return;
	if (scrollReviewInputUnsubscribe) {
		scrollReviewInputUnsubscribe();
		scrollReviewInputUnsubscribe = undefined;
	}

	scrollReviewInputUnsubscribe = tui.addInputListener((data: string) => {
		if (isKeyRelease(data)) return undefined;
		if (matchesKey(data, "shift+ctrl+s")) {
			if (isScrollReviewActive()) {
				resume_scroll_follow_from_editor({ tui });
			} else {
				setScrollReviewActive(true);
				ctx.ui?.notify?.(
					"Scroll review: live updates paused. Type or Ctrl+Shift+S to resume.",
					"info",
				);
			}
			return { consume: true };
		}
		if (
			!isScrollReviewActive() &&
			!agentRunPending &&
			(matchesKey(data, Key.pageUp) || matchesKey(data, Key.home))
		) {
			setScrollReviewActive(true);
		}
		return undefined;
	});
}

function stopThinkingAnimation(): void {
	thinkingActive = false;
	refresh_thinking_status();
}

/** Arm Thinking during inter-run gaps (pre-token, post-tool, agent_start). SSOT. */
export function arm_pre_token_thinking_status(): void {
	if (isQuizActive() || isLatestSubagentRunning() || isSubagentActivityActive()) return;
	agentRunPending = true;
	// In-group linger or real in-group Thinking owns the status row.
	if (
		isThinkingBlocksHidden() &&
		(isToolGroupActive() || isGroupThinkingChildActive() || isGroupReopenableActive())
	) {
		refresh_thinking_status();
		return;
	}
	thinkingHeaderSuppressed = false;
	activate_gradient("thinking");
	refresh_thinking_status();
}

function startThinkingAnimation(): void {
	thinkingActive = true;
	activate_gradient("thinking");
	refresh_thinking_status();
}

function startSummarizingAnimation(): void {
	summarizingActive = true;
	activate_gradient("summarizing");
	refresh_thinking_status();
}

function stopSummarizingAnimation(): void {
	summarizingActive = false;
	deactivate_gradient("summarizing");
	refresh_thinking_status();
}

/** Above-editor Thinking host: pre-tool wait (before transcript tools) and
 *  every later agent-work gap with no live tool children on screen. */
function installThinkingWidget(ctx: any): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget("ember-thinking", (_tui: any, _theme: any) => ({
		render(_width: number): string[] {
			if (thinking_uses_in_message_host()) return [];
			return render_thinking_status_lines();
		},
		invalidate() {
			/* gradient ticks repaint in-place */
		},
	}));
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
 * canonical gradient engine. Thinking/Summarizing use the accent palette;
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
		isShellMode() || agentRunPending || summarizingActive ? MUTED_COLOR : TEXT_COLOR;
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
	const modelPickerActive = is_model_picker_active() && is_model_picker_editor(instance);
	const hasAutocompleteRows = bottomBorderIdx >= 0 && lines.length > bottomBorderIdx + 1;
	// Slash autocomplete menu expands downward from the chatbox. The
	// autocomplete rows stay after the editor body, so the menu grows below.
	const middleBorderIdx = -1;

	const pad = " ".repeat(INSET);
	const innerPad = " ".repeat(INNER_PAD);
	const promptGlyph = isShellMode() ? "!" : ">";
	const promptStr = border(`${promptGlyph} `);
	const gutter = "  ";
	const fit = (s: string): string =>
		visibleWidth(s) > width ? truncateToWidth(s, width) : s;
	const padRight = (s: string): string => {
		const fitted = fit(s);
		return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	};
	const bottomRule = " " + chatboxBorderColor("\u2500".repeat(Math.max(1, width - 2))) + " ";
	const topRule = bottomRule;
	const slashMiddleSep =
		" ".repeat(SLASH_MIDDLE_INSET) +
		colorWithOpacity(
			"\u2500".repeat(Math.max(1, width - SLASH_MIDDLE_INSET * 2)),
			TEXT_COLOR,
			0.5,
		);
	const middleSep = padRight(
		isSlashMode || modelPickerActive
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
		return [topRule, ...editorLines, middleSep, ...autocompleteLines, bottomRule].map(fit);
	}
	if (modelPickerActive && bottomBorderIdx >= 0) {
		const editorLines = lines.slice(topIdx + 1, bottomBorderIdx);
		const pickerLines = render_model_picker_rows(innerWidth).map((line) =>
			padRight(`${pad}${innerPad}${gutter}${line}`),
		);
		return [topRule, ...editorLines, middleSep, ...pickerLines, bottomRule].map(fit);
	}
	if (lines.length === 0) return lines;
	return lines.map(fit);
}

function installAssistantMessagePatch(): void {
	const proto = (AssistantMessageComponent as any).prototype;
	if (proto[EMBER_PATCH_MARKER]) return;
	proto[EMBER_PATCH_MARKER] = true;

	const assistantPrototype = (AssistantMessageComponent as any).prototype;
	const originalSetHideThinkingBlock = assistantPrototype.setHideThinkingBlock;
	if (typeof originalSetHideThinkingBlock === "function") {
		assistantPrototype.setHideThinkingBlock = function (this: any, hide: boolean): void {
			const next_hidden = hide === true;
			const prev_hidden = isThinkingBlocksHidden();
			setThinkingBlocksHidden(next_hidden);
			originalSetHideThinkingBlock.call(this, hide);
			if (prev_hidden !== next_hidden) {
				refresh_thinking_status();
			}
		};
	}

	assistantPrototype.updateContent = function (this: any, message: any): void {
		const msgTimestamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;
		if (
			msgTimestamp !== undefined &&
			msgTimestamp >= (latestAssistantMessageTimestamp ?? Number.NEGATIVE_INFINITY)
		) {
			latestAssistantMessageTimestamp = msgTimestamp;
		}

		if (!this._emberThinkingStatus) {
			this._emberThinkingStatus = new ThinkingStatusComponent();
		}
		this._emberThinkingStatus.messageTimestamp = msgTimestamp;
		if (
			msgTimestamp !== undefined &&
			msgTimestamp === latestAssistantMessageTimestamp
		) {
			assistantThinkingHostReady = true;
		}

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

	const originalRender = assistantPrototype.render;
	if (typeof originalRender === "function") {
		assistantPrototype.render = function (this: any, width: number): string[] {
			const lines = originalRender.call(this, width) as string[];
			const status = this._emberThinkingStatus as ThinkingStatusComponent | undefined;
			if (!status) return lines;
			const statusLines = status.render(width);
			if (statusLines.length === 0) return lines;
			return [...lines, ...statusLines];
		};
	}
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

/**
 * Suppress Pi's startup update notices entirely (new Pi version, extension
 * package updates, and the "What's New" changelog block). The startup screen
 * should only show the normal context/skills/extensions/themes summary.
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

	// Suppress version and package update notices entirely. The startup screen
	// should only show the normal context/skills/extensions/themes summary.
	proto.showNewVersionNotification = function emberShowNewVersionNotification() {
		return;
	};

	proto.showPackageUpdateNotification = function emberShowPackageUpdateNotification() {
		return;
	};

	// Suppress the "What's New" startup changelog block.
	proto.showStartupNoticesIfNeeded = function emberShowStartupNoticesIfNeeded() {
		return;
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
	logo_settled_by_user_message = false;
	logoAnimating = true;
	logoStatic = false;
	activate_gradient("logo");
	requestRender?.();
}

function stopLogoAnimation(): void {
	if (!logoAnimating && logoStatic) return;
	logoAnimating = false;
	logoStatic = true;
	deactivate_gradient("logo");
	requestRender?.();
}

/** Stop the startup logo when the user commits their first visible message. */
function stopLogoOnFirstUserMessage(): void {
	if (logo_settled_by_user_message) return;
	logo_settled_by_user_message = true;
	stopLogoAnimation();
}

/** @deprecated Logo no longer stops on editor keystrokes — only on first send. */
export function stopLogoOnEditorInput(): void {}

function renderLogoWithGradient(): string[] {
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

	const dimRgb = hexToRgbTriplet(DIM_COLOR);
	const mutedRgb = hexToRgbTriplet(MUTED_COLOR);
	const textRgb = hexToRgbTriplet(TEXT_COLOR);
	const points: RadialPoint[] = [
		{ x: 2, y: 0, r: dimRgb[0], g: dimRgb[1], b: dimRgb[2], falloff: 3 },
		{ x: 10, y: 1, r: mutedRgb[0], g: mutedRgb[1], b: mutedRgb[2], falloff: 4 },
		{ x: 5, y: 3, r: textRgb[0], g: textRgb[1], b: textRgb[2], falloff: 3.5 },
		{ x: 11, y: 5, r: mutedRgb[0], g: mutedRgb[1], b: mutedRgb[2], falloff: 2.5 },
		{ x: 0, y: 4, r: dimRgb[0], g: dimRgb[1], b: dimRgb[2], falloff: 2 },
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
					r = Math.round(r + (textRgb[0] - r) * intensity);
					g = Math.round(g + (textRgb[1] - g) * intensity);
					b = Math.round(b + (textRgb[2] - b) * intensity);
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
		const render_header = (width: number): string[] => {
			// Re-read every render so model/dir/mode changes are reflected.
			const dir = folderNameFromCwd(ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd());
			const model = ctx.model;
			const modelName = model?.name ?? model?.id ?? "no model";

			// The animated startup logo and header bullet pulse through a
			// dim→muted→text gradient. After the user sends their first message
			// the logo goes static gray and the bullet goes dim.
			// mdListBullet is muted (list "1." / "-" markers); do not reuse it here.
			const logoLines = renderLogoWithGradient();
			const logoWidth = visibleWidth(logoLines[0] ?? "");
			const leftPad = Math.max(0, Math.floor((width - logoWidth) / 2));
			const padStr = " ".repeat(leftPad);
			// Once the logo turns static/gray (after the first user message
			// or at shutdown), the header bullet goes dim to match the model/dir.
			const headerBullet = logoStatic
				? theme.fg("dim", "\u2022")
				: colorize("\u2022", neutral_pulse_hex(get_logo_phase()));

			const infoLine = `${theme.fg("text", modelName)} ${headerBullet} ${theme.fg("dim", dir)}`;
			const infoPad = Math.max(0, Math.floor((width - visibleWidth(infoLine)) / 2));
			const infoPadStr = " ".repeat(infoPad);

			const lines = [...logoLines.map((line) => padStr + line), infoPadStr + infoLine];
			return lines.map((line) =>
				visibleWidth(line) > width ? truncateToWidth(line, width) : line,
			);
		};
		return {
			render(width: number): string[] {
				return render_header(width);
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

export default function piEmberUiPlugin(pi: ExtensionAPI): void {
	bind_slash_command_exit_render(() => requestTuiRender());
	// /model + /resume: prototype intercepts only (no registerCommand — that
	// conflicts with built-ins and shows in Extension issues).
	install_model_picker_patches();
	bind_select_list_theme_resolver(() => {
		const theme = liveTheme ?? (globalThis as any)[THEME_KEY];
		if (!theme) {
			throw new Error("Theme not initialized");
		}
		return theme;
	});
	install_select_list_theme_patches(() => {
		const theme = liveTheme ?? (globalThis as any)[THEME_KEY];
		if (!theme) {
			throw new Error("Theme not initialized");
		}
		return theme;
	});
	installShellHistorySyncPatch();
	ensureThemeInstalled();
	install_markdown_theme_patch();
	installAssistantMessagePatch();
	installExpandableTextPatch();
	installBashExecutionPatch();
	installUserMessagePatch();
	installCompactionSummaryPatch();
	installCompactionStatusPatch();
	installUpdateNotificationPatch();
	applyDynamicTheme();

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		tuiRef = undefined;
		requestRender = undefined;
		liveTheme = undefined;
		if (ctx.mode === "tui") {
			bind_model_picker_session(ctx, pi);
			requestRender = () => {
				(tuiRef as { requestRender?: () => void } | undefined)?.requestRender?.();
			};
			set_gradient_render_request(requestRender);
			ctx.ui.setWorkingVisible(false);
			ctx.ui.setHiddenThinkingLabel("");
			setShellSyncCallback(() => {
				const focused = tuiRef?.focusedComponent as any;
				if (focused) requestShellModeVisualRefresh(focused, ctx);
			});
		}
		applyDynamicTheme();
		if (ctx.mode === "tui") {
			startLogoAnimation();
			installStartupHeader(ctx);
			installThinkingWidget(ctx);
			installEmberFooter(ctx);
			init_footer_thinking_level(pi, ctx);
			recompute_footer_stats(ctx);
			installShellModeInputListener(ctx);
			installScrollReviewInputListener(ctx);
		}
	});

	// Re-render header/footer when the model changes.
	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode === "tui") {
			init_footer_thinking_level(pi, ctx);
			refresh_footer(ctx);
			requestRender?.();
		}
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

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (typeof event.prompt === "string" && event.prompt.trim()) {
			arm_pre_token_thinking_status();
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const ev = event.assistantMessageEvent;
		const isText = ev?.type === "text_start" || ev?.type === "text_delta";
		const isThinking = ev?.type === "thinking_start" || ev?.type === "thinking_delta";
		if (ev && isThinking) {
			resume_thinking_header_for_think_stream();
			if (!thinkingActive) startThinkingAnimation();
		}
		if (ev && isText) {
			suppress_thinking_header_for_work();
		}
		if (isText || isThinking) {
			refresh_thinking_status();
		}
		const assistantMsg = event.message;
		if (assistantMsg?.role === "assistant" && typeof assistantMsg.timestamp === "number") {
			if (assistantMsg.timestamp >= (latestAssistantMessageTimestamp ?? Number.NEGATIVE_INFINITY)) {
				latestAssistantMessageTimestamp = assistantMsg.timestamp;
			}
		}
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message?.role === "user") {
			const display = (event.message as { display?: boolean }).display;
			if (display !== false) {
				stopLogoOnFirstUserMessage();
			}
			turnStartedAt = performance.now();
			setTurnToolTranscriptActive(false);
			thinkingHeaderSuppressed = false;
			// Show Thinking immediately after send — agent_start may arrive later.
			if (display !== false) {
				agentRunPending = true;
				activate_gradient("thinking");
				refresh_thinking_status();
			}
		} else if (event.message?.role === "assistant" && typeof event.message.timestamp === "number") {
			if (
				event.message.timestamp >= (latestAssistantMessageTimestamp ?? Number.NEGATIVE_INFINITY)
			) {
				latestAssistantMessageTimestamp = event.message.timestamp;
			}
			refresh_thinking_status();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message?.role === "assistant") {
			if (typeof event.message.timestamp === "number") {
				if (
					event.message.timestamp >= (latestAssistantMessageTimestamp ?? Number.NEGATIVE_INFINITY)
				) {
					latestAssistantMessageTimestamp = event.message.timestamp;
				}
				stopThinkingAnimation();
			}
		}
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
		arm_pre_token_thinking_status();
	});

	pi.on("agent_end", (_event, ctx) => {
		stopThinkingAnimation();
		// When the agent loop ends (including after abort/cancel/error), no
		// subagent can still be running. Reset the flag so the editor border
		// reverts from the dim inset to the full-opacity accent line.
		setLatestSubagentRunning(false);
		const duration = turnStartedAt > 0 ? performance.now() - turnStartedAt : 0;
		turnStartedAt = 0;
		try {
			if (ctx.mode === "tui" && duration >= 1000) {
				const model = ctx.model;
				const modelName = model?.name ?? model?.id ?? "model";
				ctx.ui.notify(`${modelName} · ${formatElapsed(duration)}`, "info");
			}
		} catch {
			/* stale ctx after replacement/dispose; skip notify */
		}
		refresh_thinking_status();
	});

	// `agent_settled` is the only event that means Pi will not auto-retry,
	// auto-compact and retry, or continue with queued follow-ups. Drop the
	// inter-run hold here so the widget finally hides once the agent is truly
	// done. `agent_end` only fires for the current low-level run and may be
	// followed by another `agent_start` after compaction/retry/follow-ups.
	pi.on("agent_settled", (_event, ctx) => {
		agentRunPending = false;
		thinkingHeaderSuppressed = false;
		setTurnToolTranscriptActive(false);
		resetSubagentActivity();
		stopLogoAnimation();
		stopThinkingAnimation();
		try {
			if (ctx.mode === "tui") refresh_thinking_status();
		} catch {
			/* stale ctx after replacement/dispose; no render */
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		suppress_thinking_header_for_work();
		setTurnToolTranscriptActive(true);
		if (event.toolName === "subagent") {
			markSubagentActivityStarted();
			refresh_thinking_status();
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		suppress_thinking_header_for_work();
		setTurnToolTranscriptActive(true);
		if (event.toolName === "subagent") {
			recompute_latest_subagent_running();
		}
		refresh_thinking_status();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
		} catch {
			return;
		}
		schedule_footer_stats(ctx);
		if (event.toolName === "subagent") {
			markSubagentActivityEnded();
			requestRender?.();
			return;
		}
		arm_pre_token_thinking_status();
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
		sessionCtx = undefined;
		requestRender = undefined;
		set_gradient_render_request(undefined);
		tuiRef = undefined;
		liveTheme = undefined;
		liveCodeBgAnsi = "";
		if (themeReassertTimer !== undefined) {
			clearTimeout(themeReassertTimer);
			themeReassertTimer = undefined;
		}
		markdownThemeGeneration = 0;
		clearMarkdownRenderCache();
		logo_settled_by_user_message = false;
		stopLogoAnimation();
		shutdown_gradient_clock();
		thinkingActive = false;
		agentRunPending = false;
		thinkingHeaderSuppressed = false;
		summarizingActive = false;
		assistantThinkingHostReady = false;
		turnStartedAt = 0;
		setShellMode(false);
		reset_scroll_review_state();
		setLatestSubagentRunning(false);
		resetSubagentActivity();
		setThinkingBlocksHidden(false);
		setToolGroupActive(false);
		setGroupThinkingChildActive(false);
		setGroupReopenableActive(false);
		setTurnToolTranscriptActive(false);
		setPlanAutoContinuing(false);
		setShellSyncCallback(undefined);
		reset_footer_state();
		if (ctx.hasUI) {
			ctx.ui.setHeader(undefined);
			try {
				ctx.ui.setWidget("ember-thinking", undefined);
			} catch {
				/* widget API may be unavailable outside TUI */
			}
		}
		latestAssistantMessageTimestamp = undefined;
		if (shellInputUnsubscribe) {
			shellInputUnsubscribe();
			shellInputUnsubscribe = undefined;
		}
		if (scrollReviewInputUnsubscribe) {
			scrollReviewInputUnsubscribe();
			scrollReviewInputUnsubscribe = undefined;
		}
		getShellEditor = undefined;
	});
}
