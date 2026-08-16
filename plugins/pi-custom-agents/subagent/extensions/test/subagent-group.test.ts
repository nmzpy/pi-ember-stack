import { afterEach, describe, expect, test } from "bun:test";
import { isThinkingBlocksHidden, setThinkingBlocksHidden } from "../../../../pi-ember-ui/mode-colors.ts";
import {
	getSubagentGroupRenderer,
	has_live_nested_preview,
	seed_subagent_renderer_from_branch,
	should_keep_existing_subagent_results,
} from "../subagent-group.ts";

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

function assistantEntry(content: any[], overrides: Record<string, unknown> = {}) {
	return { type: "message", message: { role: "assistant", content, ...overrides } } as any;
}

function toolResultEntry(name: string, id: string, results: any[]) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: name,
			toolCallId: id,
			details: { results },
		},
	} as any;
}

function subagentToolCall(id: string, agent: string) {
	return { type: "toolCall", id, name: "subagent", arguments: { agent, task: `task ${id}` } };
}

describe("SubagentGroupRenderer", () => {
	test("every call is its own owner record (no cross-call batching)", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const a = renderer.register("a", { agent: "Coder", task: "one" }, []);
		const b = renderer.register("b", { agent: "Coder", task: "two" }, [makeResult("Coder A", -1)]);

		// Consecutive single-mode calls never share a batch: each record is
		// independent so every call renders its own direct agent block.
		expect(renderer.getRecord("a")).toBe(a);
		expect(renderer.getRecord("b")).toBe(b);
		expect(a).not.toBe(b);
		expect(a.toolCallId).toBe("a");
		expect(b.toolCallId).toBe("b");
	});

	test("parallel args stay isolated per tool call", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const a = renderer.register(
			"a",
			{ tasks: [{ agent: "Coder", task: "one" }, { agent: "Scout", task: "two" }] },
			[makeResult("Coder A", -1), makeResult("Scout A", -1)],
		);
		const b = renderer.register("b", { agent: "Coder", task: "solo" }, []);

		expect(renderer.getRecord("a")).toBe(a);
		expect(renderer.getRecord("b")).toBe(b);
		expect(a.results.length).toBe(2);
	});

	test("register updates the same record in place on rebuild", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const invalidate = () => {};
		const record = renderer.register("a", { agent: "Coder", task: "one" }, [], invalidate);
		const rebound = renderer.register("a", { agent: "Coder", task: "one" }, [], invalidate);
		expect(rebound).toBe(record);
		expect(rebound.invalidate).toBe(invalidate);
	});

	test("register preserves populated results across empty rebuild placeholder", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const results = [makeResult("Coder A", 0)];
		renderer.register("a", { agent: "Coder", task: "one" }, results);
		renderer.register("a", { agent: "Coder", task: "one" }, []);

		expect(renderer.getRecord("a")?.results).toEqual(results);
	});

	test("register keeps live nested preview over stale context.state snapshot", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const live = [
			{
				...makeResult("Coder A", -1),
				isThinking: true,
				reasoning: true,
			},
		];
		const stale = [makeResult("Coder A", -1)];
		renderer.register("a", { agent: "Coder", task: "one" }, live);
		renderer.register("a", { agent: "Coder", task: "one" }, stale);

		expect(renderer.getRecord("a")?.results).toEqual(live);
		expect(has_live_nested_preview(renderer.getRecord("a")?.results ?? [])).toBe(true);
		expect(should_keep_existing_subagent_results(live, stale)).toBe(true);
	});

	test("rebuild preserves finishing over an empty live snapshot", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		const finishing = [
			{
				...makeResult("Coder A", -1),
				toolCallId: "member-0",
				isFinishing: true,
			},
		];
		renderer.register("call", { agent: "Coder", task: "one" }, finishing);
		renderer.register("call", { agent: "Coder", task: "one" }, []);

		expect(renderer.getRecord("call")?.results).toEqual(finishing);
		expect(has_live_nested_preview(renderer.getRecord("call")?.results ?? [])).toBe(true);
	});

	test("authoritative settled false clears stale finishing on rebuild", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register("call", { agent: "Coder", task: "one" }, [
			{ ...makeResult("Coder A", -1), toolCallId: "member-0", isFinishing: true },
		]);
		renderer.register("call", { agent: "Coder", task: "one" }, [
			{ ...makeResult("Coder A", 0), toolCallId: "member-0", isFinishing: false },
		]);

		expect(renderer.getRecord("call")?.results[0]?.isFinishing).toBe(false);
	});

	test("display names are stored per call and reset with the session", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register("a", { agent: "Coder", task: "one" }, []);
		renderer.setDisplayName("a", "Coder A");
		expect(renderer.getRecord("a")?.displayName).toBe("Coder A");

		renderer.resetForSession();
		expect(renderer.getRecord("a")).toBeUndefined();
	});

	describe("seed_subagent_renderer_from_branch (record-only rebuild seeding)", () => {
		afterEach(() => {
			setThinkingBlocksHidden(false);
		});

		test("registers one record per subagent call regardless of boundaries", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([
					{ type: "thinking", thinking: "let me reason about the next step" },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
				assistantEntry([{ type: "text", text: "narration between waves" }, subagentToolCall("c", "Coder")]),
				toolResultEntry("subagent", "c", [makeResult("Coder B", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			// Every call is its own independent record — visible thinking and
			// streamed text between calls never merge or split anything.
			expect(renderer.getRecord("a")?.args.agent).toBe("Coder");
			expect(renderer.getRecord("b")?.args.agent).toBe("Scout");
			expect(renderer.getRecord("c")?.args.agent).toBe("Coder");
			expect(renderer.getRecord("a")?.results[0]?.agent).toBe("Coder A");
			expect(renderer.getRecord("b")?.results[0]?.agent).toBe("Scout A");
			expect(renderer.getRecord("c")?.results[0]?.agent).toBe("Coder B");
		});

		test("hidden thinking still seeds independent records", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(true);
			expect(isThinkingBlocksHidden()).toBe(true);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([
					{ type: "thinking", thinking: "hidden reasoning" },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getRecord("a")?.args.agent).toBe("Coder");
			expect(renderer.getRecord("b")?.args.agent).toBe("Scout");
		});

		test("user messages never merge records — each call stays independent", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "go on" }] } } as any,
				assistantEntry([subagentToolCall("b", "Scout")]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getRecord("a")?.results[0]?.agent).toBe("Coder A");
			expect(renderer.getRecord("b")?.results[0]?.agent).toBe("Scout A");
		});

		test("non-subagent tool calls between delegations keep records independent", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([{ type: "toolCall", id: "x", name: "grep", arguments: { pattern: "foo" } }]),
				{ type: "message", message: { role: "toolResult", toolName: "grep", toolCallId: "x", details: {} } } as any,
				assistantEntry([subagentToolCall("b", "Scout")]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getRecord("a")).toBeDefined();
			expect(renderer.getRecord("b")).toBeDefined();
			expect(renderer.getRecord("x")).toBeUndefined();
		});

		test("calls without results still get an args record (live partials recover)", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();

			const branch = [assistantEntry([subagentToolCall("a", "Coder")])];
			seed_subagent_renderer_from_branch(branch, renderer);

			const record = renderer.getRecord("a");
			expect(record?.args.agent).toBe("Coder");
			expect(record?.results).toEqual([]);
		});
	});
});
