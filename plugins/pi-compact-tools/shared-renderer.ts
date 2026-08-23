import { CompactRenderer } from "./renderer.ts";

let shared_renderer: CompactRenderer | null = null;

/**
 * Jiti can retain a singleton created by an older extension evaluation across
 * `/reload`. Rebuild that stale instance before a newer UI seam calls a method
 * it cannot provide; otherwise the render path crashes instead of recovering
 * at the normal session boundary.
 */
function is_current_renderer(value: CompactRenderer | null): value is CompactRenderer {
	return value !== null && typeof value.hasReopenableGroup === "function";
}

export function getSharedRenderer(): CompactRenderer {
	if (!is_current_renderer(shared_renderer)) shared_renderer = new CompactRenderer();
	return shared_renderer;
}
