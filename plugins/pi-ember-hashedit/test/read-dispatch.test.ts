import { test } from "node:test";
import assert from "node:assert/strict";
import { regReadForModel } from "../src/read.ts";

function makeMockPi(): { calls: { name: string; def: any }[]; registerTool: any } {
	const calls: { name: string; def: any }[] = [];
	return {
		calls,
		registerTool: (def: { name: string }) => {
			calls.push({ name: def.name, def });
		},
	} as any;
}

test("regReadForModel uses native read for OpenAI/Codex model by provider", () => {
	const pi = makeMockPi();
	regReadForModel(pi as any, {
		cwd: "/tmp",
		model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
	});
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].name, "read");
	assert.ok(!pi.calls[0].def.promptGuidelines, "native read has no promptGuidelines");
});

test("regReadForModel uses native read for OpenAI/Codex model by id marker", () => {
	const pi = makeMockPi();
	regReadForModel(pi as any, {
		cwd: "/tmp",
		model: { provider: "azure-openai-responses", id: "gpt-4", name: "My GPT" },
	});
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].name, "read");
	assert.ok(!pi.calls[0].def.promptGuidelines, "native read has no promptGuidelines");
});

test("regReadForModel uses native read for OpenAI/Codex model by name marker", () => {
	const pi = makeMockPi();
	regReadForModel(pi as any, {
		cwd: "/tmp",
		model: { provider: "openrouter", id: "openai/gpt-4o", name: "OpenAI GPT-4o" },
	});
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].name, "read");
	assert.ok(!pi.calls[0].def.promptGuidelines, "native read has no promptGuidelines");
});

test("regReadForModel uses hash-anchored read for non-OpenAI models", () => {
	const pi = makeMockPi();
	regReadForModel(pi as any, {
		cwd: "/tmp",
		model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
	});
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].name, "read");
	assert.ok(pi.calls[0].def.promptGuidelines, "hashedit read has promptGuidelines");
});

test("regReadForModel falls back to hash-anchored read when model is missing", () => {
	const pi = makeMockPi();
	regReadForModel(pi as any, { cwd: "/tmp" });
	assert.equal(pi.calls.length, 1);
	assert.equal(pi.calls[0].name, "read");
	assert.ok(pi.calls[0].def.promptGuidelines, "hashedit read has promptGuidelines");
});
