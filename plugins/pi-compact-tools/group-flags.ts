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
	setGroupThinkingChildActive(renderer.hasGroupThinkingChild());
	setGroupReopenableActive(isThinkingBlocksHidden() && renderer.hasReopenableGroup());
	syncThinkingGradientClock();
}
