import { afterEach, describe, expect, test } from "bun:test";
import { isThinkingBlocksHidden, setThinkingBlocksHidden } from "../../../../pi-ember-ui/mode-colors.ts";
import {
	apply_subagent_group_stream_boundary,
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

	test("streaming partial-args calls join the same batch (no Delegating spam)", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		// Call a streaming with the brace not closed: args have agent only.
		renderer.register("a", { agent: "Coder" }, []);
		renderer.register("b", {}, []);
		renderer.register("c", { agent: "Scout" }, []);

		expect(renderer.shouldUseGroupLayout("a")).toBe(true);
		expect(renderer.isOwner("a")).toBe(true);
		expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);

		// Args close for a: it stays in the batch once recognized as single-mode.
		renderer.register("a", { agent: "Coder", task: "one" }, [makeResult("Coder", -1)]);
		expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
	});

	test("streaming call that closes as native parallel ejects from the singles batch", () => {
		const renderer = getSubagentGroupRenderer();
		renderer.resetForSession();

		renderer.register("a", { agent: "Coder", task: "one" }, [makeResult("Coder", -1)]);
		// b starts streaming (unknown args), joins the group...
		renderer.register("b", {}, []);
		expect(renderer.shouldUseGroupLayout("a")).toBe(true);
		// ...then closes with parallel tasks: it must be ejected, not absorbed.
		renderer.register(
			"b",
			{ tasks: [{ agent: "Coder", task: "x" }, { agent: "Scout", task: "y" }] },
			[makeResult("Coder", -1), makeResult("Scout", -1)],
		);
		expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
		expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
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

	describe("apply_subagent_group_stream_boundary (live visible-thinking boundary)", () => {
		afterEach(() => {
			setThinkingBlocksHidden(false);
		});

		test("visible thinking_start hard-exits so the next call starts a fresh batch", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);
			expect(renderer.shouldUseGroupLayout("a")).toBe(true);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "thinking_start" },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.shouldUseGroupLayout("c")).toBe(false);
			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["c"]);
			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
		});

		test("visible thinking_delta hard-exits the same way", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "thinking_delta" },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["c"]);
		});

		test("hidden thinking does not split the batch (streaming collapse preserved)", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(true);
			expect(isThinkingBlocksHidden()).toBe(true);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "thinking_start" },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.shouldUseGroupLayout("a")).toBe(true);
			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		});

		test("hidden assistant messages never split on their thinking", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(renderer, { type: "thinking_delta" }, {
				role: "assistant",
				display: false,
			});
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		});

		test("bare text_start / empty text_delta never split", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "text_start" },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);

			// Whitespace-only deltas carry no visible content either.
			const renderer2 = getSubagentGroupRenderer();
			renderer2.resetForSession();
			renderer2.register("a", { agent: "Coder", task: "one" }, []);
			renderer2.register("b", { agent: "Coder", task: "two" }, []);
			apply_subagent_group_stream_boundary(
				renderer2,
				{ type: "text_delta", delta: "   \n" },
				{ role: "assistant" },
			);
			renderer2.register("c", { agent: "Coder", task: "three" }, []);
			expect(renderer2.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		});

		test("visible non-empty text_delta hard-exits so the next call starts a fresh batch", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);
			expect(renderer.shouldUseGroupLayout("a")).toBe(true);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "text_delta", delta: "Wrapper PTS fix landed. Next: renderer instant-start." },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.shouldUseGroupLayout("c")).toBe(false);
			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["c"]);
			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
		});

		test("hidden assistant message text never splits", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(renderer, { type: "text_delta", delta: "resume..." }, {
				role: "assistant",
				display: false,
			});
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		});

		test("other non-text, non-thinking events never split", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			renderer.register("a", { agent: "Coder", task: "one" }, []);
			renderer.register("b", { agent: "Coder", task: "two" }, []);

			apply_subagent_group_stream_boundary(
				renderer,
				{ type: "toolcall_start" },
				{ role: "assistant" },
			);
			renderer.register("c", { agent: "Coder", task: "three" }, []);

			expect(renderer.getBatch("c").map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
		});
	});

	describe("seed_subagent_renderer_from_branch (visible-thinking seed split)", () => {
		afterEach(() => {
			setThinkingBlocksHidden(false);
		});

		test("visible non-empty thinking between two subagent calls splits their batches", () => {
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
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
			expect(renderer.shouldUseGroupLayout("b")).toBe(false);
		});

		test("visible thinking inside the same message splits a following tool call", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([
					subagentToolCall("a", "Coder"),
					{ type: "thinking", thinking: "reconsidering" },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
		});

		test("hidden thinking keeps historical subagent calls batched", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(true);

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

			expect(renderer.shouldUseGroupLayout("a")).toBe(true);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["a", "b"]);
		});

		test("empty visible thinking parts do not split historical batches", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([
					{ type: "thinking", thinking: "" },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.shouldUseGroupLayout("a")).toBe(true);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["a", "b"]);
		});

		test("visible non-empty text between two subagent calls splits their batches", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([
					{ type: "text", text: "Wrapper PTS fix landed. Next: renderer instant-start." },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
			expect(renderer.shouldUseGroupLayout("b")).toBe(false);
		});

		test("visible text inside the same message splits a following tool call", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([
					subagentToolCall("a", "Coder"),
					{ type: "text", text: "continuing between waves" },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
		});

		test("empty text parts do not split historical batches", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry([
					{ type: "text", text: "   " },
					subagentToolCall("b", "Scout"),
				]),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.shouldUseGroupLayout("a")).toBe(true);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["a", "b"]);
		});

		test("hidden assistant message text keeps historical subagent calls batched", () => {
			const renderer = getSubagentGroupRenderer();
			renderer.resetForSession();
			setThinkingBlocksHidden(false);

			const branch = [
				assistantEntry([subagentToolCall("a", "Coder")]),
				toolResultEntry("subagent", "a", [makeResult("Coder A", 0)]),
				assistantEntry(
					[
						{ type: "text", text: "resume from checkpoint" },
						subagentToolCall("b", "Scout"),
					],
					{ display: false },
				),
				toolResultEntry("subagent", "b", [makeResult("Scout A", 0)]),
			];
			seed_subagent_renderer_from_branch(branch, renderer);

			expect(renderer.shouldUseGroupLayout("a")).toBe(true);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["a", "b"]);
		});

		test("user message still hard-splits historical batches", () => {
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

			expect(renderer.getBatch("a").map((m) => m.toolCallId)).toEqual(["a"]);
			expect(renderer.getBatch("b").map((m) => m.toolCallId)).toEqual(["b"]);
		});
	});
});
