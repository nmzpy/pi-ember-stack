import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __reset_state } from "../index.ts";

// The reducer (apply_mutation) is module-private and side-effect free; these
// tests exercise it indirectly through the public execute() surface using a
// stub ExtensionAPI. This keeps the test hermetic without exporting internals.

import piEmberTodo from "../index.ts";

type ToolHandler = {
	execute: (id: string, params: any, signal: unknown, on_update: unknown, ctx: any) => Promise<any>;
	prepareArguments?: (args: unknown) => unknown;
};

function make_api(): {
	pi: any;
	tools: Map<string, ToolHandler>;
	commands: Map<string, { handler: (args: any, ctx: any) => Promise<void> }>;
	events: Map<string, ((event: any, ctx: any) => Promise<void>)[]>;
} {
	const tools = new Map<string, ToolHandler>();
	const commands = new Map<string, { handler: (args: any, ctx: any) => Promise<void> }>();
	const events = new Map<string, ((event: any, ctx: any) => Promise<void>)[]>();
	const pi = {
		registerTool: (def: any) => {
			tools.set(def.name, { execute: def.execute, prepareArguments: def.prepareArguments });
		},
		registerCommand: (name: string, def: any) => {
			commands.set(name, def);
		},
		on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	};
	return { pi, tools, commands, events };
}

function make_ctx(session_id: string, branch: any[] = []): any {
	return {
		sessionManager: {
			getSessionId: () => session_id,
			getBranch: () => branch,
		},
	};
}

async function run(
	tools: Map<string, ToolHandler>,
	ctx: any,
	params: any,
): Promise<{ text: string; details: any; isError?: boolean }> {
	const tool = tools.get("todo")!;
	const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
	const res = await tool.execute("call-1", prepared, undefined, undefined, ctx);
	return {
		text: res.content[0].text,
		details: res.details,
		isError: res.isError,
	};
}

describe("pi-ember-todo reducer", () => {
	beforeEach(() => {
		__reset_state();
	});

	afterEach(() => {
		__reset_state();
	});

	test("create + list round-trip", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s1");
		await run(tools, ctx, { action: "create", subject: "Write tests" });
		await run(tools, ctx, { action: "create", subject: "Ship it" });
		const list = await run(tools, ctx, { action: "list" });
		expect(list.text).toContain("#1 Write tests");
		expect(list.text).toContain("#2 Ship it");
	});

	test("status lifecycle rejects completed → pending", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s2");
		await run(tools, ctx, { action: "create", subject: "A" });
		await run(tools, ctx, { action: "update", id: 1, status: "in_progress" });
		await run(tools, ctx, { action: "update", id: 1, status: "completed" });
		const bad = await run(tools, ctx, { action: "update", id: 1, status: "pending" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("illegal transition");
	});

	test("blockedBy cycle is rejected", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s3");
		await run(tools, ctx, { action: "create", subject: "A" });
		await run(tools, ctx, { action: "create", subject: "B", blockedBy: [1] });
		const cycle = await run(tools, ctx, { action: "update", id: 1, addBlockedBy: [2] });
		expect(cycle.isError).toBe(true);
		expect(cycle.text).toContain("cycle");
	});

	test("delete scrubs blockedBy on dependents", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s4");
		await run(tools, ctx, { action: "create", subject: "A" });
		await run(tools, ctx, { action: "create", subject: "B", blockedBy: [1] });
		await run(tools, ctx, { action: "delete", id: 1 });
		const got = await run(tools, ctx, { action: "get", id: 2 });
		expect(got.text).not.toContain("blockedBy: #1");
	});

	test("string id coercion accepts '1' but rejects '2.7'", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s5");
		await run(tools, ctx, { action: "create", subject: "A" });
		const ok = await run(tools, ctx, { action: "update", id: "1", status: "in_progress" });
		expect(ok.isError).toBeUndefined();
		const bad = await run(tools, ctx, { action: "update", id: "2.7", status: "completed" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("id must be a number");
	});

	test("update without mutable field surfaces error", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s6");
		await run(tools, ctx, { action: "create", subject: "A" });
		const bad = await run(tools, ctx, { action: "update", id: 1 });
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("at least one mutable field");
	});

	test("Cursor-style todos array updates status", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s8");
		await run(tools, ctx, { action: "create", subject: "Module 1" });
		const ok = await run(tools, ctx, {
			todos: [{ id: 1, content: "Module 1", status: "in_progress" }],
		});
		expect(ok.isError).toBeFalsy();
		expect(ok.details.tasks[0].status).toBe("in_progress");
	});

	test("clear wipes all tasks", async () => {
		const { pi, tools } = make_api();
		piEmberTodo(pi);
		const ctx = make_ctx("s7");
		await run(tools, ctx, { action: "create", subject: "A" });
		await run(tools, ctx, { action: "create", subject: "B" });
		const cleared = await run(tools, ctx, { action: "clear" });
		expect(cleared.text).toContain("Cleared 2 tasks");
		const list = await run(tools, ctx, { action: "list" });
		expect(list.text).toBe("No tasks");
	});
});
