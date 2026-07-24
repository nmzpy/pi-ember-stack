import { describe, expect, test } from "bun:test";
import {
	BASH_RULE_QUIZ_OPTIONS,
	build_bash_rule_questions,
	command_matches_bash_rule,
	DEFAULT_BASH_RULES,
	find_matching_bash_rule,
	parse_bash_rules,
	resolve_bash_rule_answer,
} from "../bash-rules.ts";

describe("bash-rules", () => {
	test("parse_bash_rules accepts pattern: action strings", () => {
		expect(parse_bash_rules(["git checkout: ask", "git stash: ask"])).toEqual([
			{ pattern: "git checkout", action: "ask" },
			{ pattern: "git stash", action: "ask" },
		]);
	});

	test("command_matches_bash_rule uses word boundaries", () => {
		expect(command_matches_bash_rule("git checkout -- foo.ts", "git checkout")).toBe(true);
		expect(command_matches_bash_rule("git stash push -m x", "git stash")).toBe(true);
		expect(command_matches_bash_rule("git restore --staged foo.ts", "git restore")).toBe(true);
		expect(command_matches_bash_rule("echo not-git-checkout", "git checkout")).toBe(false);
	});

	test("find_matching_bash_rule returns first match", () => {
		const rule = find_matching_bash_rule("git checkout -- a.ts", [...DEFAULT_BASH_RULES]);
		expect(rule?.pattern).toBe("git checkout");
		expect(rule?.action).toBe("ask");
	});

	test("build_bash_rule_questions uses the shared quiz menu options", () => {
		const [question] = build_bash_rule_questions("git stash", {
			pattern: "git stash",
			action: "ask",
		});
		expect(question.options.map((option) => option.label)).toEqual(
			BASH_RULE_QUIZ_OPTIONS.map((option) => option.label),
		);
	});

	test("resolve_bash_rule_answer maps quiz choices", () => {
		expect(resolve_bash_rule_answer({ value: "execution", wasCustom: false })).toEqual({
			action: "execution",
		});
		expect(resolve_bash_rule_answer({ value: "allow", wasCustom: false })).toEqual({
			action: "allow",
		});
		expect(resolve_bash_rule_answer({ value: "deny", wasCustom: false })).toEqual({
			action: "deny",
		});
		expect(
			resolve_bash_rule_answer({
				value: "use apply_patch instead",
				wasCustom: true,
			}),
		).toEqual({
			action: "custom",
			instruction: "use apply_patch instead",
		});
		expect(resolve_bash_rule_answer(undefined)).toEqual({ action: "deny" });
	});
});
