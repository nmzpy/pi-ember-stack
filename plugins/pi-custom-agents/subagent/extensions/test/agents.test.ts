import { describe, expect, test } from "bun:test";
import { resolveAgent, type AgentConfig } from "../agents.ts";

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "",
		source: "bundled",
		filePath: `${name}.md`,
	};
}

describe("resolveAgent", () => {
	test("resolves names case-insensitively and trims whitespace", () => {
		const scout = makeAgent("Scout");

		expect(resolveAgent([scout], " scout ")).toBe(scout);
		expect(resolveAgent([scout], "SCOUT")).toBe(scout);
	});

	test("prefers an exact name when casing variants coexist", () => {
		const bundled = makeAgent("Scout");
		const custom = makeAgent("scout");

		expect(resolveAgent([bundled, custom], "scout")).toBe(custom);
	});

	test("returns undefined for an unknown or blank name", () => {
		const coder = makeAgent("Coder");

		expect(resolveAgent([coder], "reviewer")).toBeUndefined();
		expect(resolveAgent([coder], "   ")).toBeUndefined();
	});
});
