import { describe, expect, test } from "bun:test";
import { getSubagentGroupRenderer } from "../subagent-group.ts";

function makeResult(agent: string, exitCode: number) {
	return {
		agent,
		task: "test",
		exitCode,
		messages: [] as any[],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	} as any;
}

describe("SubagentGroupRenderer", () => {
	test("consecutive single-mode calls share one batch", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register("a", { agent: "Coder", task: "one" }, []);
		renderer.register("b", { agent: "Coder", task: "two" }, [makeResult("Coder", -1)]);

		expect(renderer.shouldUseGroupLayout("a")).toBe(true);
		expect(renderer.isOwner("a")).toBe(true);
		expect(renderer.isOwner("b")).toBe(false);
		expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["a", "b"]);
	});

	test("non-subagent hard exit starts a fresh batch", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register("a", { agent: "Coder", task: "one" }, []);
		renderer.register("b", { agent: "Coder", task: "two" }, []);
		renderer.hardExit();
		renderer.register("c", { agent: "Coder", task: "three" }, []);

		expect(renderer.shouldUseGroupLayout("c")).toBe(false);
		expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["c"]);
	});

	test("native parallel tasks stay isolated per tool call", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register(
			"a",
			{ tasks: [{ agent: "Coder", task: "one" }, { agent: "Scout", task: "two" }] },
			[makeResult("Coder", -1), makeResult("Scout", -1)],
		);
		renderer.register("b", { agent: "Coder", task: "solo" }, []);

		expect(renderer.shouldUseGroupLayout("a")).toBe(false);
		expect(renderer.shouldUseGroupLayout("b")).toBe(false);
	});
});
