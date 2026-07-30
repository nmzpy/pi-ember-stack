import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	type SubAgentResult,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	format_agent_tool_result_batch,
	format_agent_tool_result_text,
	get_agent_result_body,
	getResultOutput,
	isFailedResult,
	resolve_failure_message,
	resolve_subagent_timeout_ms,
} from "../runner.ts";

function makeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
	return {
		agent: "Coder",
		task: "do stuff",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		...overrides,
	};
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
	return {
		role: "assistant",
		content: [],
		...overrides,
	} as Message;
}

describe("resolve_subagent_timeout_ms", () => {
	test("undefined or invalid values use the 120s default", () => {
		expect(resolve_subagent_timeout_ms(undefined)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
		expect(resolve_subagent_timeout_ms(null)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
		expect(resolve_subagent_timeout_ms(0)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
		expect(resolve_subagent_timeout_ms(-1)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
		expect(resolve_subagent_timeout_ms(Number.NaN)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);
	});

	test("values below 1000 are treated as seconds", () => {
		expect(resolve_subagent_timeout_ms(120)).toBe(120_000);
		expect(resolve_subagent_timeout_ms(1)).toBe(1_000);
	});

	test("values at or above 1000 are treated as milliseconds", () => {
		expect(resolve_subagent_timeout_ms(120_000)).toBe(120_000);
		expect(resolve_subagent_timeout_ms(5_000)).toBe(5_000);
	});
});

describe("isFailedResult", () => {
	test("non-zero exit code is a failure", () => {
		expect(isFailedResult(makeResult({ exitCode: 1 }))).toBe(true);
	});

	test("zero exit code with no error stop reason is not a failure", () => {
		expect(isFailedResult(makeResult({ exitCode: 0, stopReason: "stop" }))).toBe(false);
	});

	test("error/aborted/timeout stop reasons are failures even with exit 0", () => {
		expect(isFailedResult(makeResult({ exitCode: 0, stopReason: "error" }))).toBe(true);
		expect(isFailedResult(makeResult({ exitCode: 0, stopReason: "aborted" }))).toBe(true);
		expect(isFailedResult(makeResult({ exitCode: 0, stopReason: "timeout" }))).toBe(true);
	});
});

describe("resolve_failure_message", () => {
	test("returns undefined for a successful result", () => {
		const result = makeResult({ exitCode: 0, stopReason: "stop" });
		expect(resolve_failure_message(result)).toBeUndefined();
	});

	test("preserves a real provider errorMessage", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid api key",
		});
		expect(resolve_failure_message(result)).toBe("401 Unauthorized: invalid api key");
	});

	test("falls back to last assistant errorMessage when top-level is generic abort", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "This operation was aborted",
			messages: [
				assistantMessage({ errorMessage: "Request failed with status 500" }),
			],
		});
		expect(resolve_failure_message(result)).toBe("Request failed with status 500");
	});

	test("falls back to stderr when no errorMessage is useful", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "aborted",
			stderr: "node: out of memory",
		});
		expect(resolve_failure_message(result)).toBe("node: out of memory");
	});

	test("falls back to last assistant text output when nothing else is available", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			messages: [
				assistantMessage({
					content: [{ type: "text", text: "I could not complete the task" }],
				}),
			],
		});
		expect(resolve_failure_message(result)).toBe("I could not complete the task");
	});

	test("returns undefined when no useful text exists (caller falls back to short label)", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "aborted",
			messages: [],
		});
		expect(resolve_failure_message(result)).toBeUndefined();
	});

	test("skips generic abort messages in assistant history", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "operation was aborted",
			messages: [
				assistantMessage({ errorMessage: "Request was aborted" }),
				assistantMessage({ errorMessage: "the operation was aborted" }),
			],
		});
		expect(resolve_failure_message(result)).toBeUndefined();
	});

	test("picks the most recent non-generic assistant errorMessage", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "aborted",
			messages: [
				assistantMessage({ errorMessage: "old network error" }),
				assistantMessage({ errorMessage: "Request was aborted" }),
				assistantMessage({ errorMessage: "429 rate limit exceeded" }),
			],
		});
		expect(resolve_failure_message(result)).toBe("429 rate limit exceeded");
	});
});

describe("format_agent_tool_result_text", () => {
	test("getResultOutput uses the resolved provider failure reason", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "This operation was aborted",
			messages: [assistantMessage({ errorMessage: "503 Service Unavailable" })],
		});
		expect(getResultOutput(result)).toBe("503 Service Unavailable");
	});

	test("includes lettered agent label for completed results", () => {
		const result = makeResult({
			agent: "Coder A",
			exitCode: 0,
			stopReason: "stop",
			messages: [
				assistantMessage({
					content: [{ type: "text", text: "Done." }],
				}),
			],
		});
		expect(format_agent_tool_result_text(result)).toBe(
			"### [Coder A] completed\n\nDone.",
		);
	});

	test("includes failed status and error body", () => {
		const result = makeResult({
			agent: "Scout B",
			exitCode: 1,
			stopReason: "error",
			errorMessage: "401 Unauthorized",
		});
		expect(format_agent_tool_result_text(result)).toBe(
			"### [Scout B] failed (error)\n\n401 Unauthorized",
		);
	});

	test("running placeholder uses running status", () => {
		const result = makeResult({ agent: "Coder A", exitCode: -1 });
		expect(get_agent_result_body(result)).toBe("(running...)");
		expect(format_agent_tool_result_text(result)).toBe(
			"### [Coder A] running\n\n(running...)",
		);
	});

	test("format_body hook can truncate parallel output", () => {
		const result = makeResult({
			agent: "Coder A",
			exitCode: 0,
			stopReason: "stop",
			messages: [
				assistantMessage({
					content: [{ type: "text", text: "long output" }],
				}),
			],
		});
		const formatted = format_agent_tool_result_text(result, (body) => `${body.slice(0, 4)}…`);
		expect(formatted).toBe("### [Coder A] completed\n\nlong…");
	});
});

describe("format_agent_tool_result_batch", () => {
	test("joins labeled summaries with header and separator", () => {
		const results = [
			makeResult({
				agent: "Coder A",
				exitCode: 0,
				stopReason: "stop",
				messages: [
					assistantMessage({ content: [{ type: "text", text: "A done" }] }),
				],
			}),
			makeResult({
				agent: "Coder B",
				exitCode: 0,
				stopReason: "stop",
				messages: [
					assistantMessage({ content: [{ type: "text", text: "B done" }] }),
				],
			}),
		];
		expect(
			format_agent_tool_result_batch(results, { header: "Parallel: 2/2 succeeded" }),
		).toBe(
			"Parallel: 2/2 succeeded\n\n### [Coder A] completed\n\nA done\n\n---\n\n### [Coder B] completed\n\nB done",
		);
	});
});
