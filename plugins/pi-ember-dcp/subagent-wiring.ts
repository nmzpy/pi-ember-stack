/**
 * Minimal DCP wiring for in-process subagent child sessions.
 * Strategies only — no compress tool, /dcp commands, skills, or disk persistence.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	create_dcp_runtime,
	DCP_SUBAGENT_WIRE_OPTIONS,
	is_dcp_enabled_for_subagent,
	wire_dcp,
} from "./lib/wiring.ts";

/** Build an inline extension factory bound to the subagent workspace cwd. */
export function create_subagent_dcp_extension(cwd: string): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		if (!is_dcp_enabled_for_subagent(cwd)) return;
		const runtime = create_dcp_runtime(cwd);
		wire_dcp(pi, runtime, DCP_SUBAGENT_WIRE_OPTIONS);
	};
}

/**
 * Path-loadable default export. Defers wiring to session_start so cwd comes
 * from the child session (not process.cwd() at jiti load time).
 */
export default function piEmberDcpSubagentWiring(pi: ExtensionAPI): void {
	let wired = false;
	pi.on("session_start", (_event, ctx) => {
		if (wired) return;
		if (!is_dcp_enabled_for_subagent(ctx.cwd)) return;
		const runtime = create_dcp_runtime(ctx.cwd);
		wire_dcp(pi, runtime, DCP_SUBAGENT_WIRE_OPTIONS);
		wired = true;
	});
}
