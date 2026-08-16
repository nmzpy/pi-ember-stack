/**
 * Deterministic no-network integration coverage for subagent context-overflow
 * recovery ownership.
 *
 * The real `AgentSession` (createAgentSession from pi-coding-agent) is driven
 * with a fake `agent.streamFn` that emits a resolved Codex-style overflow
 * assistant message on the first model call and a successful assistant on the
 * continuation. Native `_checkCompaction` (pi-ai `isContextOverflow`) detects
 * the exact `stopReason: "error"` + "Codex error: Your input exceeds the
 * context window..." form and, with child compaction enabled by
 * `build_subagent_settings()`, runs overflow compaction plus ONE bounded
 * continuation inside `session.prompt()`. A test fixture extension provides the
 * canned `session_before_compact` summary so no summarizer model call and no
 * network are needed, while still exercising the real extension wiring seam.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	discoverAndLoadExtensions,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { build_subagent_settings } from "../runner.ts";
import {
	get_test_compaction_record,
	reset_test_compaction_record,
} from "./fixtures/overflow-compaction-extension.ts";

const FAKE_PROVIDER = "fake-overflow-provider";
const FAKE_MODEL_ID = "fake-overflow-model";
const CODEX_OVERFLOW_MESSAGE =
	"Codex error: Your input exceeds the context window of this model";

const FAKE_MODEL = {
	id: FAKE_MODEL_ID,
	name: "Fake Overflow Model",
	api: "openai-completions",
	provider: FAKE_PROVIDER,
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>;

function zeroUsage() {
	return {
		input: 100,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function failedAssistant(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: FAKE_PROVIDER,
		model: FAKE_MODEL_ID,
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function successfulAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: FAKE_PROVIDER,
		model: FAKE_MODEL_ID,
		usage: { ...zeroUsage(), output: 12, totalTokens: 112 },
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] } as Message;
}

function fixturePath(): string {
	return fileURLToPath(new URL("./fixtures/overflow-compaction-extension.ts", import.meta.url));
}

async function makeSession(): Promise<{
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	streamCalls: () => number;
	setOutcome: (outcome: "overflow" | "non-overflow") => void;
	tmp: string;
}> {
	reset_test_compaction_record();
	const tmp = mkdtempSync(join(tmpdir(), "pi-ember-overflow-"));
	const extensionsResult = await discoverAndLoadExtensions([fixturePath()], tmp);
	expect(extensionsResult.errors).toEqual([]);

	const resourceLoader: ResourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "",
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	// Register the fake provider so the session's auth gate passes and the
	// canonical summarization auth resolves without any network. The runtime key
	// alone is clobbered by the availability refresh, which rebuilds
	// configuredProviders from checkAuth results.
	modelRuntime.registerProvider(FAKE_PROVIDER, {
		name: "Fake Overflow Provider",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: FAKE_MODEL_ID,
				name: "Fake Overflow Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			},
		],
	});
	await modelRuntime.setRuntimeApiKey(FAKE_PROVIDER, "test-key");

	// Seed one prior completed turn so native compaction has history to
	// summarize (prepareCompaction returns nothing for an empty conversation).
	const sessionManager = SessionManager.inMemory(tmp);
	sessionManager.appendMessage(userMessage("Prior task"));
	sessionManager.appendMessage(
		successfulAssistant("Prior answer.") as unknown as Message,
	);

	const settingsManager = SettingsManager.inMemory(build_subagent_settings());
	// Tiny keep-recent budget makes the deterministic cut point land on the
	// failed assistant without needing ~20k tokens of fixture history.
	settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

	const { session } = await createAgentSession({
		cwd: tmp,
		model: FAKE_MODEL,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		tools: [],
	});

	let calls = 0;
	let outcome: "overflow" | "non-overflow" = "overflow";
	session.agent.streamFn = async () => {
		calls++;
		const stream = createAssistantMessageEventStream();
		if (outcome === "overflow") {
			// Call 1 emits the resolved Codex overflow; native recovery continues
			// the turn once and call 2 succeeds.
			stream.end(
				calls === 1 ? failedAssistant(CODEX_OVERFLOW_MESSAGE) : successfulAssistant("Done."),
			);
		} else {
			stream.end(failedAssistant("429 rate limit exceeded"));
		}
		return stream;
	};

	return {
		session,
		streamCalls: () => calls,
		setOutcome: (next) => {
			outcome = next;
		},
		tmp,
	};
}

describe("native AgentSession overflow recovery (Codex resolved form)", () => {
	afterEach(() => {
		reset_test_compaction_record();
	});

	test("overflow assistant triggers session_before_compact, one continuation, no duplicate prompt", async () => {
		const { session, streamCalls } = await makeSession();
		try {
			await session.prompt("original task");

			const record = get_test_compaction_record();
			// 1. session_before_compact wiring was invoked by native overflow recovery.
			expect(record.invocations).toBe(1);
			expect(record.reasons).toEqual(["overflow"]);
			expect(record.willRetry).toEqual([true]);
			expect(record.firstKeptEntryIds).toHaveLength(1);

			// 2. The model was called exactly twice: the failed overflow attempt
			//    plus ONE native continuation. The runner never re-prompted.
			expect(streamCalls()).toBe(2);

			// 3. The original task was sent once — no duplicate user message was
			//    appended by a manual re-prompt.
			const branchUsers = session.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						"content" in entry.message &&
						JSON.stringify(entry.message.content).includes("original task"),
				);
			expect(branchUsers).toHaveLength(1);

			// 4. Native recovery appended a compaction entry and the continuation
			//    completed the turn successfully.
			expect(
				session.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
			).toBe(true);
			const stateMessages = session.agent.state.messages;
			const lastAssistant = [...stateMessages]
				.reverse()
				.find((message) => message.role === "assistant");
			expect(lastAssistant?.stopReason).toBe("stop");
		} finally {
			session.dispose();
		}
	});

	test("non-overflow errors do not compact or retry", async () => {
		const { session, streamCalls, setOutcome } = await makeSession();
		try {
			// Force every model call to fail with an unrelated 429.
			setOutcome("non-overflow");

			await session.prompt("original task");

			// No compaction hook, no continuation, no compaction entry.
			expect(get_test_compaction_record().invocations).toBe(0);
			expect(streamCalls()).toBe(1);
			expect(
				session.sessionManager.getBranch().some((entry) => entry.type === "compaction"),
			).toBe(false);
			const stateMessages = session.agent.state.messages;
			const lastAssistant = [...stateMessages]
				.reverse()
				.find((message) => message.role === "assistant");
			expect(lastAssistant?.stopReason).toBe("error");
			expect(lastAssistant?.errorMessage).toBe("429 rate limit exceeded");
		} finally {
			session.dispose();
		}
	});
});
