import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	type SubAgentResult,
	isFailedResult,
	resolve_failure_message,
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
