import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { create_dcp_runtime, wire_dcp, DCP_SUBAGENT_WIRE_OPTIONS } from "../lib/wiring.ts";

function make_mock_pi(): ExtensionAPI & {
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	tools: Array<{ name: string }>;
	commands: string[];
} {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const tools: Array<{ name: string }> = [];
	const commands: string[] = [];
	return {
		handlers,
		tools,
		commands,
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as ExtensionAPI & {
		handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
		tools: Array<{ name: string }>;
		commands: string[];
	};
}

describe("subagent DCP wiring", () => {
	test("subagent profile registers context pipeline without compress tool or /dcp", () => {
		const pi = make_mock_pi();
		const runtime = create_dcp_runtime(process.cwd());
		runtime.config = {
			...runtime.config,
			enabled: true,
			compress: { ...runtime.config.compress, permission: "allow" },
		};
		wire_dcp(pi, runtime, DCP_SUBAGENT_WIRE_OPTIONS);
		expect(pi.handlers.has("context")).toBe(true);
		expect(pi.handlers.has("turn_start")).toBe(true);
		expect(pi.handlers.has("tool_result")).toBe(true);
		expect(pi.handlers.has("before_agent_start")).toBe(false);
		expect(pi.tools.some((tool) => tool.name === "compress")).toBe(false);
		expect(pi.commands).not.toContain("dcp");
	});
});
