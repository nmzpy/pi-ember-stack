import { is_subagent_resume_tool, SUBAGENT_DELEGATION_TOOLS } from "./edit-tools.ts";

/** Bundled exploration agent — the only subagent allowed in plan mode. */
export const PLAN_MODE_SCOUT_AGENT = "scout";

const SUBAGENT_DELEGATION_TOOL_NAMES = new Set<string>(SUBAGENT_DELEGATION_TOOLS);

export function infer_bare_agent_name(displayName: string): string {
	const match = /^(.+?)\s+[A-Z]{1,2}$/.exec(displayName.trim());
	return match?.[1]?.trim() || displayName.trim();
}

export function is_scout_agent_name(agentName: string): boolean {
	return infer_bare_agent_name(agentName).localeCompare(PLAN_MODE_SCOUT_AGENT, undefined, {
		sensitivity: "accent",
	}) === 0;
}

function collect_subagent_agent_names(toolName: string, input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const params = input as Record<string, unknown>;
	if (is_subagent_resume_tool(toolName)) {
		return typeof params.agent === "string" ? [params.agent] : [];
	}
	if (toolName !== "subagent") return [];

	const names: string[] = [];
	if (typeof params.agent === "string") names.push(params.agent);
	for (const key of ["tasks", "chain"] as const) {
		const items = params[key];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			if (item && typeof item === "object" && typeof (item as { agent?: unknown }).agent === "string") {
				names.push((item as { agent: string }).agent);
			}
		}
	}
	return names;
}

export function validate_plan_mode_subagent(
	toolName: string,
	input: unknown,
): { block: true; reason: string } | undefined {
	if (!SUBAGENT_DELEGATION_TOOL_NAMES.has(toolName)) return undefined;
	const names = collect_subagent_agent_names(toolName, input);
	if (names.length === 0) return undefined;

	const disallowed = names.filter((name) => !is_scout_agent_name(name));
	if (disallowed.length === 0) return undefined;

	const quoted = [...new Set(disallowed.map((name) => `"${name.trim()}"`))].join(", ");
	return {
		block: true,
		reason: `Plan mode allows Scout subagent only for exploration. Disallowed agent(s): ${quoted}. Use agent "Scout" (or a lettered Scout name for subagent_resume, e.g. Scout A).`,
	};
}
