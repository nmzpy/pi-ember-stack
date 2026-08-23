/**
 * Tests for the hierarchical AGENTS.md auto-loader (plugins/pi-custom-agents/agents-md.ts).
 *
 * Fixture layout (generated in a fresh temp dir per test):
 *
 *   <tmp>/root/            <- session cwd / project root boundary
 *     AGENTS.md            <- root instructions (Pi-native, never auto-loaded)
 *     a/
 *       AGENTS.md          <- "a instructions"
 *       file.ts
 *       b/
 *         AGENTS.md        <- "b instructions"
 *         deep.ts
 *     sub/
 *       AGENTS.md          <- "sub instructions"
 *     plain/
 *       readme.txt         <- no AGENTS.md (write-created file test)
 *   <tmp>/outside/         <- sibling of root (escape boundary)
 *     secret.txt
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentsMdLoader,
	AGENTS_FILE_NAME,
	CONTEXT_CUSTOM_TYPE,
	deriveToolPaths,
	installAgentsMdHooks,
	isInside,
	resolveRootTarget,
	toPosixRelative,
} from "../agents-md.ts";

let fixture: { root: string; outside: string; tmp: string } | undefined;

function buildFixture(): { root: string; outside: string; tmp: string } {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ember-agents-md-"));
	const root = path.join(tmp, "root");
	const outside = path.join(tmp, "outside");
	fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
	fs.mkdirSync(path.join(root, "sub"), { recursive: true });
	fs.mkdirSync(path.join(root, "plain"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(root, AGENTS_FILE_NAME), "root instructions");
	fs.writeFileSync(path.join(root, "a", AGENTS_FILE_NAME), "a instructions");
	fs.writeFileSync(path.join(root, "a", "b", AGENTS_FILE_NAME), "b instructions");
	fs.writeFileSync(path.join(root, "sub", AGENTS_FILE_NAME), "sub instructions");
	fs.writeFileSync(path.join(root, "a", "file.ts"), "file a");
	fs.writeFileSync(path.join(root, "a", "b", "deep.ts"), "file b");
	fs.writeFileSync(path.join(root, "plain", "readme.txt"), "plain readme");
	fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
	return { root, outside, tmp };
}

function makeLoader(root: string): AgentsMdLoader {
	const loader = new AgentsMdLoader();
	loader.startSession(root);
	return loader;
}

function touch(loader: AgentsMdLoader, id: string, toolName: string, input: Record<string, unknown>): void {
	loader.noteToolCall(id, toolName, input);
	loader.noteToolExecutionEnd(id);
}

beforeEach(() => {
	fixture = buildFixture();
});

afterEach(() => {
	if (fixture) {
		try {
			fs.rmSync(fixture.tmp, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	}
	fixture = undefined;
});

function symlinkSafe(target: string, linkPath: string, type: "file" | "dir"): boolean {
	try {
		fs.symlinkSync(target, linkPath, type);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Fake API helpers for installAgentsMdHooks tests
// ---------------------------------------------------------------------------

type SendMessageCapture = { customType: string; content: string; display: boolean };

interface FakeApi {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	sendMessageCalls: SendMessageCapture[];
	historyEntries: Array<{ type: string; customType: string; content: string; role: string }>;
	/** Matches the path pi casts: pi.ctx.sessionManager.getEntries() */
	ctx: {
		sessionManager: {
			getEntries(): Array<{ type: string; customType: string; content: string; role: string }>;
		};
	};
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	sendMessage(msg: unknown): void;
}

function makeFakeApi(): FakeApi {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const sendMessageCalls: SendMessageCapture[] = [];
	const historyEntries: Array<{ type: string; customType: string; content: string; role: string }> = [];
	const ctx = {
		sessionManager: {
			getEntries() {
				return historyEntries;
			},
		},
	};
	return {
		handlers,
		sendMessageCalls,
		historyEntries,
		ctx,
		on(event, handler) {
			let list = handlers.get(event);
			if (!list) {
				list = [];
				handlers.set(event, list);
			}
			list.push(handler);
		},
		sendMessage(msg) {
			const m = msg as SendMessageCapture;
			sendMessageCalls.push({ ...m });
			// Simulate Pi persisting the message into session history.
			historyEntries.push({
				type: "custom_message",
				customType: m.customType,
				content: m.content,
				role: "custom",
			});
		},
	};
}

/** Run through a fake API's session_start, tool_call, and tool_execution_end. */
function exerciseTools(
	api: FakeApi,
	root: string,
	calls: Array<{ id: string; toolName: string; input: Record<string, unknown> }>,
): void {
	const sessionStart = api.handlers.get("session_start")![0];
	sessionStart({ type: "session_start", reason: "startup" }, { cwd: root });

	for (const call of calls) {
		const toolCall = api.handlers.get("tool_call")![0];
		toolCall(
			{ type: "tool_call", toolCallId: call.id, toolName: call.toolName, input: call.input },
			{},
		);
		const toolEnd = api.handlers.get("tool_execution_end")![0];
		toolEnd(
			{ type: "tool_execution_end", toolCallId: call.id, toolName: call.toolName, result: {}, isError: false },
			{},
		);
	}
}

/** Get all sendMessage content blocks. */
function allSendContent(api: FakeApi): string[] {
	return api.sendMessageCalls.map((m) => m.content);
}

describe("root boundary and exclusion", () => {
	test("root AGENTS.md is never auto-loaded", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		const content = allSendContent(api).join("\n\n");
		expect(content).not.toContain("root instructions");
	});

	test("targeting the root itself activates nothing", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "." });
		loader.noteToolCall("t2", "ls", { path: "a/.." });
		expect(loader.activeCount).toBe(0);
	});

	test("parent instructions remain active after switching modules", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "read", { path: "a/file.ts" });
		touch(loader, "t2", "read", { path: "sub/x.txt" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "sub/AGENTS.md"]);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		const content = allSendContent(api).join("\n\n");
		expect(content).toContain("a instructions");
		expect(content).toContain("sub instructions");
	});
});

describe("hierarchy shallow -> deep", () => {
	test("deep target activates ancestors in shallow-to-deep order", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/b/deep.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api.sendMessageCalls.length).toBe(2);
		expect(api.sendMessageCalls[0].content).toContain("a instructions");
		expect(api.sendMessageCalls[1].content).toContain("b instructions");
		// Blocks are per-file, not a single merged block.
		expect(api.sendMessageCalls[0].content).toMatch(/^<agents_md path="a\/AGENTS\.md">/);
		expect(api.sendMessageCalls[1].content).toMatch(/^<agents_md path="a\/b\/AGENTS\.md">/);
	});

	test("re-activation preserves first-activation order", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "read", { path: "a/b/deep.ts" });
		touch(loader, "t2", "read", { path: "a/b/deep.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
	});
});

describe("path safety", () => {
	test(".. traversal outside the root is rejected", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "../outside/secret.txt" });
		loader.noteToolCall("t2", "write", { path: "../../escape.txt", content: "x" });
		expect(loader.activeCount).toBe(0);
		expect(resolveRootTarget("../outside/secret.txt", fixture!.root)).toBeUndefined();
	});

	test("absolute outside path is rejected", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: path.join(fixture!.outside, "secret.txt") });
		expect(loader.activeCount).toBe(0);
	});

	test("inside .. normalization still activates", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/b/../file.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
	});

	test("multiple target paths activate every touched module", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "cat ./a/file.ts ./sub/x.txt" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "sub/AGENTS.md"]);
	});

	test("existing symlink cannot escape the root", () => {
		const loader = makeLoader(fixture!.root);
		const linkPath = path.join(fixture!.root, "evil-link");
		const ok = symlinkSafe(fixture!.outside, linkPath, "dir");
		if (!ok) return; // symlinks unsupported (e.g. Windows without privileges)
		loader.noteToolCall("t1", "read", { path: "evil-link/secret.txt" });
		expect(loader.activeCount).toBe(0);
		expect(resolveRootTarget("evil-link/secret.txt", fixture!.root)).toBeUndefined();
	});

	test("symlink inside the root keeps working", () => {
		const loader = makeLoader(fixture!.root);
		const linkPath = path.join(fixture!.root, "good-link");
		const ok = symlinkSafe(path.join(fixture!.root, "a"), linkPath, "dir");
		if (!ok) return; // symlinks unsupported
		loader.noteToolCall("t1", "read", { path: "good-link/file.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
	});

	test("non-existent write target resolves through its parent", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "write", { path: "a/brand-new-dir/file.ts", content: "x" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
		loader.noteToolCall("t2", "write", { path: "a/b/new-file.ts", content: "x" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
	});
});

describe("content reload after execution", () => {
	test("edited AGENTS.md is rescanned after tool_execution_end", () => {
		const loader = makeLoader(fixture!.root);
		// Call noteToolCall only — noteToolExecutionEnd comes after the file change.
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const api1 = makeFakeApi();
		loader.deliverFn = (msg) => api1.sendMessage(msg);
		loader.noteToolExecutionEnd("t1");
		expect(allSendContent(api1).join("\n\n")).toContain("a instructions");

		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");
		// Re-trigger: a second tool call to the same dir, then execution end.
		loader.noteToolCall("t2", "read", { path: "a/file.ts" });
		const api2 = makeFakeApi();
		loader.deliverFn = (msg) => api2.sendMessage(msg);
		loader.noteToolExecutionEnd("t2");
		const content = allSendContent(api2).join("\n\n");
		expect(content).toContain("a revised instructions");
		expect(content).not.toContain("a instructions");
	});

	test("deleted AGENTS.md is dropped after tool_execution_end", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		expect(loader.activeCount).toBe(1);

		fs.rmSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME));
		loader.noteToolExecutionEnd("t1");
		expect(loader.activeCount).toBe(0);
		// No active files means no delivery.
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api.sendMessageCalls.length).toBe(0);
	});

	test("AGENTS.md created by a write is activated after execution", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "write", { path: "plain/AGENTS.md", content: "draft" });
		expect(loader.activeCount).toBe(0); // not yet on disk during tool_call

		fs.mkdirSync(path.join(fixture!.root, "plain"), { recursive: true });
		fs.writeFileSync(path.join(fixture!.root, "plain", AGENTS_FILE_NAME), "plain final");
		loader.noteToolExecutionEnd("t1");
		expect(loader.activeFiles()).toEqual(["plain/AGENTS.md"]);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(allSendContent(api).join("\n\n")).toContain("plain final");
	});
});

describe("append-once-at-discovery delivery", () => {
	test("file discovered by a tool call is delivered exactly once via sendMessage", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		loader.noteToolExecutionEnd("t1");
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api.sendMessageCalls.length).toBe(1);
		expect(api.sendMessageCalls[0].customType).toBe(CONTEXT_CUSTOM_TYPE);
		expect(api.sendMessageCalls[0].display).toBe(false);
		expect(api.sendMessageCalls[0].content).toContain("<agents_md path=");
		expect(api.sendMessageCalls[0].content).toContain("a instructions");
	});

	test("repeated touches of the same directory deliver nothing new", () => {
		const loader = makeLoader(fixture!.root);
		// First touch: deliver a/AGENTS.md.
		touch(loader, "t1", "read", { path: "a/file.ts" });
		const api1 = makeFakeApi();
		loader.deliverFn = (msg) => api1.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api1.sendMessageCalls.length).toBe(1);

		// Second touch: same directory, same content — no new sendMessage.
		const api2 = makeFakeApi();
		loader.deliverFn = (msg) => api2.sendMessage(msg);
		touch(loader, "t2", "read", { path: "a/file.ts" });
		// noteToolExecutionEnd already called inside touch; deliverNewFiles checks hash.
		loader.deliverNewFiles();
		expect(api2.sendMessageCalls.length).toBe(0);
	});

	test("no delivery without new discovery (no context handler)", () => {
		const loader = makeLoader(fixture!.root);
		// Activate a file, deliver it, then do a tool call to a different dir.
		touch(loader, "t1", "read", { path: "a/file.ts" });
		const api1 = makeFakeApi();
		loader.deliverFn = (msg) => api1.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api1.sendMessageCalls.length).toBe(1);

		// Touch a new directory — only sub/AGENTS.md should be delivered, not a/.
		const api2 = makeFakeApi();
		loader.deliverFn = (msg) => api2.sendMessage(msg);
		touch(loader, "t2", "read", { path: "sub/x.txt" });
		loader.deliverNewFiles();
		expect(api2.sendMessageCalls.length).toBe(1);
		expect(api2.sendMessageCalls[0].content).toContain("sub/AGENTS.md");
	});

	test("content change after tool_execution_end re-delivers exactly once with new content", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const api1 = makeFakeApi();
		loader.deliverFn = (msg) => api1.sendMessage(msg);
		loader.noteToolExecutionEnd("t1");
		expect(api1.sendMessageCalls.length).toBe(1);
		expect(api1.sendMessageCalls[0].content).toContain("a instructions");

		// Modify the file and re-scan via a fresh tool call.
		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a new instructions");
		loader.noteToolCall("t2", "read", { path: "a/file.ts" });
		const api2 = makeFakeApi();
		loader.deliverFn = (msg) => api2.sendMessage(msg);
		loader.noteToolExecutionEnd("t2");
		expect(api2.sendMessageCalls.length).toBe(1);
		expect(api2.sendMessageCalls[0].content).toContain("a new instructions");
		expect(api2.sendMessageCalls[0].content).not.toContain("a instructions");
	});

	test("deleted AGENTS.md: record dropped, no delivery", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "read", { path: "a/file.ts" });
		expect(loader.activeCount).toBe(1);

		fs.rmSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME));
		loader.noteToolExecutionEnd("t1");
		expect(loader.activeCount).toBe(0);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api.sendMessageCalls.length).toBe(0);
	});

	test("hierarchy: a deep read delivers shallow ancestors before deeper files", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/b/deep.ts" });
		loader.noteToolExecutionEnd("t1");
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(api.sendMessageCalls.length).toBe(2);
		expect(api.sendMessageCalls[0].content).toContain("a/AGENTS.md");
		expect(api.sendMessageCalls[0].content).toContain("a instructions");
		expect(api.sendMessageCalls[1].content).toContain("a/b/AGENTS.md");
		expect(api.sendMessageCalls[1].content).toContain("b instructions");
	});
});

describe("bash heuristic", () => {
	test("cd dir activates its module", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "cd sub && ls" });
		expect(loader.activeFiles()).toEqual(["sub/AGENTS.md"]);
	});

	test("cd base is not resolved against itself (regression)", () => {
		fs.mkdirSync(path.join(fixture!.root, "sub", "sub"), { recursive: true });
		fs.writeFileSync(path.join(fixture!.root, "sub", "sub", AGENTS_FILE_NAME), "sub/sub instructions");
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "cd sub && ls" });
		expect(loader.activeFiles()).toEqual(["sub/AGENTS.md"]);
		const api = makeFakeApi();
		loader.deliverFn = (msg) => api.sendMessage(msg);
		loader.deliverNewFiles();
		expect(allSendContent(api).join("\n\n")).not.toContain("sub/sub instructions");
	});

	test("cd -- dir activates its module", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "cd -- sub && make" });
		expect(loader.activeFiles()).toEqual(["sub/AGENTS.md"]);
	});

	test("dot-relative operands activate modules", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "ls ./a" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
	});

	test("absolute operands activate modules", () => {
		const loader = makeLoader(fixture!.root);
		const abs = path.join(fixture!.root, "a", "b", "deep.ts");
		touch(loader, "t1", "bash", { command: `cat ${abs}` });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
	});

	test("ambiguous commands are ignored", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "npm test" });
		touch(loader, "t2", "bash", { command: "cat plain-relative.txt" });
		touch(loader, "t3", "bash", { command: "echo ./not-a-path; rm -rf /" });
		expect(loader.activeCount).toBe(0);
	});
});

describe("bash bare relative paths (regression)", () => {
	test("bare relative path with a separator activates its module", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: `cd ${fixture!.root} && grep pattern a/AGENTS.md` });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
	});

	test("bare relative path nested file activates ancestors", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: `cd ${fixture!.root} && grep pattern a/b/deep.ts` });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
	});

	test("bare relative path edited mid-session refreshes context", () => {
		const loader = makeLoader(fixture!.root);
		// First touch: discover and deliver.
		loader.noteToolCall("t1", "bash", { command: `cd ${fixture!.root} && grep pattern a/AGENTS.md` });
		const api1 = makeFakeApi();
		loader.deliverFn = (msg) => api1.sendMessage(msg);
		loader.noteToolExecutionEnd("t1");
		expect(allSendContent(api1).join("\n\n")).toContain("a instructions");

		// Edit the file, then re-touch.
		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");
		loader.noteToolCall("t2", "bash", { command: `cd ${fixture!.root} && grep pattern a/AGENTS.md` });
		const api2 = makeFakeApi();
		loader.deliverFn = (msg) => api2.sendMessage(msg);
		loader.noteToolExecutionEnd("t2");
		const content = allSendContent(api2).join("\n\n");
		expect(content).toContain("a revised instructions");
		expect(content).not.toContain("a instructions");
	});

	test("bare tokens without a separator stay rejected", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "grep -rn pattern" });
		expect(loader.activeCount).toBe(0);
	});
});

describe("apply_patch and aliases", () => {
	test("apply_patch paths activate modules", () => {
		const loader = makeLoader(fixture!.root);
		const patch = [
			"*** Begin Patch",
			"*** Add File: a/patched.ts",
			"+export const patched = true;",
			"*** Update File: sub/x.ts",
			"@@ context",
			" old line",
			"-removed",
			"+added",
			"*** End Patch",
		].join("\n");
		touch(loader, "t1", "apply_patch", { input: patch });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "sub/AGENTS.md"]);
	});

	test("deriveToolPaths honors path aliases", () => {
		expect(deriveToolPaths("read", { path: "a/x.ts" })).toEqual(["a/x.ts"]);
		expect(deriveToolPaths("edit", { file_path: "a/x.ts", edits: [] })).toEqual(["a/x.ts"]);
		expect(deriveToolPaths("write", { filePath: "a/x.ts", content: "x" })).toEqual(["a/x.ts"]);
		expect(deriveToolPaths("grep", { pattern: "foo" })).toEqual([]);
	});
});

describe("session replacement", () => {
	test("re-registers hooks on a fresh API with sendMessage capture", () => {
		const api1 = makeFakeApi();
		const api2 = makeFakeApi();
		installAgentsMdHooks(api1 as unknown as ExtensionAPI);
		installAgentsMdHooks(api2 as unknown as ExtensionAPI);

		// Both registries must receive every handler — Pi disposes handlers on
		// the old API after /resume, /new, /fork and re-invokes the factory with
		// a fresh API, so a module-global once guard would leave it bare.
		// The context handler is gone — delivery is via sendMessage in tool_execution_end.
		const expectedEvents = [
			"session_start",
			"session_shutdown",
			"tool_call",
			"tool_execution_end",
		];
		for (const api of [api1, api2]) {
			for (const event of expectedEvents) {
				expect(api.handlers.get(event)?.length ?? 0).toBeGreaterThan(0);
			}
		}

		// Exercise the replacement session end-to-end on the second API.
		const sessionStart = api2.handlers.get("session_start")![0];
		const toolCall = api2.handlers.get("tool_call")![0];
		const toolEnd = api2.handlers.get("tool_execution_end")![0];
		const shutdown = api2.handlers.get("session_shutdown")![0];

		sessionStart({ type: "session_start", reason: "startup" }, { cwd: fixture!.root });
		toolCall(
			{ type: "tool_call", toolCallId: "repl-1", toolName: "read", input: { path: "a/file.ts" } },
			{},
		);
		toolEnd({ type: "tool_execution_end", toolCallId: "repl-1", toolName: "read", result: {}, isError: false }, {});
		// After tool_execution_end + rescan + prune, deliverNewFiles should fire.
		// The installAgentsMdHooks wires deliverFn, but the handler does NOT call
		// deliverNewFiles directly — it's called by noteToolExecutionEnd. However,
		// the handler calls noteToolExecutionEnd which calls deliverNewFiles.
		// Check if the API captured any sendMessage calls.
		// Note: the handler calls loader.noteToolExecutionEnd which calls
		// this.deliverNewFiles(). So sendMessage should have been called.
		expect(api2.sendMessageCalls.length).toBeGreaterThanOrEqual(1);
		const lastMsg = api2.sendMessageCalls[api2.sendMessageCalls.length - 1]!;
		expect(lastMsg.customType).toBe(CONTEXT_CUSTOM_TYPE);
		expect(lastMsg.display).toBe(false);
		expect(lastMsg.content).toContain("a instructions");

		// The shared loader is cleared by the replacement session's shutdown,
		// so the module singleton cannot leak instructions into later tests.
		shutdown({ type: "session_shutdown", reason: "resume" }, {});
		// After shutdown, no further delivery should occur on the API.
		expect(api2.sendMessageCalls.filter((m) => m.customType === CONTEXT_CUSTOM_TYPE).length).toBe(1);
	});
});

describe("resume seeding", () => {
	test("history marker pre-seeds delivered set so no re-delivery", () => {
		const api = makeFakeApi();
		// Seed the history with an existing AGENTS.md custom message.
		const path1 = "a/AGENTS.md";
		const content1 = `<agents_md path="${path1}">\na instructions\n</agents_md>`;
		api.historyEntries.push({
			type: "custom_message",
			customType: CONTEXT_CUSTOM_TYPE,
			content: content1,
			role: "custom",
		});

		installAgentsMdHooks(api as unknown as ExtensionAPI);
		const sessionStart = api.handlers.get("session_start")![0];
		sessionStart({ type: "session_start", reason: "resume" }, { cwd: fixture!.root });

		// Now touch the same directory.
		const toolCall = api.handlers.get("tool_call")![0];
		const toolEnd = api.handlers.get("tool_execution_end")![0];
		toolCall(
			{ type: "tool_call", toolCallId: "rs-1", toolName: "read", input: { path: "a/file.ts" } },
			{},
		);
		toolEnd({ type: "tool_execution_end", toolCallId: "rs-1", toolName: "read", result: {}, isError: false }, {});

		// The file was already delivered in the history — no new sendMessage.
		// Only the handler registrations appear, not sendMessage from deliverNewFiles.
		const deliveryCalls = api.sendMessageCalls.filter((m) => m.customType === CONTEXT_CUSTOM_TYPE);
		expect(deliveryCalls.length).toBe(0);
	});

	test("content change after resume re-delivers with new hash", () => {
		const api = makeFakeApi();
		const path1 = "a/AGENTS.md";
		const content1 = `<agents_md path="${path1}">\na instructions\n</agents_md>`;
		api.historyEntries.push({
			type: "custom_message",
			customType: CONTEXT_CUSTOM_TYPE,
			content: content1,
			role: "custom",
		});

		installAgentsMdHooks(api as unknown as ExtensionAPI);
		const sessionStart = api.handlers.get("session_start")![0];
		sessionStart({ type: "session_start", reason: "resume" }, { cwd: fixture!.root });

		// Change the file content.
		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");

		const toolCall = api.handlers.get("tool_call")![0];
		const toolEnd = api.handlers.get("tool_execution_end")![0];
		toolCall(
			{ type: "tool_call", toolCallId: "rs-2", toolName: "read", input: { path: "a/file.ts" } },
			{},
		);
		toolEnd({ type: "tool_execution_end", toolCallId: "rs-2", toolName: "read", result: {}, isError: false }, {});

		// Content changed — should re-deliver.
		const deliveryCalls = api.sendMessageCalls.filter((m) => m.customType === CONTEXT_CUSTOM_TYPE);
		expect(deliveryCalls.length).toBe(1);
		expect(deliveryCalls[0].content).toContain("a revised instructions");
	});
});

describe("no context handler", () => {
	test("there is no context event registered (append-once, not per-request)", () => {
		const api = makeFakeApi();
		installAgentsMdHooks(api as unknown as ExtensionAPI);
		expect(api.handlers.has("context")).toBe(false);
	});
});

describe("path helpers", () => {
	test("toPosixRelative always uses forward slashes", () => {
		expect(toPosixRelative(fixture!.root, path.join(fixture!.root, "a", AGENTS_FILE_NAME))).toBe(
			"a/AGENTS.md",
		);
	});

	test("isInside rejects siblings and parents", () => {
		expect(isInside(fixture!.root, fixture!.outside)).toBe(false);
		expect(isInside(fixture!.root, path.dirname(fixture!.root))).toBe(false);
		expect(isInside(fixture!.root, path.join(fixture!.root, "a"))).toBe(true);
		expect(isInside(fixture!.root, fixture!.root)).toBe(true);
	});
});
