import { CompactRenderer } from "./renderer.ts";

let shared_renderer: CompactRenderer | null = null;

export function getSharedRenderer(): CompactRenderer {
	if (!shared_renderer) shared_renderer = new CompactRenderer();
	return shared_renderer;
}
