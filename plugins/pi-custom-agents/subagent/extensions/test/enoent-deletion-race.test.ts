/**
 * Reproduces the SDK SessionManager deletion race that surfaces as
 * `ENOENT: no such file or directory, open ~/.pi/agent/subagent-sessions/...`.
 *
 * The SDK writes its run-record (`<timestamp>_<childSessionId>.jsonl`) lazily
 * on the FIRST assistant message, via `openSync(..., "wx")`. If that directory
 * is deleted between `SessionManager.create()` and the first assistant write
 * (exactly what a concurrent `prune_foreign_checkpoints()` can do mid-run), the
 * open throws ENOENT and fails the whole subagent run.
 *
 * This file documents the race and proves the fix: a live checkpoint dir that
 * is marked live is never pruned, so the directory deterministically exists for
 * every SDK write.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	get_checkpoint_dir,
	mark_checkpoint_dir_live,
	prune_foreign_checkpoints,
	set_subagent_sessions_root_override,
	subagent_sessions_dir_for,
	unmark_checkpoint_dir_live,
} from "../resume-store.ts";

afterEach(() => {
	set_subagent_sessions_root_override(undefined);
});

describe("subagent-sessions run-record deletion race", () => {
	test("SDK throws ENOENT when the checkpoint dir vanishes before the first assistant write", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-race-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-deleted-mid-run";
		const originToolCallId = "call_race";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);
		expect(fs.existsSync(checkpoint_dir)).toBe(true);

		// SessionManager is created against the bootstrapped dir (exists, so the
		// SDK skips its guarded re-mkdir) and its run-record is written lazily on
		// the FIRST assistant message.
		const session = SessionManager.create("/tmp/fake-project", checkpoint_dir);
		const session_file = session.getSessionFile();
		expect(fs.existsSync(session_file as string)).toBe(false); // not written yet

		// Simulate what a concurrent prune does to a foreign parent session
		// DURING the run: the live directory is removed after SessionManager
		// creation but before the first assistant write lands.
		fs.rmSync(path.join(root, parentSessionId), { recursive: true, force: true });
		expect(fs.existsSync(checkpoint_dir)).toBe(false);

		// First assistant write triggers the SDK's openSync(..., "wx") — the
		// exact call that throws ENOENT when the dir is gone mid-run.
		expect(() => {
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "boom" }] });
		}).toThrow();
		expect(fs.existsSync(session_file as string)).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a live-marked checkpoint dir survives foreign-parent pruning", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-live-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-live";
		const originToolCallId = "call_live";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);
		mark_checkpoint_dir_live(checkpoint_dir);
		try {
			// A prune from a DIFFERENT (foreign) active session must never
			// remove a directory that a live subagent is still writing to.
			prune_foreign_checkpoints("some-other-session");
			expect(fs.existsSync(checkpoint_dir)).toBe(true);
		} finally {
			unmark_checkpoint_dir_live(checkpoint_dir);
		}

		// Once the run finishes, the mark is dropped and the dir is disposable.
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(checkpoint_dir)).toBe(false);
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("active-session pruning still clears stale foreign dirs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-active-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const activeSessionId = "session-active";
		const stale = subagent_sessions_dir_for("session-stale", "call_old");
		expect(fs.existsSync(stale)).toBe(true);

		const live = get_checkpoint_dir(activeSessionId, "call_live");
		subagent_sessions_dir_for(activeSessionId, "call_live");
		mark_checkpoint_dir_live(live);
		try {
			prune_foreign_checkpoints(activeSessionId);
		} finally {
			unmark_checkpoint_dir_live(live);
		}

		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
