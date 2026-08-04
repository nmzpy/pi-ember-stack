import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	type Http500RetryRollback,
	type SubAgentResult,
	type SubagentRetrySession,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	decide_pre_response_http500_retry,
	format_agent_tool_result_batch,
	format_agent_tool_result_text,
	get_agent_result_body,
	getResultOutput,
	is_empty_body_http500_error,
	isFailedResult,
	resolve_failure_message,
	resolve_subagent_timeout_ms,
	retryable_pre_response_http500_failure,
	rollback_failed_prompt_attempt,
	SUBAGENT_HTTP500_RETRY_BACKOFF_MS,
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

function userMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as Message;
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

/** Minimal append-only session-tree double used by the retry regression tests. */
class MiniSessionManager {
	entries: Array<{
		id: string;
		parentId: string | null;
		role: "user" | "assistant";
		text: string;
	}> = [];
	leafId: string | null = null;
	private seq = 0;

	getLeafId(): string | null {
		return this.leafId;
	}

	appendMessage(role: "user" | "assistant", text: string): string {
		const id = `entry-${++this.seq}`;
		this.entries.push({ id, parentId: this.leafId, role, text });
		this.leafId = id;
		return id;
	}

	branch(id: string): void {
		this.leafId = id;
	}

	resetLeaf(): void {
		this.leafId = null;
	}

	getBranch(): MiniSessionManager["entries"] {
		const out: MiniSessionManager["entries"] = [];
		let current = this.leafId;
		while (current) {
			const entry = this.entries.find((e) => e.id === current);
			if (!entry) break;
			out.unshift(entry);
			current = entry.parentId;
		}
		return out;
	}

	buildSessionContext(): { messages: Message[] } {
		return {
			messages: this.getBranch().map((entry) =>
				entry.role === "user"
					? userMessage(entry.text)
					: assistantMessage({ content: [{ type: "text", text: entry.text }] }),
			),
		};
	}
}

function makeRollback(overrides: Partial<Http500RetryRollback> = {}): Http500RetryRollback {
	return {
		retryAnchor: "pre-attempt-leaf",
		messagesBefore: 0,
		liveItemsBefore: 0,
		usageBefore: zeroUsage(),
		...overrides,
	};
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

describe("is_empty_body_http500_error", () => {
	test("matches the exact OpenAI empty-body 500", () => {
		expect(is_empty_body_http500_error("500 status code (no body)")).toBe(true);
		expect(is_empty_body_http500_error("  500 status code (no body)  ")).toBe(true);
	});

	test("matches the Devin-style GetChatMessage 500 only with no body", () => {
		expect(is_empty_body_http500_error("GetChatMessage HTTP 500:")).toBe(true);
		expect(is_empty_body_http500_error("GetChatMessage HTTP 500: ")).toBe(true);
	});

	test("rejects non-transient statuses and 500s with a useful body", () => {
		expect(is_empty_body_http500_error(undefined)).toBe(false);
		expect(is_empty_body_http500_error("")).toBe(false);
		expect(is_empty_body_http500_error("400 status code (no body)")).toBe(false);
		expect(is_empty_body_http500_error("401 Unauthorized: invalid api key")).toBe(false);
		expect(is_empty_body_http500_error("403 status code (no body)")).toBe(false);
		expect(is_empty_body_http500_error("404 Not Found")).toBe(false);
		expect(is_empty_body_http500_error("408 Request Timeout")).toBe(false);
		expect(is_empty_body_http500_error("409 Conflict")).toBe(false);
		expect(is_empty_body_http500_error("429 rate limit exceeded")).toBe(false);
		expect(is_empty_body_http500_error("503 Service Unavailable")).toBe(false);
		expect(is_empty_body_http500_error("billing: insufficient credits")).toBe(false);
		expect(is_empty_body_http500_error("invalid model id")).toBe(false);
		expect(is_empty_body_http500_error("500 internal server error")).toBe(false);
		expect(is_empty_body_http500_error("GetChatMessage HTTP 500: gateway timeout")).toBe(false);
		expect(is_empty_body_http500_error("GetChatMessage HTTP 500: internal error")).toBe(false);
	});
});

describe("retryable_pre_response_http500_failure", () => {
	test("true for a pure pre-response empty-body 500", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
			messages: [assistantMessage({ errorMessage: "500 status code (no body)" })],
		});
		expect(retryable_pre_response_http500_failure(result)).toBe(true);
	});

	test("true when the empty-body 500 lives on the assistant message only", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			messages: [assistantMessage({ errorMessage: "GetChatMessage HTTP 500:" })],
		});
		expect(retryable_pre_response_http500_failure(result)).toBe(true);
	});

	test("false when stopReason is not error", () => {
		for (const stopReason of ["aborted", "timeout", "length", "stop"] as const) {
			const result = makeResult({
				exitCode: 1,
				stopReason,
				errorMessage: "500 status code (no body)",
				messages: [assistantMessage({ errorMessage: "500 status code (no body)" })],
			});
			expect(retryable_pre_response_http500_failure(result)).toBe(false);
		}
	});

	test("false for non-transient statuses and auth/quota/billing/invalid-model errors", () => {
		const nonRetryable = [
			"401 Unauthorized: invalid api key",
			"403 Forbidden",
			"404 Not Found",
			"408 Request Timeout",
			"409 Conflict",
			"429 rate limit exceeded",
			"503 Service Unavailable",
			"billing: insufficient credits",
			"invalid model id",
			"500 internal server error",
			"GetChatMessage HTTP 500: oops",
		];
		for (const msg of nonRetryable) {
			const result = makeResult({
				exitCode: 1,
				stopReason: "error",
				errorMessage: msg,
				messages: [assistantMessage({ errorMessage: msg })],
			});
			expect(retryable_pre_response_http500_failure(result)).toBe(false);
		}
	});

	test("false after partial visible text", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
			messages: [
				assistantMessage({
					content: [{ type: "text", text: "Let me look" }],
					errorMessage: "500 status code (no body)",
				}),
			],
		});
		expect(retryable_pre_response_http500_failure(result)).toBe(false);
	});

	test("false after a tool call", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
			latestToolCall: { name: "read", args: { file_path: "a.ts" } },
			messages: [
				assistantMessage({
					content: [
						{
							type: "toolCall",
							id: "t1",
							name: "read",
							arguments: { file_path: "a.ts" },
						},
					],
					errorMessage: "500 status code (no body)",
				}),
			],
		});
		expect(retryable_pre_response_http500_failure(result)).toBe(false);
	});

	test("false after a live tool row", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
			liveItems: [
				{ kind: "tool", row: { name: "read", args: {}, completed: false, error: false } },
			],
			messages: [assistantMessage({ errorMessage: "500 status code (no body)" })],
		});
		expect(retryable_pre_response_http500_failure(result)).toBe(false);
	});
});

describe("decide_pre_response_http500_retry", () => {
	function makeRetrySession(options: { contextMessages?: Message[] } = {}): {
		session: SubagentRetrySession;
		calls: string[];
		agentMessages: AgentMessage[];
	} {
		const calls: string[] = [];
		const agentMessages: AgentMessage[] = [...(options.contextMessages ?? [])];
		const sessionManager = {
			getBranch: () => [
				{
					id: "root",
					type: "message",
					message: { role: "assistant" },
				},
			],
			branch: (id: string) => {
				calls.push(`branch:${id}`);
			},
			resetLeaf: () => {
				calls.push("resetLeaf");
			},
			buildSessionContext: () => ({ messages: options.contextMessages ?? [] }),
			getSessionFile: () => undefined,
		} as unknown as SubagentRetrySession["sessionManager"];
		return {
			session: { sessionManager, agent: { state: { messages: agentMessages } } },
			calls,
			agentMessages,
		};
	}

	test("returns retry and rolls back the failed turn once", async () => {
		const { session, calls, agentMessages } = makeRetrySession({
			contextMessages: [
				assistantMessage({ content: [{ type: "text", text: "prior answer" }] }),
			],
		});
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
			messages: [
				userMessage("do stuff"),
				assistantMessage({ errorMessage: "500 status code (no body)" }),
			],
			liveItems: [{ kind: "text", text: "" }],
			usage: { ...zeroUsage(), turns: 1 },
		});
		const decision = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			session,
			rollback: makeRollback({ messagesBefore: 0, liveItemsBefore: 0 }),
			backoffMs: 1,
		});
		expect(decision).toBe("retry");
		expect(result.stopReason).toBeUndefined();
		expect(result.errorMessage).toBeUndefined();
		// Failed user + assistant removed from the message cache and live buffer.
		expect(result.messages).toHaveLength(0);
		expect(result.liveItems ?? []).toHaveLength(0);
		// Usage/turn accounting restored to the pre-attempt snapshot.
		expect(result.usage).toEqual(zeroUsage());
		// Session branched back to the pre-attempt leaf; live agent transcript
		// resynced from the persisted branch (no stale failed assistant).
		expect(calls).toContain("branch:pre-attempt-leaf");
		expect(agentMessages).toEqual([
			assistantMessage({ content: [{ type: "text", text: "prior answer" }] }),
		]);
	});

	test("resets the leaf for a fresh session with no prior entries", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "GetChatMessage HTTP 500:",
			messages: [assistantMessage({ errorMessage: "GetChatMessage HTTP 500:" })],
		});
		const decision = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			session,
			rollback: makeRollback({ retryAnchor: null }),
			backoffMs: 1,
		});
		expect(decision).toBe("retry");
		expect(calls).toEqual(["resetLeaf"]);
	});

	test("second failure is never retried again", async () => {
		const { session } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
		});
		const first = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			session,
			rollback: makeRollback(),
			backoffMs: 1,
		});
		expect(first).toBe("retry");
		// The retried prompt fails again with the same transient error.
		result.stopReason = "error";
		result.errorMessage = "500 status code (no body)";
		result.messages = [assistantMessage({ errorMessage: "500 status code (no body)" })];
		const second = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: true,
			session,
			rollback: makeRollback(),
			backoffMs: 1,
		});
		expect(second).toBe("skip");
		expect(result.errorMessage).toBe("500 status code (no body)");
		expect(result.stopReason).toBe("error");
	});

	test("abort during backoff stops the retry without clearing the failure", async () => {
		const { session } = makeRetrySession();
		const controller = new AbortController();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
		});
		const decisionPromise = decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			signal: controller.signal,
			session,
			rollback: makeRollback(),
			backoffMs: SUBAGENT_HTTP500_RETRY_BACKOFF_MS * 10,
		});
		setTimeout(() => controller.abort(), 5);
		const decision = await decisionPromise;
		expect(decision).toBe("aborted");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("500 status code (no body)");
	});

	test("skip for non-eligible failures preserves the failure text", async () => {
		const { session } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "429 rate limit exceeded",
			messages: [assistantMessage({ errorMessage: "429 rate limit exceeded" })],
		});
		const decision = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			session,
			rollback: makeRollback(),
			backoffMs: 1,
		});
		expect(decision).toBe("skip");
		expect(result.errorMessage).toBe("429 rate limit exceeded");
		expect(result.messages).toHaveLength(1);
	});

	test("skip when already aborted", async () => {
		const { session } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "500 status code (no body)",
		});
		const decision = await decide_pre_response_http500_retry({
			result,
			aborted: true,
			http500_retried: false,
			session,
			rollback: makeRollback(),
			backoffMs: 1,
		});
		expect(decision).toBe("skip");
		expect(result.errorMessage).toBe("500 status code (no body)");
	});
});

describe("rollback_failed_prompt_attempt", () => {
	test("websocket-retry path restores session branch, agent transcript, and accounting", () => {
		const sm = new MiniSessionManager();
		sm.appendMessage("user", "first task");
		sm.appendMessage("assistant", "answer");
		const agent = { state: { messages: [...sm.buildSessionContext().messages] } };
		const result = makeResult({
			exitCode: -1,
			messages: [...agent.state.messages],
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.01,
				contextTokens: 900,
				turns: 1,
			},
		});
		const rollback: Http500RetryRollback = {
			retryAnchor: sm.getLeafId(),
			messagesBefore: result.messages.length,
			liveItemsBefore: 0,
			usageBefore: { ...result.usage },
		};

		// Simulate the failed prompt appending user#2 + failed assistant to both
		// the persisted tree and the live agent transcript.
		sm.appendMessage("user", "second task");
		sm.appendMessage("assistant", "");
		agent.state.messages = [
			...agent.state.messages,
			userMessage("second task"),
			assistantMessage({ errorMessage: "socket hang up" }),
		];
		result.messages = [...agent.state.messages];
		result.stopReason = "error";
		result.errorMessage = "socket hang up";

		rollback_failed_prompt_attempt(
			result,
			{ sessionManager: sm, agent } as unknown as SubagentRetrySession,
			rollback,
		);

		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(result.usage).toEqual(rollback.usageBefore);
		// Active branch and live transcript are back at the pre-attempt state.
		expect(sm.getBranch().map((e) => e.text)).toEqual(["first task", "answer"]);
		expect(agent.state.messages).toEqual(sm.buildSessionContext().messages);
	});
});

describe("retry regression: no duplicate user prompt or failed assistant context", () => {
	test("a failed HTTP 500 attempt is rolled back so the retry re-sends the task exactly once", async () => {
		const sm = new MiniSessionManager();
		sm.appendMessage("user", "prior task");
		sm.appendMessage("assistant", "completed answer");
		const agent = { state: { messages: [...sm.buildSessionContext().messages] } };
		const result = makeResult({
			exitCode: -1,
			messages: [...agent.state.messages],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.1,
				contextTokens: 1500,
				turns: 1,
			},
		});
		const rollback: Http500RetryRollback = {
			retryAnchor: sm.getLeafId(),
			messagesBefore: result.messages.length,
			liveItemsBefore: result.liveItems?.length ?? 0,
			usageBefore: { ...result.usage },
		};

		// First attempt: prompt() appends user#1 + failed assistant to the session
		// tree and live agent transcript, and the failed message_end accounting ran.
		sm.appendMessage("user", "original task");
		sm.appendMessage("assistant", "");
		agent.state.messages = [
			...agent.state.messages,
			userMessage("original task"),
			assistantMessage({ errorMessage: "500 status code (no body)" }),
		];
		result.messages = [...agent.state.messages];
		result.stopReason = "error";
		result.errorMessage = "500 status code (no body)";
		expect(sm.getBranch().filter((e) => e.role === "user").map((e) => e.text)).toEqual([
			"prior task",
			"original task",
		]);

		const decision = await decide_pre_response_http500_retry({
			result,
			aborted: false,
			http500_retried: false,
			session: { sessionManager: sm, agent } as unknown as SubagentRetrySession,
			rollback,
			backoffMs: 1,
		});
		expect(decision).toBe("retry");

		// The active branch is back at the pre-attempt leaf: the failed user
		// message and failed assistant are abandoned, not duplicated.
		expect(sm.getBranch().map((e) => e.text)).toEqual(["prior task", "completed answer"]);
		expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(result.usage.turns).toBe(1);

		// Retry re-sends the same task: a fresh user prompt lands directly after
		// the completed assistant, so the original task text appears exactly once
		// on the active branch.
		sm.appendMessage("user", "original task");
		agent.state.messages = sm.buildSessionContext().messages;
		expect(sm.getBranch().map((e) => e.role)).toEqual(["user", "assistant", "user"]);
		expect(sm.getBranch().filter((e) => e.role === "user").map((e) => e.text)).toEqual([
			"prior task",
			"original task",
		]);
	});
});
