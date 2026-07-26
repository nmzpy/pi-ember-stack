import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	filesystem_safe_tool_call_id,
	get_checkpoint_dir,
	open_checkpoint_meta,
	persist_checkpoint_meta,
	resolve_resume_target,
} from "../resume-store.ts";

const ORIGINAL_PI_HOME = process.env.PI_HOME;

afterEach(() => {
	if (ORIGINAL_PI_HOME === undefined) delete process.env.PI_HOME;
	else process.env.PI_HOME = ORIGINAL_PI_HOME;
});

function with_temp_agent_dir(run: (agent_dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-resume-"));
	process.env.PI_HOME = dir;
	const agent_dir = path.join(dir, "agent");
	fs.mkdirSync(agent_dir, { recursive: true });
	try {
		run(agent_dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("resume-store", () => {
	test("persist and open checkpoint by display name", () => {
		with_temp_agent_dir(() => {
			const parentSessionId = "parent-1";
			const originToolCallId = "call-1";
			const checkpoint_dir = get_checkpoint_dir(parentSessionId, originToolCallId);
			fs.mkdirSync(checkpoint_dir, { recursive: true });
			const session_file = path.join(checkpoint_dir, "session.jsonl");
			fs.writeFileSync(session_file, '{"type":"session"}\n');

			persist_checkpoint_meta({
				parentSessionId,
				originToolCallId,
				displayName: "Coder A",
				agentName: "Coder",
				cwd: "/tmp/project",
				sessionFile: session_file,
				updatedAt: new Date().toISOString(),
			});

			const meta = open_checkpoint_meta(parentSessionId, "Coder A");
			expect(meta?.originToolCallId).toBe("call-1");
			expect(meta?.agentName).toBe("Coder");
		});
	});

	test("resolve_resume_target finds lettered agent from branch and disk", () => {
		with_temp_agent_dir(() => {
			const parentSessionId = "parent-abc";
			const originToolCallId = "tc-1";
			const checkpoint_dir = get_checkpoint_dir(parentSessionId, originToolCallId);
			fs.mkdirSync(checkpoint_dir, { recursive: true });
			const session_file = path.join(checkpoint_dir, "session.jsonl");
			fs.writeFileSync(session_file, '{"type":"session"}\n');
			persist_checkpoint_meta({
				parentSessionId,
				originToolCallId,
				displayName: "Coder A",
				agentName: "Coder",
				cwd: "/repo",
				sessionFile: session_file,
				updatedAt: new Date().toISOString(),
			});

			const branch = [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "tc-1",
								name: "subagent",
								arguments: { agent: "Coder", task: "start" },
							},
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "subagent",
						toolCallId: "tc-1",
						details: {
							mode: "single",
							results: [{ agent: "Coder A", task: "start", exitCode: 0, messages: [] }],
						},
					},
				},
			];

			const ctx = {
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => parentSessionId,
					getBranch: () => branch,
				},
			};

			const resolved = resolve_resume_target(ctx as never, "Coder A");
			expect(resolved.ok).toBe(true);
			if (resolved.ok) {
				expect(resolved.target.originToolCallId).toBe("tc-1");
				expect(resolved.target.agentName).toBe("Coder");
			}
		});
	});

	test("resolve_resume_target errors when no prior run exists", () => {
		with_temp_agent_dir(() => {
			const ctx = {
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "empty-parent",
					getBranch: () => [],
				},
			};
			const resolved = resolve_resume_target(ctx as never, "Coder A");
			expect(resolved.ok).toBe(false);
		});
	});

	test("checkpoint dir sanitizes pipe characters in tool call ids", () => {
		with_temp_agent_dir(() => {
			const parentSessionId = "parent-1";
			const originToolCallId = "call_abc|fc_deadbeef";
			const safe_id = filesystem_safe_tool_call_id(originToolCallId);
			expect(safe_id).toBe("call_abc_fc_deadbeef");
			expect(safe_id).not.toContain("|");

			const checkpoint_dir = get_checkpoint_dir(parentSessionId, originToolCallId);
			expect(checkpoint_dir).toContain(safe_id);
			expect(checkpoint_dir).not.toContain("|");

			fs.mkdirSync(checkpoint_dir, { recursive: true });
			const session_file = path.join(checkpoint_dir, "session.jsonl");
			fs.writeFileSync(session_file, '{"type":"session"}\n');

			persist_checkpoint_meta({
				parentSessionId,
				originToolCallId,
				displayName: "Scout A",
				agentName: "Scout",
				cwd: "/tmp/project",
				sessionFile: session_file,
				updatedAt: new Date().toISOString(),
			});

			const meta = open_checkpoint_meta(parentSessionId, "Scout A");
			expect(meta?.originToolCallId).toBe(originToolCallId);
			expect(fs.existsSync(path.join(checkpoint_dir, "meta.json"))).toBe(true);
		});
	});
});
