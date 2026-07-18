/**
 * /dcp manual [on|off|status|toggle]
 *
 * Toggles or sets manualMode at RUNTIME. When ON the LLM-callable `compress`
 * tool refuses autonomous invocation and nudges are silenced.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SessionState } from "../state.ts";

function notify(ctx: ExtensionCommandContext, msg: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(msg, type);
}

export function make_manual_command(state: SessionState) {
	return async function handle_manual(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const arg = args.trim().toLowerCase();
		if (arg === "status") {
			notify(
				ctx,
				`pi-dcp manual mode: ${state.manualMode ? "ON" : "off"} (runtime only — edit config.json to persist)`,
			);
			return;
		}
		if (arg === "on") state.manualMode = true;
		else if (arg === "off") state.manualMode = false;
		else if (arg === "" || arg === "toggle") state.manualMode = !state.manualMode;
		else {
			notify(
				ctx,
				`pi-dcp: unknown arg "${arg}" (expected on|off|status|toggle)`,
				"warning",
			);
			return;
		}
		notify(
			ctx,
			`pi-dcp manual mode: ${state.manualMode ? "ON" : "off"} (runtime only — edit config.json to persist)`,
		);
	};
}
