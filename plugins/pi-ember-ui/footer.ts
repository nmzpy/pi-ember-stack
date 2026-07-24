/**
 * Ember bottom footer — owned by `pi-ember-ui`.
 *
 * The footer renders one row: `folder • context/cache/cost` on the left and
 * `Mode • model thinking-level provider tps` on the right, with a 1-column
 * inset on each side. It is installed via `ctx.ui.setFooter` and reads live
 * state (model, cwd, context usage, session entries) from the session ctx
 * captured at install time.
 *
 * Stats recomputation is O(total context) (it iterates session entries and
 * calls `ctx.getContextUsage()`), so it is never run from the render closure.
 * Instead it is cached on `session_start` and recomputed through a single
 * zero-delay dirty timer shared by `message_end` and `tool_execution_end`
 * events. The render closure only reads the cache.
 *
 * The mode label is resolved through a registered resolver so the mode
 * definitions stay the single source of truth in `pi-custom-agents`; the
 * footer only owns the rendering and the inset/layout.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getLiveTps } from "../pi-ember-tps/index.ts";
import {
	getActiveModeId,
	isShellMode,
	liveAccentFg,
} from "./mode-colors.ts";
import {
	format_effort_display_label,
	is_effort_slider_point,
	model_name_has_thinking_variant,
	resolve_model_effort_level,
	strip_for_family_grouping,
} from "./model-variants.ts";

export {
	get_baked_thinking_variant,
	model_name_has_thinking_variant,
} from "./model-variants.ts";

/** Footer inset (columns) on each side. SSOT for the bottom footer inset. */
const FOOTER_INSET = 1;

const FOOTER_STATUS_KEY = "pi-ember-ui-footer";

/**
 * Cached footer stats. The footer render closure fires on every TUI render.
 * Iterating all session entries + calling `ctx.getContextUsage()` is
 * O(total context) per frame and can exceed the frame budget on long
 * sessions, causing infini-lock. These stats are recomputed on session_start
 * and through one zero-delay dirty timer shared by message_end and
 * tool_execution_end events, never from the footer render path.
 */
let footerStatsCache:
	| {
			totalCost: number;
			latestCacheHitRate: number | undefined;
			contextTokens: number | null;
			contextWindow: number;
	  }
	| undefined;

let footerThinkingLevel = "off";

let footer_stats_timer: ReturnType<typeof setTimeout> | undefined;
let footer_stats_dirty = false;

// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
let footerCtx: any;

/** Mode-id → display label resolver, registered by `pi-custom-agents`. */
let mode_label_resolver: ((modeId: string) => string) | undefined;

/**
 * Register the canonical mode-id → label resolver. `pi-custom-agents` owns
 * the `MODES` map (the SSOT for mode labels); the footer only renders.
 */
export function set_mode_label_resolver(fn: (modeId: string) => string): void {
	mode_label_resolver = fn;
}

/** Format a token count with k/M suffixes. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
function is_live_session(ctx: any): boolean {
	return footerCtx !== undefined && ctx?.sessionManager === footerCtx?.sessionManager;
}

/**
 * Mark footer stats dirty. A zero-delay timer coalesces parallel tool
 * completions into one O(n) recomputation per event-loop burst, away from
 * the footer render closure. Safe to call from any lifecycle handler.
 */
// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
export function schedule_footer_stats(ctx: any): void {
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

/** Cancel any pending stats recomputation and clear the dirty flag. */
export function cancel_footer_stats_schedule(): void {
	if (footer_stats_timer !== undefined) clearTimeout(footer_stats_timer);
	footer_stats_timer = undefined;
	footer_stats_dirty = false;
}

/** Reset all session-bound footer state (called on session_shutdown). */
export function reset_footer_state(): void {
	cancel_footer_stats_schedule();
	footerStatsCache = undefined;
	footerThinkingLevel = "off";
	footerCtx = undefined;
}

/** Synchronously recompute footer stats from the session ctx. */
// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
export function recompute_footer_stats(ctx: any): void {
	footerCtx = ctx;
	recompute_footer_stats_impl(ctx);
}

// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
function recompute_footer_stats_impl(ctx: any): void {
	let totalCost = 0;
	let latestCacheHitRate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		totalCost += usage.cost.total;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
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

/** Seed footer effort from Pi thinking level and/or the active catalog model. */
// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
export function init_footer_thinking_level(pi: any, ctx?: any): void {
	const model = ctx?.model as { id?: string; name?: string } | undefined;
	const piLevel = pi?.getThinkingLevel?.() ?? "off";
	footerThinkingLevel = resolve_model_effort_level(model, piLevel);
}

/** Update the thinking level shown in the footer (thinking_level_select). */
export function set_footer_thinking_level(level: string): void {
	footerThinkingLevel = level ?? "off";
}

/**
 * Invalidate the footer frame. Cheaper than a full TUI render —
 * `setStatus` only re-renders the footer/editor frame.
 */
// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
export function refresh_footer(ctx: any): void {
	if (ctx?.mode === "tui") ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
}

function resolve_mode_label(modeId: string): string {
	const label = mode_label_resolver ? mode_label_resolver(modeId) : modeId;
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Install the Ember bottom footer. Captures the session ctx for the render
 * closure and stats recomputation. Call from `session_start` after the ctx
 * is bound.
 */
// biome-ignore lint/suspicious/noExplicitAny: Pi's extension ctx is dynamic
export function installEmberFooter(ctx: any): void {
	if (ctx.mode !== "tui") return;
	footerCtx = ctx;
	// biome-ignore lint/suspicious/noExplicitAny: Pi's setFooter callback signature is dynamic
	ctx.ui.setFooter((_tui: any, theme: any, _footerData: any) => {
		return {
			render(width: number): string[] {
				const PAD = " ".repeat(FOOTER_INSET);
				const innerWidth = Math.max(0, width - FOOTER_INSET * 2);
				const stats = footerStatsCache;
				const totalCost = stats?.totalCost ?? 0;
				const latestCacheHitRate = stats?.latestCacheHitRate;
				const contextWindow = stats?.contextWindow ?? 0;
				const usedTokens = stats?.contextTokens;

				const model = ctx.model;
				const usedLabel =
					usedTokens === null || usedTokens === undefined ? "?" : formatTokens(usedTokens);
				const cwd = ctx.sessionManager.getCwd();
				const folderName = cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd;

				// --- Left side: folderdir • context/cache/cost ---
				const statsParts: string[] = [];
				statsParts.push(`${usedLabel}/${formatTokens(contextWindow)}`);
				if (latestCacheHitRate !== undefined) {
					statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				if (totalCost || (model && ctx.modelRegistry.isUsingOAuth(model))) {
					statsParts.push(`$${totalCost.toFixed(3)}`);
				}
				const statsStr = isShellMode() ? "shell" : statsParts.join(" ");
				const leftSide =
					theme.fg("dim", folderName) +
					` ${theme.fg("dim", "\u2022")} ` +
					theme.fg("dim", statsStr);
				let statsLeft = leftSide;
				if (visibleWidth(statsLeft) > innerWidth) {
					statsLeft = truncateToWidth(statsLeft, innerWidth, "...");
				}

				// --- Right side: Mode • model thinking-level provider tps ---
				const modeLabel = resolve_mode_label(getActiveModeId());
				const modelName = model?.name ?? model?.id ?? "no model";
				const provider = model?.provider ?? "unknown";
				const level = footerThinkingLevel;
				let displayName = modelName;
				let variant = "";
				if (level !== "off" && is_effort_slider_point(level)) {
					displayName = strip_for_family_grouping(modelName);
					variant = ` ${format_effort_display_label(level)}`;
				} else if (level !== "off" && !model_name_has_thinking_variant(modelName)) {
					variant = ` ${level}`;
				}
				const tps = getLiveTps();
				let tpsSegment = "";
				if (tps > 0) {
					const tpsStr =
						tps < 10 ? tps.toFixed(1) : tps < 100 ? tps.toFixed(0) : `${Math.round(tps)}`;
					const tpsColored =
						tps < 50
							? theme.fg("muted", `${tpsStr} tps`)
							: tps < 100
								? theme.fg("text", `${tpsStr} tps`)
								: liveAccentFg(`${tpsStr} tps`);
					tpsSegment = ` ${tpsColored}`;
				}
				const rightSide =
					liveAccentFg(modeLabel) +
					` ${theme.fg("dim", "\u2022")} ` +
					theme.fg("text", `${displayName}${variant}`) +
					theme.fg("dim", ` ${provider}`) +
					tpsSegment;
				const availableForRight = innerWidth - visibleWidth(statsLeft) - 2;
				const displayedRight =
					availableForRight > 0 ? truncateToWidth(rightSide, availableForRight, "") : "";
				const padding = " ".repeat(
					Math.max(0, innerWidth - visibleWidth(statsLeft) - visibleWidth(displayedRight)),
				);
				const statsLine = PAD + statsLeft + padding + displayedRight + PAD;

				return [statsLine];
			},
		};
	});
}
