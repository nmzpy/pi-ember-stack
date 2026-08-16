import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type Http500RetryRollback,
	type SubAgentResult,
	type SubagentPromptAttempt,
	type SubagentRetrySession,
	MAX_SUBAGENT_WEBSOCKET_RETRIES,
	classify_safe_pre_response_failure,
	decide_pre_response_websocket_retry,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	annotate_parser_stream_error,
	decide_pre_response_http500_retry,
	extractFailureMessage,
	format_agent_tool_result_batch,
	format_agent_tool_result_text,
	getFinalOutput,
	get_agent_result_body,
	getResultOutput,
	is_empty_body_http500_error,
	isFailedResult,
	is_parser_stream_error,
	merge_failure_message,
	note_subagent_prompt_attempt_event,
	PARSER_STREAM_ERROR_LIMITATION_SUFFIX,
	resolve_failure_message,
	resolve_subagent_timeout_ms,
	retryable_pre_response_http500_failure,
	rollback_failed_prompt_attempt,
	runSubAgent,
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

const RUNNER_WEBSOCKET_PROVIDER = "runner-websocket-test";
const RUNNER_WEBSOCKET_MODEL_ID = "runner-websocket-model";

const RUNNER_WEBSOCKET_MODEL = {
	id: RUNNER_WEBSOCKET_MODEL_ID,
	name: "Runner WebSocket Test Model",
	api: "openai-completions",
	provider: RUNNER_WEBSOCKET_PROVIDER,
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>;

function runner_assistant_message(options: {
	stopReason: "error" | "stop";
	errorMessage?: string;
	text?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-completions",
		provider: RUNNER_WEBSOCKET_PROVIDER,
		model: RUNNER_WEBSOCKET_MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason,
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

async function run_resolved_websocket_retry_fixture(options: { firstResponseText?: string } = {}): Promise<{
	result: SubAgentResult;
	streamCalls: number;
}> {
	const outcomes = [
		runner_assistant_message({
			stopReason: "error",
			errorMessage: "WebSocket error",
			text: options.firstResponseText,
		}),
		runner_assistant_message({ stopReason: "stop", text: "Recovered." }),
	];
	let streamCalls = 0;
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	runtime.registerProvider(RUNNER_WEBSOCKET_PROVIDER, {
		name: "Runner WebSocket Test Provider",
		baseUrl: "http://127.0.0.1:9/v1",
		api: "openai-completions",
		apiKey: "test-key",
		models: [
			{
				id: RUNNER_WEBSOCKET_MODEL_ID,
				name: "Runner WebSocket Test Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			},
		],
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const outcome = outcomes[streamCalls++];
			if (!outcome) throw new Error("Unexpected extra runner fixture prompt");
			queueMicrotask(() => {
				if (outcome.stopReason === "error") {
					stream.push({ type: "error", reason: "error", error: outcome });
				} else {
					stream.push({ type: "done", reason: "stop", message: outcome });
				}
				stream.end(outcome);
			});
			return stream;
		},
	});
	await runtime.setRuntimeApiKey(RUNNER_WEBSOCKET_PROVIDER, "test-key");
	const cwd = mkdtempSync(join(tmpdir(), "pi-ember-runner-websocket-"));
	try {
		const result = await runSubAgent({
			cwd,
			systemPrompt: "Test system prompt",
			task: "Test task",
			tools: [],
			model: RUNNER_WEBSOCKET_MODEL,
			modelRegistry: new ModelRegistry(runtime),
			timeoutMs: 30_000,
		});
		return { result, streamCalls };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("runSubAgent resolved WebSocket retry", () => {
	test("rolls back a no-output resolved provider error and completes the next prompt", async () => {
		const { result, streamCalls } = await run_resolved_websocket_retry_fixture();
		expect(streamCalls).toBe(2);
		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(getFinalOutput(result.messages)).toBe("Recovered.");
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	test("does not replay a resolved WebSocket failure after child text", async () => {
		const { result, streamCalls } = await run_resolved_websocket_retry_fixture({
			firstResponseText: "Partial output.",
		});
		expect(streamCalls).toBe(1);
		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket error");
		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});

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

describe("is_parser_stream_error", () => {
	test("matches every known pi-ai generic stream-parser failure", () => {
		expect(is_parser_stream_error("Stream ended without finish_reason")).toBe(true);
		expect(is_parser_stream_error("devin stream ended without a terminal event")).toBe(true);
		expect(is_parser_stream_error("Anthropic stream ended before message_stop")).toBe(true);
		expect(
			is_parser_stream_error("OpenAI Responses stream ended before a terminal response event"),
		).toBe(true);
	});

	test("matches case-insensitively and inside provider-prefixed text", () => {
		expect(is_parser_stream_error("STREAM ENDED WITHOUT FINISH_REASON")).toBe(true);
		expect(is_parser_stream_error("custom-model stream ended without a terminal event")).toBe(true);
	});

	test("rejects specific provider errors, aborts, and empty input", () => {
		expect(is_parser_stream_error("401 Unauthorized: invalid api key")).toBe(false);
		expect(is_parser_stream_error("500 status code (no body)")).toBe(false);
		expect(is_parser_stream_error("socket hang up")).toBe(false);
		expect(is_parser_stream_error("billing: insufficient credits")).toBe(false);
		expect(is_parser_stream_error("Request was aborted")).toBe(false);
		expect(is_parser_stream_error(undefined)).toBe(false);
		expect(is_parser_stream_error("")).toBe(false);
	});
});

describe("merge_failure_message", () => {
	test("a specific incoming message overwrites a generic parser/abort current", () => {
		expect(
			merge_failure_message("Stream ended without finish_reason", "401 Unauthorized: invalid api key"),
		).toBe("401 Unauthorized: invalid api key");
		expect(merge_failure_message("Request was aborted", "ECONNRESET")).toBe("ECONNRESET");
	});

	test("a generic parser/abort incoming message never overwrites a specific current", () => {
		expect(
			merge_failure_message("401 Unauthorized: invalid api key", "Stream ended without finish_reason"),
		).toBe("401 Unauthorized: invalid api key");
		expect(merge_failure_message("ECONNRESET", "Request was aborted")).toBe("ECONNRESET");
	});

	test("between two generic messages the later one wins", () => {
		expect(
			merge_failure_message("Request was aborted", "Stream ended without finish_reason"),
		).toBe("Stream ended without finish_reason");
		expect(
			merge_failure_message("Stream ended without finish_reason", "Request was aborted"),
		).toBe("Request was aborted");
	});

	test("two specific messages keep the later one", () => {
		expect(merge_failure_message("old 429 rate limit", "503 Service Unavailable")).toBe(
			"503 Service Unavailable",
		);
	});

	test("empty/undefined incoming keeps the current message", () => {
		expect(merge_failure_message("401 Unauthorized", undefined)).toBe("401 Unauthorized");
		expect(merge_failure_message("401 Unauthorized", "")).toBe("401 Unauthorized");
		expect(merge_failure_message(undefined, undefined)).toBeUndefined();
	});
});

describe("annotate_parser_stream_error", () => {
	test("appends the explicit limitation note to a parser-stream failure", () => {
		const annotated = annotate_parser_stream_error("Stream ended without finish_reason");
		expect(annotated).toBe(
			`Stream ended without finish_reason${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`,
		);
		expect(annotated).toContain("no underlying error was reported");
	});

	test("leaves specific messages untouched", () => {
		expect(annotate_parser_stream_error("401 Unauthorized: invalid api key")).toBe(
			"401 Unauthorized: invalid api key",
		);
	});

	test("is idempotent on an already-annotated message", () => {
		const once = annotate_parser_stream_error("Stream ended without finish_reason");
		expect(annotate_parser_stream_error(once)).toBe(once);
	});
});

describe("extractFailureMessage", () => {
	test("returns a direct specific error message", () => {
		expect(extractFailureMessage(new Error("401 Unauthorized: invalid api key"))).toBe(
			"401 Unauthorized: invalid api key",
		);
	});

	test("prefers a specific Error.cause over a generic outer message", () => {
		const wrapper = new Error("Request was aborted", {
			cause: new Error("ECONNRESET socket hang up"),
		});
		expect(extractFailureMessage(wrapper)).toBe("ECONNRESET socket hang up");
	});

	test("extracts the root cause buried under a parser-stream wrapper", () => {
		const wrapped = new Error("Stream ended without finish_reason", {
			cause: new Error("502 Bad Gateway from provider"),
		});
		expect(extractFailureMessage(wrapped)).toBe("502 Bad Gateway from provider");
	});

	test("walks a multi-level chain root-cause-first", () => {
		const deepest = new Error("429 rate limit exceeded");
		const parser = new Error("Stream ended without finish_reason", { cause: deepest });
		const abort = new Error("Request was aborted", { cause: parser });
		expect(extractFailureMessage(abort)).toBe("429 rate limit exceeded");
	});

	test("keeps the outermost error text when the whole chain is generic", () => {
		const parser = new Error("Stream ended without finish_reason", {
			cause: new Error("Request was aborted"),
		});
		expect(extractFailureMessage(parser)).toBe("Stream ended without finish_reason");
	});

	test("never degrades to a stringified non-Error cause", () => {
		const outer = new Error("aborted", { cause: { status: 500 } });
		expect(extractFailureMessage(outer)).toBe("aborted");
	});

	test("handles non-Error and null inputs", () => {
		expect(extractFailureMessage(null)).toBe("Unknown error");
		expect(extractFailureMessage(undefined)).toBe("Unknown error");
		expect(extractFailureMessage("plain string")).toBe("plain string");
	});
});

describe("parser-stream failure resolution", () => {
	const PARSER = "Stream ended without finish_reason";

	test("retains and annotates the exact parser failure when no underlying error exists", () => {
		const result = makeResult({ exitCode: 1, stopReason: "error", errorMessage: PARSER });
		const resolved = resolve_failure_message(result);
		expect(resolved).toBe(`${PARSER}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`);
		// The finalization fallback never replaces the retained parser reason.
		expect(resolved).not.toContain("Subagent failed");
	});

	test("specific agent_end message wins over a generic message_end parser message", () => {
		// Lifecycle: message_end captured the generic parser text first, then a
		// specific error surfaced on the assistant message (agent_end/turn_end).
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: PARSER,
			messages: [assistantMessage({ errorMessage: "401 Unauthorized: invalid api key" })],
		});
		expect(resolve_failure_message(result)).toBe("401 Unauthorized: invalid api key");
	});

	test("specific message_end reason survives a later generic agent_end parser message", () => {
		// Lifecycle: a specific reason was captured first; a generic parser
		// message arriving later must not overwrite it.
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
			messages: [assistantMessage({ errorMessage: PARSER })],
		});
		expect(resolve_failure_message(result)).toBe("503 Service Unavailable");
	});

	test("parser message beats a generic abort from an earlier message_end", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "Request was aborted",
			messages: [assistantMessage({ errorMessage: PARSER })],
		});
		expect(resolve_failure_message(result)).toBe(
			`${PARSER}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`,
		);
	});

	test("resolution is idempotent after runSubAgent writes the annotated reason back", () => {
		const annotated = `${PARSER}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`;
		const result = makeResult({ exitCode: 1, stopReason: "error", errorMessage: annotated });
		expect(resolve_failure_message(result)).toBe(annotated);
	});

	test("getResultOutput shows the annotated parser reason, not a fallback", () => {
		const result = makeResult({ exitCode: 1, stopReason: "error", errorMessage: PARSER });
		expect(getResultOutput(result)).toBe(`${PARSER}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`);
		expect(getResultOutput(result)).not.toBe("(no output)");
	});

	test("model-visible tool result carries the annotated parser reason", () => {
		const result = makeResult({
			agent: "Scout A",
			exitCode: 1,
			stopReason: "error",
			errorMessage: PARSER,
		});
		expect(format_agent_tool_result_text(result)).toBe(
			`### [Scout A] failed (error)\n\n${PARSER}${PARSER_STREAM_ERROR_LIMITATION_SUFFIX}`,
		);
	});

	test("specific reason is never replaced by the parser annotation or a fallback", () => {
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "429 rate limit exceeded",
		});
		expect(resolve_failure_message(result)).toBe("429 rate limit exceeded");
		expect(getResultOutput(result)).toBe("429 rate limit exceeded");
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

describe("pre-response retry decisions", () => {
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

	test("retries a resolved WebSocket assistant error after the configured backoff", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "WebSocket error",
			messages: [assistantMessage({ errorMessage: "WebSocket error" })],
		});
		const attempt: SubagentPromptAttempt = {
			sawVisibleOrToolSideEffect: false,
			resolvedStopReason: "error",
			resolvedFailureMessage: "WebSocket error",
		};
		expect(classify_safe_pre_response_failure({ result, attempt })).toBe("websocket");
		const decisionPromise = decide_pre_response_websocket_retry({
			result,
			attempt,
			aborted: false,
			websocketRetries: 0,
			session,
			rollback: makeRollback(),
			backoffMs: 10,
		});
		await Promise.resolve();
		expect(calls).toEqual([]);
		expect(await decisionPromise).toBe("retry");
		expect(calls).toEqual(["branch:pre-attempt-leaf"]);
		expect(result.stopReason).toBeUndefined();
		expect(result.errorMessage).toBeUndefined();
	});

	test("keeps empty text markers retryable before a resolved WebSocket error", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult({ exitCode: 1, stopReason: "error" });
		const attempt: SubagentPromptAttempt = { sawVisibleOrToolSideEffect: false };
		note_subagent_prompt_attempt_event(attempt, {
			type: "message_update",
			assistantMessageEvent: { type: "text_start" },
		});
		note_subagent_prompt_attempt_event(attempt, {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "" },
		});
		note_subagent_prompt_attempt_event(attempt, {
			type: "message_end",
			message: assistantMessage({
				stopReason: "error",
				errorMessage: "WebSocket error",
			}),
		});
		expect(attempt.sawVisibleOrToolSideEffect).toBe(false);
		expect(classify_safe_pre_response_failure({ result, attempt })).toBe("websocket");
		const decision = await decide_pre_response_websocket_retry({
			result,
			attempt,
			aborted: false,
			websocketRetries: 0,
			session,
			rollback: makeRollback(),
			backoffMs: 0,
		});
		expect(decision).toBe("retry");
		expect(calls).toEqual(["branch:pre-attempt-leaf"]);
	});

	test("does not classify a later non-WebSocket resolved error from stale history", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "WebSocket error",
			messages: [assistantMessage({ errorMessage: "WebSocket error" })],
		});
		const attempt: SubagentPromptAttempt = {
			sawVisibleOrToolSideEffect: false,
			resolvedStopReason: "error",
			resolvedFailureMessage: "503 Service Unavailable",
		};
		expect(classify_safe_pre_response_failure({ result, attempt })).toBeUndefined();
		const decision = await decide_pre_response_websocket_retry({
			result,
			attempt,
			aborted: false,
			websocketRetries: 0,
			session,
			rollback: makeRollback(),
			backoffMs: 0,
		});
		expect(decision).toBe("skip");
		expect(calls).toEqual([]);
		expect(result.errorMessage).toBe("WebSocket error");
	});

	test("honors the WebSocket retry budget and preserves the exhausted error", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult();
		const attempt: SubagentPromptAttempt = {
			sawVisibleOrToolSideEffect: false,
			resolvedStopReason: "error",
			resolvedFailureMessage: "WebSocket error",
		};
		for (let retry = 0; retry < MAX_SUBAGENT_WEBSOCKET_RETRIES; retry++) {
			result.stopReason = "error";
			result.errorMessage = "WebSocket error";
			const decision = await decide_pre_response_websocket_retry({
				result,
				attempt,
				aborted: false,
				websocketRetries: retry,
				session,
				rollback: makeRollback(),
				backoffMs: 0,
			});
			expect(decision).toBe("retry");
		}
		result.stopReason = "error";
		result.errorMessage = "WebSocket error";
		const exhausted = await decide_pre_response_websocket_retry({
			result,
			attempt,
			aborted: false,
			websocketRetries: MAX_SUBAGENT_WEBSOCKET_RETRIES,
			session,
			rollback: makeRollback(),
			backoffMs: 0,
		});
		expect(exhausted).toBe("skip");
		expect(calls).toHaveLength(MAX_SUBAGENT_WEBSOCKET_RETRIES);
		expect(result.errorMessage).toBe("WebSocket error");
		expect(result.stopReason).toBe("error");
	});

	test("does not retry or roll back a resolved WebSocket error after visible or tool activity", async () => {
		const sideEffectEvents = [
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Visible output" },
			},
			{ type: "tool_execution_start" },
		] as const;
		for (const event of sideEffectEvents) {
			const { session, calls } = makeRetrySession();
			const result = makeResult({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "WebSocket error",
			});
			const attempt: SubagentPromptAttempt = {
			sawVisibleOrToolSideEffect: false,
			resolvedStopReason: "error",
			resolvedFailureMessage: "WebSocket error",
		};
			note_subagent_prompt_attempt_event(attempt, event);
			const decision = await decide_pre_response_websocket_retry({
				result,
				attempt,
				aborted: false,
				websocketRetries: 0,
				session,
				rollback: makeRollback(),
				backoffMs: 0,
			});
			expect(decision).toBe("skip");
			expect(calls).toEqual([]);
			expect(result.errorMessage).toBe("WebSocket error");
		}
	});

	test("retries a thrown WebSocket error with the same safe rollback semantics", async () => {
		const { session, calls } = makeRetrySession();
		const result = makeResult();
		const attempt: SubagentPromptAttempt = { sawVisibleOrToolSideEffect: false };
		const decision = await decide_pre_response_websocket_retry({
			result,
			attempt,
			aborted: false,
			websocketRetries: 0,
			session,
			rollback: makeRollback(),
			promptError: new Error("WEBSOCKET ERROR"),
			backoffMs: 0,
		});
		expect(decision).toBe("retry");
		expect(calls).toEqual(["branch:pre-attempt-leaf"]);
	});

	test("stops a WebSocket retry when the parent aborts during backoff", async () => {
		const { session, calls } = makeRetrySession();
		const controller = new AbortController();
		const result = makeResult({
			exitCode: 1,
			stopReason: "error",
			errorMessage: "WebSocket error",
		});
		const decisionPromise = decide_pre_response_websocket_retry({
			result,
			attempt: {
			sawVisibleOrToolSideEffect: false,
			resolvedStopReason: "error",
			resolvedFailureMessage: "WebSocket error",
		},
			aborted: false,
			websocketRetries: 0,
			signal: controller.signal,
			session,
			rollback: makeRollback(),
			backoffMs: 100,
		});
		setTimeout(() => controller.abort(), 5);
		expect(await decisionPromise).toBe("aborted");
		expect(calls).toEqual([]);
		expect(result.errorMessage).toBe("WebSocket error");
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
