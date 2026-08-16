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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

function contextMessage(
	loader: AgentsMdLoader,
	existing: AgentMessage[] = [],
): AgentMessage | undefined {
	return loader.buildContextMessage(existing);
}

function contextContent(loader: AgentsMdLoader): string {
	const message = contextMessage(loader);
	expect(message).toBeDefined();
	return String((message as { content: string }).content);
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

describe("root boundary and exclusion", () => {
	test("root AGENTS.md is never auto-loaded", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md"]);
		expect(contextContent(loader)).not.toContain("root instructions");
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
		expect(contextContent(loader)).toContain("a instructions");
		expect(contextContent(loader)).toContain("sub instructions");
	});
});

describe("hierarchy shallow -> deep", () => {
	test("deep target activates ancestors in shallow-to-deep order", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/b/deep.ts" });
		expect(loader.activeFiles()).toEqual(["a/AGENTS.md", "a/b/AGENTS.md"]);
		const content = contextContent(loader);
		expect(content.indexOf("a instructions")).toBeLessThan(content.indexOf("b instructions"));
		expect(content).toBe(
			`<agents_md path="a/AGENTS.md">\na instructions\n</agents_md>\n\n<agents_md path="a/b/AGENTS.md">\nb instructions\n</agents_md>`,
		);
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
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		expect(contextContent(loader)).toContain("a instructions");

		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");
		loader.noteToolExecutionEnd("t1");
		expect(contextContent(loader)).toContain("a revised instructions");
		expect(contextContent(loader)).not.toContain("a instructions");
	});

	test("deleted AGENTS.md is dropped after tool_execution_end", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		expect(loader.activeCount).toBe(1);

		fs.rmSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME));
		loader.noteToolExecutionEnd("t1");
		expect(loader.activeCount).toBe(0);
		expect(contextMessage(loader)).toBeUndefined();
	});

	test("AGENTS.md created by a write is activated after execution", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "write", { path: "plain/AGENTS.md", content: "draft" });
		expect(loader.activeCount).toBe(0); // not yet on disk during tool_call

		fs.mkdirSync(path.join(fixture!.root, "plain"), { recursive: true });
		fs.writeFileSync(path.join(fixture!.root, "plain", AGENTS_FILE_NAME), "plain final");
		loader.noteToolExecutionEnd("t1");
		expect(loader.activeFiles()).toEqual(["plain/AGENTS.md"]);
		expect(contextContent(loader)).toContain("plain final");
	});
});

describe("context message", () => {
	test("is a single hidden custom message in canonical order", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/b/deep.ts" });
		const message = contextMessage(loader);
		expect(message).toBeDefined();
		expect((message as { role: string }).role).toBe("custom");
		expect((message as { customType: string }).customType).toBe(CONTEXT_CUSTOM_TYPE);
		expect((message as { display: boolean }).display).toBe(false);
		expect((message as { content: string }).content).toContain("<agents_md path=");
	});

	test("does not mutate the incoming message array", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const incoming: AgentMessage[] = [
			{ role: "user", content: "hi" } as unknown as AgentMessage,
		];
		const before = incoming.length;
		const result = loader.buildContextMessage(incoming);
		expect(incoming.length).toBe(before);
		expect((result as { content: string }).content).toContain("a instructions");
	});

	test("skips when the messages already carry the custom marker", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const already: AgentMessage[] = [
			{
				role: "custom",
				customType: CONTEXT_CUSTOM_TYPE,
				content: "persisted copy",
				display: false,
				timestamp: 1,
			} as unknown as AgentMessage,
		];
		expect(loader.buildContextMessage(already)).toBeUndefined();
	});

	test("returns undefined with no active files", () => {
		const loader = makeLoader(fixture!.root);
		expect(contextMessage(loader)).toBeUndefined();
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
		expect(contextContent(loader)).not.toContain("sub/sub instructions");
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
		touch(loader, "t1", "bash", { command: `cd ${fixture!.root} && grep pattern a/AGENTS.md` });
		expect(contextContent(loader)).toContain("a instructions");

		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");
		touch(loader, "t2", "bash", { command: `cd ${fixture!.root} && grep pattern a/AGENTS.md` });
		expect(contextContent(loader)).toContain("a revised instructions");
		expect(contextContent(loader)).not.toContain("a instructions");
	});

	test("bare tokens without a separator stay rejected", () => {
		const loader = makeLoader(fixture!.root);
		touch(loader, "t1", "bash", { command: "grep -rn pattern" });
		expect(loader.activeCount).toBe(0);
	});
});

describe("context message refresh (regression)", () => {
	test("existing marker message is updated in place with fresh content", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const already: AgentMessage[] = [
			{
				role: "custom",
				customType: CONTEXT_CUSTOM_TYPE,
				content: "persisted copy",
				display: false,
				timestamp: 1,
			} as unknown as AgentMessage,
		];
		expect(loader.buildContextMessage(already)).toBeUndefined();
		expect((already[0] as { content: string }).content).toContain("a instructions");
		expect((already[0] as { content: string }).content).not.toContain("persisted copy");
	});

	test("refreshed cache replaces stale marker content without duplicating", () => {
		const loader = makeLoader(fixture!.root);
		loader.noteToolCall("t1", "read", { path: "a/file.ts" });
		const already: AgentMessage[] = [
			{
				role: "custom",
				customType: CONTEXT_CUSTOM_TYPE,
				content: "stale",
				display: false,
				timestamp: 1,
			} as unknown as AgentMessage,
		];
		expect(loader.buildContextMessage(already)).toBeUndefined();
		expect(already.length).toBe(1);

		fs.writeFileSync(path.join(fixture!.root, "a", AGENTS_FILE_NAME), "a revised instructions");
		loader.noteToolExecutionEnd("t1");
		expect(loader.buildContextMessage(already)).toBeUndefined();
		expect((already[0] as { content: string }).content).toContain("a revised instructions");
		expect((already[0] as { content: string }).content).not.toContain("a instructions");
		expect(already.length).toBe(1);
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
		expect(deriveToolPaths("todo", { action: "create" })).toEqual([]);
	});
});

describe("session replacement", () => {
	test("re-registers all hooks on a fresh API and keeps replacement sessions functional", () => {
		const api1 = makeFakeApi();
		const api2 = makeFakeApi();
		installAgentsMdHooks(api1 as unknown as ExtensionAPI);
		installAgentsMdHooks(api2 as unknown as ExtensionAPI);

		// Both registries must receive every handler — Pi disposes handlers on
		// the old API after /resume, /new, /fork and re-invokes the factory with
		// a fresh API, so a module-global once guard would leave it bare.
		const expectedEvents = [
			"session_start",
			"session_shutdown",
			"tool_call",
			"tool_execution_end",
			"context",
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
		const context = api2.handlers.get("context")![0];
		const shutdown = api2.handlers.get("session_shutdown")![0];

		sessionStart({ type: "session_start", reason: "startup" }, { cwd: fixture!.root });
		toolCall(
			{ type: "tool_call", toolCallId: "repl-1", toolName: "read", input: { path: "a/file.ts" } },
			{},
		);
		toolEnd({ type: "tool_execution_end", toolCallId: "repl-1", toolName: "read", result: {}, isError: false }, {});
		const result = context({ type: "context", messages: [] }, {});
		expect(result).toBeDefined();
		const messages = (result as { messages: AgentMessage[] }).messages;
		expect(messages.length).toBe(1);
		expect((messages[0] as { customType: string }).customType).toBe(CONTEXT_CUSTOM_TYPE);
		expect((messages[0] as { content: string }).content).toContain("a instructions");

		// The shared loader is cleared by the replacement session's shutdown,
		// so the module singleton cannot leak instructions into later tests.
		shutdown({ type: "session_shutdown", reason: "resume" }, {});
		expect(context({ type: "context", messages: [] }, {})).toBeUndefined();
	});
});

function makeFakeApi(): {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	return {
		handlers,
		on(event, handler) {
			let list = handlers.get(event);
			if (!list) {
				list = [];
				handlers.set(event, list);
			}
			list.push(handler);
		},
	};
}

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
