import {
	isThinkingBlocksHidden,
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	setToolGroupActive,
} from "../pi-ember-ui/mode-colors.ts";
import { syncThinkingGradientClock } from "../pi-ember-ui/index.ts";
import type { CompactRenderer } from "./renderer.ts";

/** Sync compact-group flags into mode-colors — SSOT for lifecycle handlers. */
export function sync_compact_group_flags(renderer: CompactRenderer): void {
	setToolGroupActive(renderer.hasActiveGroups());
	// Scan-based: ANY armed/painted in-group Thinking lane suppresses the
	// external hosts, not just the live group's. A painted lane that outlives
	// the currentGroup pointer (rebuild race, settle/arm ordering) must still
	// win the Thinking slot when blocks are hidden.
	setGroupThinkingChildActive(renderer.hasAnyGroupThinkingChild());
	setGroupReopenableActive(isThinkingBlocksHidden() && renderer.hasReopenableGroup());
	syncThinkingGradientClock();
}
