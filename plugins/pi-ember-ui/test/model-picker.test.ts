import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	find_exact_model_reference,
	find_session_reference,
} from "../model-picker.ts";

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
	{ provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
	{ provider: "xai", id: "grok-4.5", name: "Grok 4.5" },
];

function session(partial: Partial<SessionInfo> & Pick<SessionInfo, "path" | "id">): SessionInfo {
	const now = new Date();
	return {
		cwd: "/work",
		created: now,
		modified: now,
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
		...partial,
	};
}

describe("find_exact_model_reference", () => {
	test("matches canonical provider/id", () => {
		const model = find_exact_model_reference("anthropic/claude-sonnet-4", MODELS);
		expect(model?.provider).toBe("anthropic");
		expect(model?.id).toBe("claude-sonnet-4");
	});

	test("rejects ambiguous bare ids", () => {
		const ambiguous = [
			{ provider: "a", id: "shared", name: "A" },
			{ provider: "b", id: "shared", name: "B" },
		];
		expect(find_exact_model_reference("shared", ambiguous)).toBeUndefined();
	});

	test("matches unique bare id", () => {
		expect(find_exact_model_reference("grok-4.5", MODELS)?.provider).toBe("xai");
	});
});

describe("find_session_reference", () => {
	const sessions = [
		session({
			path: "/sessions/alpha.jsonl",
			id: "alpha-id",
			name: "Alpha Plan",
			firstMessage: "plan the feature",
		}),
		session({
			path: "/sessions/beta.jsonl",
			id: "beta-id",
			firstMessage: "fix the bug",
		}),
	];

	test("matches full path", () => {
		expect(find_session_reference("/sessions/alpha.jsonl", sessions)?.id).toBe("alpha-id");
	});

	test("matches session id", () => {
		expect(find_session_reference("beta-id", sessions)?.path).toBe("/sessions/beta.jsonl");
	});

	test("matches unique display name", () => {
		expect(find_session_reference("Alpha Plan", sessions)?.path).toBe("/sessions/alpha.jsonl");
	});

	test("matches unique fuzzy first-message text", () => {
		expect(find_session_reference("fix the", sessions)?.id).toBe("beta-id");
	});

	test("rejects empty reference", () => {
		expect(find_session_reference("  ", sessions)).toBeUndefined();
	});
});
