import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CACHE_MAX_FILES,
	compute_session_dir_signature,
	flush_session_cache,
	session_cache_file,
	get_session_catalog,
	peek_session_catalog,
	peek_session_catalog_source,
	prime_session_catalog,
	refresh_session_catalog,
	reset_session_catalog,
	type SessionCatalogKey,
	subscribe_session_catalog,
} from "../session-index.ts";

/**
 * The session catalog is the SSOT for every session list. Its contract:
 *
 *   - a hit is answered immediately (memory, else the compact on-disk index,
 *     else an empty list while the scan runs) — never behind a parse,
 *   - `SessionManager.list` is the only parser and runs in the background,
 *   - the dir's FILE SET decides when that parser runs, so a session that only
 *     grew (the one you are in) never re-parses the whole project,
 *   - an unchanged dir keeps the resident catalog object identity.
 */

const dirs: string[] = [];

// Keep the on-disk catalog out of the real agent home.
const previous_home = process.env.PI_HOME;
const cache_home = mkdtempSync(join(tmpdir(), "pi-ember-session-index-home-"));

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

function temp_dir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ember-session-index-"));
	dirs.push(dir);
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
	];
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function key_for(dir: string): SessionCatalogKey {
	return { cwd: dir, sessionDir: dir };
}

function ids_of(sessions: { id: string }[]): string[] {
	return sessions.map((session) => session.id).sort();
}

/** Poll until the background scan publishes the expected ids. */
async function wait_for_ids(key: SessionCatalogKey, expected: string[], timeout_ms = 3_000) {
	const target = [...expected].sort();
	const deadline = Date.now() + timeout_ms;
	let latest: string[] = [];
	while (Date.now() < deadline) {
		latest = ids_of(peek_session_catalog(key) ?? []);
		if (JSON.stringify(latest) === JSON.stringify(target)) return latest;
		await Bun.sleep(5);
	}
	return latest;
}

/** Cache files currently on disk (the per-dir warm-start index). */
function cache_files(): string[] {
	try {
		return readdirSync(join(cache_home, "cache", "sessions"))
			.filter((name) => name.endsWith(".json"))
			.map((name) => join(cache_home, "cache", "sessions", name));
	} catch {
		return [];
	}
}

/**
 * Prime a dir, wait for its scan, and flush the debounced cache write so the
 * on-disk file exists (production flushes on shutdown or at the write interval).
 */
async function prime_and_wait(dir: string, expected: string[]): Promise<void> {
	prime_session_catalog(key_for(dir));
	await wait_for_ids(key_for(dir), expected);
	await flush_session_cache();
}

afterEach(() => {
	reset_session_catalog();
	// Each test gets a clean cache dir: the on-disk file is shared state.
	rmSync(join(cache_home, "cache"), { recursive: true, force: true });
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session catalog", () => {
	test("the dir signature tracks the file set, not file growth", async () => {
		const dir = temp_dir();
		const file = write_session_file(dir, "session-a", "alpha");
		const before = await compute_session_dir_signature(key_for(dir));

		// Same files: identical signature (no re-parse needed).
		expect(await compute_session_dir_signature(key_for(dir))).toBe(before);

		// Growth must NOT invalidate: appending to the session you are in would
		// otherwise re-parse every session in the project on every turn.
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				id: "session-a-2",
				parentId: "session-a-1",
				timestamp: "2026-09-01T10:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "more" }] },
			})}\n`,
		);
		expect(await compute_session_dir_signature(key_for(dir))).toBe(before);

		// New file: different signature.
		write_session_file(dir, "session-b", "beta");
		const after_add = await compute_session_dir_signature(key_for(dir));
		expect(after_add).not.toBe(before);

		// Removed file: different again.
		unlinkSync(file);
		expect(await compute_session_dir_signature(key_for(dir))).not.toBe(after_add);
	});

	test("a cold hit answers immediately and the scan fills in behind it", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");
		// Enough files that the background scan cannot finish inside the hit:
		// the cold answer must come from the (empty) cache, not from the parse.
		for (let i = 0; i < 60; i++) write_session_file(dir, `bulk-${i}`, `bulk ${i}`);

		const cold = await get_session_catalog(key_for(dir));
		expect(cold).toEqual([]);

		const ids = await wait_for_ids(key_for(dir), [
			"session-a",
			...Array.from({ length: 60 }, (_value, i) => `bulk-${i}`),
		]);
		expect(ids.length).toBe(61);
		expect(peek_session_catalog_source(key_for(dir))).toBe("scan");
	});

	test("later hits are the same array; a grown file keeps it, a new file replaces it", async () => {
		const dir = temp_dir();
		const alpha = write_session_file(dir, "session-a", "alpha");
		prime_session_catalog(key_for(dir));
		await wait_for_ids(key_for(dir), ["session-a"]);
		const scanned = peek_session_catalog(key_for(dir));

		expect(await get_session_catalog(key_for(dir))).toBe(scanned as never);
		expect(peek_session_catalog(key_for(dir))).toBe(scanned as never);

		// Growth of an existing file: still the same catalog object (no re-parse),
		// but the age shown for that row is refreshed from the stat pass.
		const grown_at = new Date(Date.now() + 60_000);
		appendFileSync(
			alpha,
			`${JSON.stringify({
				type: "message",
				id: "session-a-2",
				parentId: "session-a-1",
				timestamp: "2026-09-01T10:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "more" }] },
			})}\n`,
		);
		await Bun.sleep(20);
		const after_growth = await get_session_catalog(key_for(dir));
		expect(after_growth).toBe(scanned as never);
		expect(after_growth).not.toEqual([]);
		expect((after_growth[0]?.modified ?? new Date(0)).getTime()).toBeLessThan(
			grown_at.getTime(),
		);

		// A new session file is a structural change: the catalog is replaced in
		// the background and the next hit sees it.
		write_session_file(dir, "session-b", "beta");
		refresh_session_catalog(key_for(dir));
		await wait_for_ids(key_for(dir), ["session-a", "session-b"]);
		expect(peek_session_catalog(key_for(dir))).not.toBe(scanned as never);
	});

	test("prime is fire-and-forget and never blocks the caller", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");

		const started = performance.now();
		prime_session_catalog(key_for(dir));
		expect(performance.now() - started).toBeLessThan(20);

		await wait_for_ids(key_for(dir), ["session-a"]);
	});

	test("subscribers see a catalog replacement after a refresh", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");
		prime_session_catalog(key_for(dir));
		await wait_for_ids(key_for(dir), ["session-a"]);

		const seen: string[][] = [];
		const unsubscribe = subscribe_session_catalog((_key, sessions) => {
			seen.push(ids_of(sessions));
		});

		write_session_file(dir, "session-b", "beta");
		refresh_session_catalog(key_for(dir));
		const deadline = Date.now() + 3_000;
		while (seen.length === 0 && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		unsubscribe();
		expect(seen.at(-1)).toEqual(["session-a", "session-b"]);
	});

	test("a cold catalog is revived from the on-disk index without re-parsing", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");
		prime_session_catalog(key_for(dir));
		const scanned = await wait_for_ids(key_for(dir), ["session-a"]);
		expect(scanned).toEqual(["session-a"]);
		// Let the debounced index write land.
		await flush_session_cache();

		// Drop every in-memory entry: the next read must come from disk.
		reset_session_catalog();
		const revived = await get_session_catalog(key_for(dir));
		expect(ids_of(revived)).toEqual(["session-a"]);
		expect(revived[0]?.firstMessage).toBe("alpha");
		expect(peek_session_catalog_source(key_for(dir))).toBe("cache");

		// The unchanged file set must not replace the revived catalog.
		await Bun.sleep(50);
		expect(peek_session_catalog(key_for(dir))).toBe(revived);
	});

	test("an oversized cache file is dropped without being read", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");

		await prime_and_wait(dir, ["session-a"]);
		const file = cache_files()[0];
		expect(typeof file).toBe("string");
		writeFileSync(file as string, `{"version":4}${"x".repeat(5 * 1024 * 1024)}`);
		reset_session_catalog();

		const started = performance.now();
		const cold = await get_session_catalog(key_for(dir));
		expect(cold).toEqual([]);
		expect(performance.now() - started).toBeLessThan(500);

		expect(await wait_for_ids(key_for(dir), ["session-a"])).toEqual(["session-a"]);
	});

	test("every project stays warm: one cache file per session dir", async () => {
		rmSync(join(cache_home, "cache"), { recursive: true, force: true });
		const dirs = [temp_dir(), temp_dir(), temp_dir()];
		dirs.forEach((dir, index) => write_session_file(dir, `session-${index}`, `ask ${index}`));
		for (const dir of dirs) await prime_and_wait(dir, [`session-${dirs.indexOf(dir)}`]);

		expect(cache_files().length).toBe(3);
		// A restart (memory cleared) answers every project from its own file.
		reset_session_catalog();
		for (const dir of dirs) {
			const rows = await get_session_catalog(key_for(dir));
			expect(ids_of(rows)).toEqual([`session-${dirs.indexOf(dir)}`]);
			expect(peek_session_catalog_source(key_for(dir))).toBe("cache");
		}
	});

	test("the cache dir is capped and sweeps stale files", async () => {
		const keep = temp_dir();
		write_session_file(keep, "session-keep", "keep me");
		await prime_and_wait(keep, ["session-keep"]);
		const keep_file = session_cache_file(key_for(keep)) as string;
		expect(existsSync(keep_file)).toBe(true);

		// A pile of unrelated cache files: old ones and a flood of fresh ones.
		const cache_dir = join(cache_home, "cache", "sessions");
		const stale = join(cache_dir, "stale.json");
		writeFileSync(stale, "{}");
		const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
		utimesSync(stale, long_ago, long_ago);
		for (let i = 0; i < CACHE_MAX_FILES + 4; i++) {
			writeFileSync(join(cache_dir, `flood-${i}.json`), "{}");
		}

		// A fresh process sweeps on its first prime: the aged file is dropped and
		// the flood is trimmed to the cap, while the current project is kept.
		reset_session_catalog();
		prime_session_catalog(key_for(keep));
		await wait_for_ids(key_for(keep), ["session-keep"]);
		await flush_session_cache();
		const after = cache_files();
		expect(after).toContain(keep_file);
		expect(after).not.toContain(stale);
		expect(after.length).toBeLessThanOrEqual(CACHE_MAX_FILES);
	});

	test("cache writes are debounced, then flushed on demand", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");
		prime_session_catalog(key_for(dir));
		await wait_for_ids(key_for(dir), ["session-a"]);
		const file = session_cache_file(key_for(dir)) as string;
		// The first write of a process is not held back: there is nothing on disk yet.
		const deadline = Date.now() + 2_000;
		while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(file)).toBe(true);

		// A publish inside the write interval only marks the dir dirty: no rewrite.
		const before = statSync(file).mtimeMs;
		write_session_file(dir, "session-b", "beta");
		refresh_session_catalog(key_for(dir));
		await wait_for_ids(key_for(dir), ["session-a", "session-b"]);
		await Bun.sleep(250);
		expect(statSync(file).mtimeMs).toBe(before);

		// The shutdown flush carries it, and the file matches the live catalog.
		await flush_session_cache();
		expect(statSync(file).mtimeMs).toBeGreaterThan(before);
		const persisted = JSON.parse(readFileSync(file, "utf-8")) as { records: unknown[] };
		expect(persisted.records.length).toBe(2);
		expect(cache_files().length).toBe(1);
	});

	test("the superseded single-file index is removed", async () => {
		const dir = temp_dir();
		write_session_file(dir, "session-a", "alpha");
		const legacy = join(cache_home, "cache", "pi-ember-sessions.json");
		mkdirSync(join(cache_home, "cache"), { recursive: true });
		writeFileSync(legacy, JSON.stringify({ version: 3, dirs: [] }));

		await prime_and_wait(dir, ["session-a"]);
		expect(existsSync(legacy)).toBe(false);
	});

	test("an unreadable dir yields an empty catalog, never a throw", async () => {
		const missing = join(temp_dir(), "does-not-exist");
		const sessions = await get_session_catalog({ cwd: missing, sessionDir: missing });
		expect(sessions).toEqual([]);
	});
});
