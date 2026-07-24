import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askQuiz, type QuizQuestion } from "./quiz-tool.ts";

export type BashRuleAction = "ask" | "allow" | "deny";

export interface BashRule {
	pattern: string;
	action: BashRuleAction;
}

export type BashRuleDecision =
	| { action: "execution" }
	| { action: "allow" }
	| { action: "deny" }
	| { action: "custom"; instruction: string };

/** Quiz options for bashRules `ask` prompts (None is appended by askQuiz). */
export const BASH_RULE_QUIZ_OPTIONS = [
	{
		value: "execution",
		label: "Execution",
		description: "Run this command once.",
	},
	{
		value: "allow",
		label: "Allow",
		description: "Run now and stop asking for this pattern this session.",
	},
	{
		value: "deny",
		label: "Deny",
		description: "Block this command.",
	},
] as const;

/** Used when `bashRules` is absent from settings (global and project). */
export const DEFAULT_BASH_RULES: readonly BashRule[] = [
	{ pattern: "git checkout", action: "ask" },
	{ pattern: "git stash", action: "ask" },
	{ pattern: "git restore", action: "ask" },
];

function get_agent_dir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function read_settings_file(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function parse_bash_rule(entry: string): BashRule | undefined {
	const trimmed = entry.trim();
	if (!trimmed) return undefined;
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0) return undefined;
	const pattern = trimmed.slice(0, colon).trim();
	const action = trimmed.slice(colon + 1).trim().toLowerCase();
	if (!pattern) return undefined;
	if (action !== "ask" && action !== "allow" && action !== "deny") return undefined;
	return { pattern, action };
}

export function parse_bash_rules(entries: unknown): BashRule[] {
	if (!Array.isArray(entries)) {
		throw new Error("bashRules must be an array of strings");
	}
	const rules: BashRule[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const rule = parse_bash_rule(entry);
		if (rule) rules.push(rule);
	}
	return rules;
}

export function load_bash_rules(opts: {
	cwd: string;
	is_project_trusted: () => boolean;
}): BashRule[] {
	const global = read_settings_file(join(get_agent_dir(), "settings.json"));
	const project = opts.is_project_trusted()
		? read_settings_file(join(opts.cwd, ".pi", "settings.json"))
		: {};
	const raw = Object.hasOwn(project, "bashRules") ? project.bashRules : global.bashRules;
	if (raw === undefined) return [...DEFAULT_BASH_RULES];
	return parse_bash_rules(raw);
}

function escape_regex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function command_matches_bash_rule(command: string, pattern: string): boolean {
	const re = new RegExp(`\\b${escape_regex(pattern)}\\b`, "i");
	return re.test(command.trim());
}

export function find_matching_bash_rule(command: string, rules: BashRule[]): BashRule | undefined {
	for (const rule of rules) {
		if (command_matches_bash_rule(command, rule.pattern)) return rule;
	}
	return undefined;
}

export function resolve_bash_rule_answer(
	answer: { value: string; wasCustom: boolean } | undefined,
): BashRuleDecision {
	if (!answer) return { action: "deny" };
	if (answer.wasCustom && answer.value.trim()) {
		return { action: "custom", instruction: answer.value.trim() };
	}
	if (answer.value === "execution") return { action: "execution" };
	if (answer.value === "allow") return { action: "allow" };
	if (answer.value === "deny") return { action: "deny" };
	return { action: "deny" };
}

export function build_bash_rule_questions(command: string, rule: BashRule): QuizQuestion[] {
	return [
		{
			id: "bash-rule",
			label: rule.pattern,
			prompt: `Matched bash rule ${rule.pattern}: ask\n\n  ${command}`,
			options: BASH_RULE_QUIZ_OPTIONS.map((option) => ({ ...option })),
		},
	];
}

export async function prompt_bash_rule_approval(
	ctx: ExtensionContext,
	command: string,
	rule: BashRule,
): Promise<BashRuleDecision> {
	const answers = await askQuiz(ctx, "Bash Command", build_bash_rule_questions(command, rule));
	return resolve_bash_rule_answer(answers?.[0]);
}

function allow_pattern_for_session(rules: BashRule[], pattern: string): BashRule[] {
	return rules.map((rule) =>
		rule.pattern === pattern ? { ...rule, action: "allow" as const } : rule,
	);
}

export function install_bash_rules(pi: ExtensionAPI): void {
	let rules: BashRule[] = [...DEFAULT_BASH_RULES];

	pi.on("session_start", (_event, ctx) => {
		rules = load_bash_rules({
			cwd: ctx.cwd,
			is_project_trusted: () => ctx.isProjectTrusted(),
		});
	});

	pi.on("session_shutdown", () => {
		rules = [...DEFAULT_BASH_RULES];
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = typeof event.input?.command === "string" ? event.input.command : "";
		if (!command) return undefined;

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
			rules = allow_pattern_for_session(rules, rule.pattern);
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
		return { block: true, reason: `Blocked by user (${rule.pattern}: deny)` };
	});
}
