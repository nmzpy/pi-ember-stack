/**
 * Subagent child-session bash rules enforcement.
 *
 * Mirrors the parent `pi-custom-agents/bash-rules.ts` logic using a
 * per-session `WeakMap` so concurrent subagent sessions do not share a
 * single `rules` array. Loaded into every subagent child session by
 * `runner.ts` so delegated bash commands respect `git checkout`, `git stash`,
 * and `git restore` (and any user-defined) rules exactly like the main agent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	allow_pattern_for_session,
	find_matching_bash_rule,
	load_bash_rules,
	prompt_bash_rule_approval,
	type BashRule,
} from "./bash-rules.ts";

const rulesByContext = new WeakMap<ExtensionContext, BashRule[]>();

function get_rules(ctx: ExtensionContext): BashRule[] {
	let rules = rulesByContext.get(ctx);
	if (rules === undefined) {
		rules = load_bash_rules({
			cwd: ctx.cwd,
			is_project_trusted: () => ctx.isProjectTrusted(),
		});
		rulesByContext.set(ctx, rules);
	}
	return rules;
}

function update_rules(ctx: ExtensionContext, rules: BashRule[]): void {
	rulesByContext.set(ctx, rules);
}

export default function install_subagent_bash_rules(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		get_rules(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return undefined;

		const rules = get_rules(ctx);
		const rule = find_matching_bash_rule(command, rules);
		if (!rule || rule.action === "allow") return undefined;

		if (rule.action === "deny") {
			return { block: true, reason: `Blocked by bash rule (${rule.pattern}: deny)` };
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Blocked by bash rule (${rule.pattern}: ask; no UI for confirmation)`,
			};
		}

		const decision = await prompt_bash_rule_approval(ctx, command, rule);
		if (decision.action === "allow") {
			update_rules(ctx, allow_pattern_for_session(rules, rule.pattern));
		}
		if (decision.action === "execution" || decision.action === "allow") {
			return undefined;
		}
		if (decision.action === "custom") {
			return {
				block: true,
				reason: `Blocked by user (${rule.pattern}: ask): ${decision.instruction}`,
			};
		}
		ctx.abort();
		return { block: true, reason: `Blocked by user (${rule.pattern}: deny)` };
	});
}
