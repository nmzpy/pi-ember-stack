import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCursorToolShims } from "./cursor-shims.js";
import { registerCustomXaiTools } from "./custom-tools.js";

const xaiToolRegistrations = new WeakSet<object>();

/** Register all xAI tools once per pi API object. */
export function registerXaiTools(pi: ExtensionAPI) {
	if (xaiToolRegistrations.has(pi as object)) return;
	xaiToolRegistrations.add(pi as object);

	registerCursorToolShims(pi);
	registerCustomXaiTools(pi);
}
