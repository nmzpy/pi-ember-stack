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
	is_live_marker_fresh,
	LIVE_MARKER_FILE,
	LIVE_MARKER_TTL_MS,
	type LiveMarkerData,
	mark_checkpoint_dir_live,
	persist_checkpoint_meta,
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
		// The durable marker is written synchronously alongside the in-memory mark.
		expect(fs.existsSync(path.join(checkpoint_dir, LIVE_MARKER_FILE))).toBe(true);
		try {
			// A prune from a DIFFERENT (foreign) active session must never
			// remove a directory that a live subagent is still writing to.
			prune_foreign_checkpoints("some-other-session");
			expect(fs.existsSync(checkpoint_dir)).toBe(true);
		} finally {
			unmark_checkpoint_dir_live(checkpoint_dir);
		}

		// Unmark removes the durable marker, so the dir is disposable again.
		expect(fs.existsSync(path.join(checkpoint_dir, LIVE_MARKER_FILE))).toBe(false);

		// Once the run finishes, the mark is dropped and the dir is disposable.
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(checkpoint_dir)).toBe(false);
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("mid-run foreign prune cannot break the SDK's lazy first assistant write", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-race-endtoend-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-endtoend-live";
		const originToolCallId = "call_endtoend";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);

		// Runner order: synchronous bootstrap (dir exists) THEN the durable live
		// mark is written — both before SessionManager.create and before any
		// async boundary, so a foreign prune can never land between them.
		mark_checkpoint_dir_live(checkpoint_dir);
		const session = SessionManager.create("/tmp/fake-project", checkpoint_dir);
		const session_file = session.getSessionFile();
		expect(fs.existsSync(session_file as string)).toBe(false); // lazy run-record

		try {
			// Foreign parent session shuts down and prunes mid-run — exactly the
			// historical ENOENT window. The durable marker must protect us.
			prune_foreign_checkpoints("some-other-session");
			expect(fs.existsSync(checkpoint_dir)).toBe(true);

			// The SDK's lazy openSync(..., "wx") must succeed: no ENOENT.
			expect(() => {
				session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
			}).not.toThrow();
			expect(fs.existsSync(session_file as string)).toBe(true);
			const bytes = fs.readFileSync(session_file as string, "utf8");
			expect(bytes).toContain("ok");
		} finally {
			unmark_checkpoint_dir_live(checkpoint_dir);
		}

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

	test("a fresh durable marker protects the dir from a foreign process with no in-memory mark", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-durable-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-durable-live";
		const originToolCallId = "call_durable";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);

		// Simulate a DIFFERENT Pi process: the marker is written directly to disk
		// and THIS module instance never called mark_checkpoint_dir_live, so its
		// in-memory Set is empty — exactly what a foreign prune would observe.
		const marker: LiveMarkerData = {
			version: 1,
			pid: 424242,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		fs.writeFileSync(
			path.join(checkpoint_dir, LIVE_MARKER_FILE),
			`${JSON.stringify(marker)}\n`,
			"utf8",
		);

		prune_foreign_checkpoints("some-other-session");

		expect(fs.existsSync(checkpoint_dir)).toBe(true);
		expect(fs.existsSync(path.join(checkpoint_dir, LIVE_MARKER_FILE))).toBe(true);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a stale durable marker does not protect a crashed run's dir forever", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-stale-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-durable-stale";
		const originToolCallId = "call_stale";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);

		// A crashed run's marker: fresh when written, now far past the TTL.
		const stale_marker: LiveMarkerData = {
			version: 1,
			pid: 999,
			startedAt: 0,
			updatedAt: Date.now() - LIVE_MARKER_TTL_MS - 1000,
		};
		fs.writeFileSync(
			path.join(checkpoint_dir, LIVE_MARKER_FILE),
			`${JSON.stringify(stale_marker)}\n`,
			"utf8",
		);

		prune_foreign_checkpoints("some-other-session");

		expect(fs.existsSync(checkpoint_dir)).toBe(false);
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a stale sibling marker is reaped while a fresh marker still protects the parent", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-mixed-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-durable-mixed";
		const stale_dir = subagent_sessions_dir_for(parentSessionId, "call_stale");
		const live_dir = subagent_sessions_dir_for(parentSessionId, "call_live");

		const stale_marker: LiveMarkerData = {
			version: 1,
			pid: 888,
			startedAt: 0,
			updatedAt: Date.now() - LIVE_MARKER_TTL_MS - 5000,
		};
		fs.writeFileSync(
			path.join(stale_dir, LIVE_MARKER_FILE),
			`${JSON.stringify(stale_marker)}\n`,
			"utf8",
		);
		const fresh_marker: LiveMarkerData = {
			version: 1,
			pid: 777,
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		fs.writeFileSync(
			path.join(live_dir, LIVE_MARKER_FILE),
			`${JSON.stringify(fresh_marker)}\n`,
			"utf8",
		);

		prune_foreign_checkpoints("some-other-session");

		// The parent is protected by the fresh marker, so it survives as a whole;
		// the stale marker was reaped during the scan so it cannot protect later.
		expect(fs.existsSync(live_dir)).toBe(true);
		expect(fs.existsSync(stale_dir)).toBe(true);
		expect(fs.existsSync(path.join(stale_dir, LIVE_MARKER_FILE))).toBe(false);

		// Once the live run finishes (marker removed), the parent is disposable.
		fs.rmSync(path.join(live_dir, LIVE_MARKER_FILE), { force: true });
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("finalization ordering keeps the dir protected through checkpoint persistence", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-finalize-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-finalize";
		const originToolCallId = "call_finalize";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);

		// Runner finalize path order: mark -> persist checkpoint meta -> unmark.
		// While the durable marker is held, a foreign prune must never observe an
		// unprotected incomplete checkpoint.
		mark_checkpoint_dir_live(checkpoint_dir);
		try {
			const session_file = path.join(checkpoint_dir, "2026-01-01T00_00000_0000.jsonl");
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

			// Mid-finalize foreign prune still skips (marker held).
			prune_foreign_checkpoints("some-other-session");
			expect(fs.existsSync(checkpoint_dir)).toBe(true);
			expect(fs.existsSync(path.join(checkpoint_dir, "meta.json"))).toBe(true);
			expect(fs.existsSync(path.join(checkpoint_dir, LIVE_MARKER_FILE))).toBe(true);
		} finally {
			unmark_checkpoint_dir_live(checkpoint_dir);
		}

		// After unmark (post-persistence) the dir is disposable again.
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("is_live_marker_fresh applies the TTL boundary deterministically", () => {
		const marker: LiveMarkerData = { version: 1, pid: 1, startedAt: 1000, updatedAt: 1000 };
		expect(is_live_marker_fresh(marker, 1000 + LIVE_MARKER_TTL_MS - 1)).toBe(true);
		expect(is_live_marker_fresh(marker, 1000 + LIVE_MARKER_TTL_MS)).toBe(false);
	});

	test("mark refresh preserves startedAt and bumps updatedAt (direct write replace)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-refresh-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-refresh";
		const originToolCallId = "call_refresh";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);
		const marker_path = path.join(checkpoint_dir, LIVE_MARKER_FILE);

		mark_checkpoint_dir_live(checkpoint_dir);
		const first = JSON.parse(fs.readFileSync(marker_path, "utf8")) as LiveMarkerData;
		expect(first.pid).toBe(process.pid);
		expect(first.startedAt).toBeGreaterThan(0);
		// Re-calling mark must replace the existing marker in place (the same
		// operation a foreign process's unmark can race), preserving the original
		// start time and refreshing the freshness source.
		mark_checkpoint_dir_live(checkpoint_dir);
		const second = JSON.parse(fs.readFileSync(marker_path, "utf8")) as LiveMarkerData;
		expect(second.startedAt).toBe(first.startedAt);
		expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
		expect(second.pid).toBe(process.pid);

		unmark_checkpoint_dir_live(checkpoint_dir);
		expect(fs.existsSync(marker_path)).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("an unparseable marker protects while its mtime is fresh and is reaped once stale", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-unparseable-"));
		const root = path.join(dir, "agent", "subagent-sessions");
		set_subagent_sessions_root_override(root);

		const parentSessionId = "parent-unparseable";
		const originToolCallId = "call_unparseable";
		const checkpoint_dir = subagent_sessions_dir_for(parentSessionId, originToolCallId);
		const marker_path = path.join(checkpoint_dir, LIVE_MARKER_FILE);

		// A crashed mid-write marker: unparseable content with a FRESH mtime.
		// Conservatively treated as live — a live dir is never pruned.
		fs.writeFileSync(marker_path, '{"version":1,"pid":1,"starte', "utf8");
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(checkpoint_dir)).toBe(true);

		// Age the mtime past the TTL: now stale, reaped with the parent.
		const old = new Date(Date.now() - LIVE_MARKER_TTL_MS - 60_000);
		fs.utimesSync(marker_path, old, old);
		prune_foreign_checkpoints("some-other-session");
		expect(fs.existsSync(checkpoint_dir)).toBe(false);
		expect(fs.existsSync(path.join(root, parentSessionId))).toBe(false);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
