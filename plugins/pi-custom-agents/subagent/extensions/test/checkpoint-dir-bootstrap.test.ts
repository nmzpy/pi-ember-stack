/**
 * Regression tests for the deterministic subagent-sessions directory bootstrap.
 *
 * Root cause of the historical ENOENT: the run-record
 * `<timestamp>_<childSessionId>.jsonl` is written by the SDK's SessionManager
 * inside `subagent-sessions/<parentSessionId>/<originToolCallId>/`, but that
 * directory was only created lazily (the SDK's guarded `existsSync -> mkdir`
 * in the SessionManager constructor runs before the first *asynchronous*
 * `openSync(...,"wx")`/`appendFileSync` when the first assistant entry
 * persists). A concurrent `prune_foreign_checkpoints()` on session shutdown
 * could delete the live dir in that window, so the first recording write hit
 * ENOENT. The fix guarantees the directory exists synchronously before ANY
 * open/write/append via `subagent_sessions_dir_for()` (the helper the runner
 * uses) — never relying on a prior async op or existsSync pre-check.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	get_checkpoint_dir,
	open_checkpoint_meta,
	read_resume_meta,
	resolve_resume_target,
	set_subagent_sessions_root_override,
	subagent_sessions_dir_for,
} from "../resume-store.ts";

afterEach(() => {
	set_subagent_sessions_root_override(undefined);
});

function with_isolated_store(run: (root: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-store-"));
	const root = path.join(dir, "agent", "subagent-sessions");
	set_subagent_sessions_root_override(root);
	try {
		run(root);
	} finally {
		set_subagent_sessions_root_override(undefined);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("subagent-sessions directory bootstrap", () => {
	test("recording a run-record line bootstraps the missing dir and a second line appends to the same file", () => {
		with_isolated_store((root) => {
			const parentSessionId = "parent-bootstrap";
			const originToolCallId = "call_first";
			const dir = get_checkpoint_dir(parentSessionId, originToolCallId);
			expect(fs.existsSync(dir)).toBe(false); // directory does not exist yet

			// The same helper the runner uses: synchronous mkdir before ANY write.
			const ensured = subagent_sessions_dir_for(parentSessionId, originToolCallId);
			expect(ensured).toBe(dir);
			expect(fs.existsSync(ensured)).toBe(true);

			// Record the run exactly like the runner: the SDK SessionManager
			// writes the <timestamp>_<childSessionId>.jsonl run-record inside the
			// ensured dir. First write uses openSync(...,"wx") (fresh file); the
			// second line must append to the SAME file.
			const session = SessionManager.create("/tmp/fake-project", ensured);
			const session_file = session.getSessionFile();
			expect(session_file).toBeDefined();
			expect(path.dirname(session_file as string)).toBe(ensured);
			expect(path.basename(session_file as string)).toMatch(/^\d{4}-.*\.jsonl$/);

			// A user message does not flush (no assistant yet), so the first
			// actual file open happens on the first assistant entry.
			session.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
			expect(fs.existsSync(session_file as string)).toBe(false);

			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer one" }] });
			expect(fs.existsSync(session_file as string)).toBe(true);
			const first_bytes = fs.readFileSync(session_file as string, "utf8");
			expect(first_bytes).toContain("answer one");

			// Second line appended to the SAME file also succeeds.
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer two" }] });
			const second_bytes = fs.readFileSync(session_file as string, "utf8");
			expect(second_bytes.length).toBeGreaterThan(first_bytes.length);
			expect(second_bytes).toContain("answer one");
			expect(second_bytes).toContain("answer two");
			expect(second_bytes.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(4);
		});
	});

	test("the bootstrap helper is idempotent and parallel-safe for sibling calls", () => {
		with_isolated_store((root) => {
			const parentSessionId = "parent-parallel";
			const first = subagent_sessions_dir_for(parentSessionId, "call_a");
			const second = subagent_sessions_dir_for(parentSessionId, "call_b");
			expect(first).toBe(path.join(root, parentSessionId, "call_a"));
			expect(second).toBe(path.join(root, parentSessionId, "call_b"));
			expect(fs.existsSync(first)).toBe(true);
			expect(fs.existsSync(second)).toBe(true);
			// Re-calling the same ids returns the same path and does not throw.
			expect(subagent_sessions_dir_for(parentSessionId, "call_a")).toBe(first);
		});
	});

	test("resume scan returns empty (no throw) when the parent-session dir does not exist", () => {
		with_isolated_store((root) => {
			const parentSessionId = "parent-ghost";
			expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

			expect(read_resume_meta(parentSessionId, "call_never")).toBeUndefined();
			expect(open_checkpoint_meta(parentSessionId, "Coder A")).toBeUndefined();

			const ctx = {
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => parentSessionId,
					getBranch: () => [],
				},
			};
			const resolved = resolve_resume_target(ctx as never, "Coder A");
			expect(resolved.ok).toBe(false);
		});
	});

	test("recording still succeeds when the parent dir exists but the origin dir is missing", () => {
		with_isolated_store((root) => {
			const parentSessionId = "parent-existing";
			fs.mkdirSync(path.join(root, parentSessionId), { recursive: true });

			const originToolCallId = "call_origin_missing";
			const dir = get_checkpoint_dir(parentSessionId, originToolCallId);
			expect(fs.existsSync(dir)).toBe(false);

			const ensured = subagent_sessions_dir_for(parentSessionId, originToolCallId);
			expect(ensured).toBe(dir);
			expect(fs.existsSync(ensured)).toBe(true);

			const session = SessionManager.create("/tmp/fake-project", ensured);
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
			expect(fs.existsSync(session.getSessionFile() as string)).toBe(true);
		});
	});
});
