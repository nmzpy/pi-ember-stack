import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	peek_session_catalog,
	reset_session_catalog,
	type SessionCatalogKey,
} from "../../pi-ember-sessions/session-index.ts";
import {
	bind_model_picker_session,
	get_resume_sessions_for_tests,
	reset_model_picker_session,
} from "../model-picker.ts";

/**
 * The /resume catalog is warmed at `session_start` and then answered from
 * memory. Building it parses every session file in the project dir, so the
 * contract under test is: a picker hit NEVER waits for that parse — a cold hit
 * answers from the on-disk index (or an empty list) and the rows appear when the
 * background scan publishes.
 */

// Keep the on-disk catalog out of the real agent home.
const previous_home = process.env.PI_HOME;
const cache_home = mkdtempSync(join(tmpdir(), "pi-ember-resume-catalog-home-"));

beforeAll(() => {
	process.env.PI_HOME = cache_home;
});

// Bun runs test files in one process; re-assert the isolated home per test so a
// neighboring file's afterAll can never point a write at the real agent home.
beforeEach(() => {
	process.env.PI_HOME = cache_home;
});

afterAll(() => {
	if (previous_home === undefined) delete process.env.PI_HOME;
	else process.env.PI_HOME = previous_home;
	rmSync(cache_home, { recursive: true, force: true });
});

const created_dirs: string[] = [];

function temp_session_dir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ember-resume-catalog-"));
	created_dirs.push(dir);
	return dir;
}

function write_session_file(dir: string, id: string, first_message: string): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-09-01T10:00:00.000Z",
			cwd: dir,
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-1`,
			parentId: null,
			timestamp: "2026-09-01T10:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: first_message }] },
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-2`,
			parentId: `${id}-1`,
			timestamp: "2026-09-01T10:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "acknowledged" }] },
		}),
	];
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function fake_ctx(dir: string): unknown {
	return {
		mode: "tui",
		hasUI: true,
		cwd: dir,
		ui: {},
		sessionManager: { getCwd: () => dir, getSessionDir: () => dir },
	};
}

function bind(dir: string): void {
	bind_model_picker_session(fake_ctx(dir) as never, {} as never);
}

async function catalog_ids(): Promise<string[]> {
	return (await get_resume_sessions_for_tests()).map((session) => session.id).sort();
}

function catalog_key(dir: string): SessionCatalogKey {
	return { cwd: dir, sessionDir: dir };
}

/** Poll until the background scan lands (small temp dirs: a few ms). */
async function wait_for_catalog(expected: string[], timeout_ms = 3_000): Promise<string[]> {
	const target = [...expected].sort();
	const deadline = Date.now() + timeout_ms;
	let last: string[] = [];
	while (Date.now() < deadline) {
		last = await catalog_ids();
		if (JSON.stringify(last) === JSON.stringify(target)) return last;
		await Bun.sleep(10);
	}
	return last;
}

/** Poll the hit-path catalog until one row reports an expected message count. */
async function wait_for_row(id: string, count: number, timeout_ms = 3_000) {
	const deadline = Date.now() + timeout_ms;
	let last = await get_resume_sessions_for_tests();
	while (Date.now() < deadline) {
		if (last.find((session) => session.id === id)?.messageCount === count) return last;
		await Bun.sleep(10);
		last = await get_resume_sessions_for_tests();
	}
	return last;
}

afterEach(() => {
	reset_model_picker_session();
	reset_session_catalog();
	for (const dir of created_dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("/resume session catalog", () => {
	test("primes at session_start and answers every later hit from memory", async () => {
		const dir = temp_session_dir();
		const alpha = write_session_file(dir, "session-a", "alpha conversation");
		const beta = write_session_file(dir, "session-b", "beta conversation");

		bind(dir);
		expect(await wait_for_catalog(["session-a", "session-b"])).toEqual([
			"session-a",
			"session-b",
		]);
		const rows = await get_resume_sessions_for_tests();
		expect(rows.find((session) => session.id === "session-a")?.firstMessage).toBe(
			"alpha conversation",
		);

		// With the files gone, later hits still answer — and hand back the very
		// same array, proving the hit never listed the dir again.
		unlinkSync(alpha);
		unlinkSync(beta);
		const second = await get_resume_sessions_for_tests();
		expect(second).toBe(rows);
		const third = await get_resume_sessions_for_tests();
		expect(third).toBe(rows);
	});

	test("a cold hit never waits for the scan; the published catalog is shared", async () => {
		const dir = temp_session_dir();
		write_session_file(dir, "session-a", "alpha conversation");
		for (let i = 0; i < 60; i++) write_session_file(dir, `bulk-${i}`, `bulk ${i}`);

		bind(dir);
		// The scan for 61 files cannot finish inside this hit: the answer comes
		// from nothing at all, immediately, instead of blocking the picker.
		const [first, second] = await Promise.all([
			get_resume_sessions_for_tests(),
			get_resume_sessions_for_tests(),
		]);
		expect(first).toEqual([]);
		expect(second).toEqual([]);

		await wait_for_catalog([
			"session-a",
			...Array.from({ length: 60 }, (_value, i) => `bulk-${i}`),
		]);
		// Once published, every hit shares the one catalog object.
		const [third, fourth] = await Promise.all([
			get_resume_sessions_for_tests(),
			get_resume_sessions_for_tests(),
		]);
		expect(third).toBe(fourth);
	});

	test("session replacement rebuilds in the background without blocking hits", async () => {
		const dir = temp_session_dir();
		write_session_file(dir, "session-a", "alpha conversation");
		bind(dir);
		await wait_for_catalog(["session-a"]);
		const first = await get_resume_sessions_for_tests();

		// /new in the same dir: a new session file exists, and the re-bind checks
		// the file set in the background. The hit right after still answers
		// instantly from the previous catalog (same array, no waiting).
		write_session_file(dir, "session-b", "beta conversation");
		bind(dir);
		expect(await get_resume_sessions_for_tests()).toBe(first);

		// The rebuild lands on its own and the next hit is fresh.
		expect(await wait_for_catalog(["session-a", "session-b"])).toEqual([
			"session-a",
			"session-b",
		]);
	});

	test("a settled dir keeps its catalog object across a prime", async () => {
		const dir = temp_session_dir();
		write_session_file(dir, "session-a", "alpha conversation");
		bind(dir);
		await wait_for_catalog(["session-a"]);
		const first = await get_resume_sessions_for_tests();

		// Nothing changed on disk: a session start must not replace the catalog
		// (no re-read, no subscriber churn, the same rows).
		bind(dir);
		await Bun.sleep(30);
		expect(await get_resume_sessions_for_tests()).toBe(first);
		expect(peek_session_catalog(catalog_key(dir))).toBe(first);
	});

	test("growth of the current session updates its row from appended bytes only", async () => {
		const dir = temp_session_dir();
		const alpha = write_session_file(dir, "session-a", "alpha conversation");
		write_session_file(dir, "session-b", "beta conversation");
		bind(dir);
		await wait_for_catalog(["session-a", "session-b"]);
		const first = await get_resume_sessions_for_tests();
		expect(first.find((session) => session.id === "session-a")?.messageCount).toBe(2);

		// Every turn appends to the session file you are in. The catalog picks
		// that up without re-reading the conversation (the delta read itself is
		// pinned in the session-record tests) and keeps the rest of the list.
		appendFileSync(
			alpha,
			`${JSON.stringify({
				type: "message",
				id: "session-a-more",
				parentId: "session-a-2",
				timestamp: "2026-09-01T10:00:03.000Z",
				message: { role: "user", content: [{ type: "text", text: "next turn" }] },
			})}\n`,
		);
		bind(dir);
		const refreshed = await wait_for_row("session-a", 3);
		expect(refreshed.find((session) => session.id === "session-a")?.messageCount).toBe(3);
		expect(refreshed.find((session) => session.id === "session-a")?.firstMessage).toBe(
			"alpha conversation",
		);
		expect(refreshed.find((session) => session.id === "session-b")?.firstMessage).toBe(
			"beta conversation",
		);
	});

	test("a switch into another project never serves the old dir's list", async () => {
		const dir_a = temp_session_dir();
		const dir_b = temp_session_dir();
		write_session_file(dir_a, "session-a", "alpha conversation");
		write_session_file(dir_b, "session-b", "beta conversation");

		bind(dir_a);
		expect(await wait_for_catalog(["session-a"])).toEqual(["session-a"]);

		bind(dir_b);
		expect(await wait_for_catalog(["session-b"])).toEqual(["session-b"]);
	});
});
