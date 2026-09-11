/**
 * Session catalog — the single source of truth for "what sessions exist".
 *
 * Consumers: `/resume` argument completions (pi-ember-ui), the fleet view, and
 * any future session browser. Nothing else may scan the session dir.
 *
 * Why this module exists: Pi's `SessionManager.list` parses EVERY session file
 * in the project session dir (a busy project runs to hundreds of MB) and holds
 * every message text in memory for fuzzy search. Doing that on a picker
 * keystroke froze the TUI, so the catalog is:
 *
 *   1. answered from memory, or from the compact on-disk index, on every hit —
 *      a hit NEVER awaits a scan, not even the first one of a process,
 *   2. built in the background by `session-record.ts`, a bounded incremental
 *      reader (Pi's `SessionManager.list` is the parity oracle in tests, not the
 *      reader on the hot path),
 *   3. invalidated by the session dir's FILE SET (add/remove), not by file
 *      sizes: a session that only grew is already listed, so re-parsing every
 *      file because one of them was appended to is pure waste (it was a ~900 ms
 *      main-thread parse on every session start). Per-row `modified` is
 *      refreshed from the stat pass; message counts and search text refresh
 *      when the file set changes,
 *   4. persisted to `PI_HOME/cache/pi-ember-sessions.json` as compact records
 *      (a bounded search excerpt, never the whole conversation), so a cold
 *      process answers instantly.
 *
 * The catalog keeps one `SessionRecord` per file (the row plus its consumed-byte
 * cursor), so a warm scan is a `readdir` + one `stat` per file and reads only
 * the bytes appended since the last scan.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	read_session_record,
	record_to_session_info,
	type SessionRecord,
} from "./session-record.ts";

/** Session directory a catalog entry belongs to. */
export type SessionCatalogKey = {
	/** Project working directory (used for Pi's default session dir when `sessionDir` is absent). */
	cwd: string;
	/** Explicit session dir override (`SessionManager`'s custom dir), when the session uses one. */
	sessionDir?: string | undefined;
};

/** Stable identity string for a session directory. */
export function session_catalog_key(key: SessionCatalogKey | undefined): string | null {
	const cwd = key?.cwd?.trim();
	if (!cwd) return null;
	const sessionDir = key?.sessionDir?.trim();
	return `${cwd}\u0000${sessionDir ?? ""}`;
}

type CatalogEntry = {
	key: string;
	sessions: SessionInfo[];
	/** Per-file records, keyed by file name — they carry the delta cursors. */
	records: Map<string, SessionRecord>;
	loaded_at: number;
	/** Last dir check (changed or not) — gates the validation TTL. */
	validated_at: number;
	/** "cache" = revived without scanning; "scan" = the dir was read. */
	source: "cache" | "scan";
};

/**
 * How long a resident catalog is trusted before the next read starts a
 * background dir check. Hits inside the window do zero filesystem work; the
 * check itself is one readdir + one stat per file (measured at ~2 ms for 340
 * sessions) plus the bytes appended since the last scan.
 */
const CATALOG_VALIDATE_TTL_MS = 1_000;

/** Session files read/stat'd concurrently during a scan. */
const SCAN_CONCURRENCY = 12;

/** Session dirs kept resident in memory (a resident record set costs ~0.6 MB). */
const CATALOG_MAX_DIRS_IN_MEMORY = 4;

/**
 * On-disk cache, one file per session dir. Every project you have opened stays
 * warm across restarts, not just the last few, and the directory is self
 * cleaning: at most `CACHE_MAX_FILES` files and nothing older than
 * `CACHE_MAX_AGE_MS`, pruned every time a file is written.
 *
 * A cache file bigger than `INDEX_MAX_BYTES` is treated as legacy/corrupt and
 * dropped WITHOUT being read: the cache may never cost seconds to load (the
 * first version of this index persisted whole conversations and reached 22 MB).
 */
const INDEX_VERSION = 4;
const CACHE_DIR = "sessions";
/** Superseded single-file index from before per-dir cache files. */
const LEGACY_INDEX_FILE = "pi-ember-sessions.json";
export const CACHE_MAX_FILES = 16;
export const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const INDEX_MAX_BYTES = 4 * 1024 * 1024;

type PersistedRecord = {
	path: string;
	id: string;
	cwd: string;
	parentSessionPath?: string | undefined;
	name?: string | undefined;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	corpus: string;
	checkpoints?: string[];
	size: number;
	consumedSize: number;
	mtimeMs: number;
};

type PersistedEntry = {
	loadedAt: number;
	/** One record per session file — the row plus its consumed-byte cursor. */
	records: PersistedRecord[];
};

/** One cache file: the records for one session dir. */
type PersistedDirFile = {
	version: number;
	key: string;
	loadedAt: number;
	records: PersistedRecord[];
};

const catalog = new Map<string, CatalogEntry>();
const loading = new Map<string, Promise<SessionInfo[]>>();
const last_keys = new Map<string, SessionCatalogKey>();
const subscribers = new Set<(key: SessionCatalogKey, sessions: SessionInfo[]) => void>();

/**
 * Minimum gap between cache writes. The on-disk copy is only read at startup, so
 * rewriting a ~1 MB file (and stringifying it on the main thread) on every turn
 * is pure churn — the in-memory catalog is always current and the flush below
 * covers shutdown.
 */
const INDEX_WRITE_MIN_INTERVAL_MS = 5_000;

/** Dirs whose records changed since their cache file was last written. */
const dirty_keys = new Set<string>();
let index_write_task: Promise<void> | undefined;
let index_write_timer: ReturnType<typeof setTimeout> | undefined;
let last_index_write_at = 0;
/** The cache dir is swept at most once per process, on the first prime. */
let cache_swept = false;

/**
 * Cache root. `PI_HOME` mirrors the plugin registry's agent-home resolution so
 * tests and alternate homes never touch the live cache.
 */
function cache_root(): string {
	const home = process.env.PI_HOME?.trim() || getAgentDir();
	return path.join(home, "cache");
}

function cache_dir_path(): string {
	return path.join(cache_root(), CACHE_DIR);
}

/** Stable per-dir cache file name derived from the catalog key. */
function cache_file_for(key_string: string): string {
	const digest = createHash("sha1").update(key_string).digest("hex").slice(0, 16);
	return path.join(cache_dir_path(), `${digest}.json`);
}

function serialize_record(record: SessionRecord): PersistedRecord {
	return {
		path: record.path,
		id: record.id,
		cwd: record.cwd,
		parentSessionPath: record.parentSessionPath,
		name: record.name,
		created: record.created.toISOString(),
		modified: record.modified.toISOString(),
		messageCount: record.messageCount,
		firstMessage: record.firstMessage,
		corpus: record.corpus,
		checkpoints: record.checkpoints,
		size: record.size,
		consumedSize: record.consumedSize,
		mtimeMs: record.mtimeMs,
	};
}

function revive_record(raw: unknown): SessionRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Partial<PersistedRecord>;
	if (typeof entry.path !== "string" || typeof entry.id !== "string") return null;
	const created = typeof entry.created === "string" ? new Date(entry.created) : new Date();
	const modified = typeof entry.modified === "string" ? new Date(entry.modified) : created;
	return {
		path: entry.path,
		id: entry.id,
		cwd: typeof entry.cwd === "string" ? entry.cwd : "",
		parentSessionPath:
			typeof entry.parentSessionPath === "string" ? entry.parentSessionPath : undefined,
		name: typeof entry.name === "string" ? entry.name : undefined,
		created,
		modified,
		messageCount: typeof entry.messageCount === "number" ? entry.messageCount : 0,
		firstMessage: typeof entry.firstMessage === "string" ? entry.firstMessage : "",
		corpus: typeof entry.corpus === "string" ? entry.corpus : "",
		checkpoints: Array.isArray(entry.checkpoints)
			? entry.checkpoints.filter((value): value is string => typeof value === "string")
			: [],
		size: typeof entry.size === "number" ? entry.size : 0,
		consumedSize: typeof entry.consumedSize === "number" ? entry.consumedSize : 0,
		mtimeMs: typeof entry.mtimeMs === "number" ? entry.mtimeMs : 0,
	};
}

/** Path of the cache file backing one session dir (diagnostics and tests). */
export function session_cache_file(key: SessionCatalogKey | undefined): string | null {
	const key_string = session_catalog_key(key);
	return key_string ? cache_file_for(key_string) : null;
}

/**
 * One dir's cached records, or null when absent/unreadable/oversized.
 * A cache file is the whole warm-start path for a project: it is read instead
 * of scanning, so it is size-guarded and never trusted blindly — the records
 * carry their `consumedSize` cursor, and the next dir check diffs them.
 */
async function read_persisted_entry(key_string: string): Promise<PersistedEntry | null> {
	const file = cache_file_for(key_string);
	try {
		const stats = await fs.stat(file);
		if (stats.size > INDEX_MAX_BYTES) {
			// Legacy or corrupt: drop it and let the scan rewrite a compact one.
			void fs.rm(file, { force: true }).catch(() => {});
			return null;
		}
		const text = await fs.readFile(file, "utf-8");
		const parsed = JSON.parse(text) as PersistedDirFile;
		if (parsed?.version !== INDEX_VERSION || parsed.key !== key_string) return null;
		if (!Array.isArray(parsed.records)) return null;
		return { loadedAt: parsed.loadedAt, records: parsed.records };
	} catch {
		return null;
	}
}

/**
 * Keep the cache directory small and self-cleaning: at most `CACHE_MAX_FILES`
 * files, nothing older than `CACHE_MAX_AGE_MS`. Runs after a write, and also
 * removes the superseded single-file index from before per-dir cache files.
 */
async function prune_cache_dir(keep_file: string): Promise<void> {
	const dir = cache_dir_path();
	try {
		const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
		const entries: Array<{ file: string; mtimeMs: number }> = [];
		const protects_keep = keep_file.length > 0 && names.includes(path.basename(keep_file));
		const now = Date.now();
		for (const name of names) {
			const file = path.join(dir, name);
			if (file === keep_file) continue;
			try {
				const stats = await fs.stat(file);
				if (now - stats.mtimeMs > CACHE_MAX_AGE_MS) {
					await fs.rm(file, { force: true });
					continue;
				}
				entries.push({ file, mtimeMs: stats.mtimeMs });
			} catch {
				/* a file that vanished is already pruned */
			}
		}
		// The caller's file plus the newest others, capped.
		entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const budget = Math.max(0, CACHE_MAX_FILES - (protects_keep ? 1 : 0));
		for (const stale of entries.slice(budget)) {
			await fs.rm(stale.file, { force: true });
		}
	} catch {
		/* pruning is best-effort, never fatal */
	}
}

/**
 * Sweep the cache dir once per process (session start): drop aged files, trim
 * the flood, and remove the superseded single-file index. ~1 ms for a capped
 * directory, and it keeps the current project's file even when it is the oldest.
 */
export async function sweep_session_cache(keep_key?: SessionCatalogKey): Promise<void> {
	if (cache_swept) return;
	cache_swept = true;
	const key_string = session_catalog_key(keep_key);
	await remove_legacy_index();
	await prune_cache_dir(key_string ? cache_file_for(key_string) : "");
}

/** Drop the superseded single-file index once per process. */
async function remove_legacy_index(): Promise<void> {
	try {
		await fs.rm(path.join(cache_root(), LEGACY_INDEX_FILE), { force: true });
	} catch {
		/* nothing to remove */
	}
}

/**
 * Write every dirty dir's records to its cache file: temp file first so a killed
 * process cannot leave a torn cache behind, then rename (with a direct-write
 * fallback for the Windows rename case), then one prune. Failures are swallowed:
 * the cache is an optimization.
 */
async function write_dirty_dir_caches(): Promise<void> {
	const dir = cache_dir_path();
	await fs.mkdir(dir, { recursive: true });
	await remove_legacy_index();
	let last_written = "";
	for (const key of [...dirty_keys]) {
		const entry = catalog.get(key);
		// A dir evicted from memory has nothing to persist; its range is dropped
		// so the next write does not retry it.
		if (!entry) {
			dirty_keys.delete(key);
			continue;
		}
		const file = cache_file_for(entry.key);
		last_written = file;
		const payload: PersistedDirFile = {
			version: INDEX_VERSION,
			key: entry.key,
			loadedAt: entry.loaded_at,
			records: [...entry.records.values()].map(serialize_record),
		};
		const body = JSON.stringify(payload);
		const tmp = `${file}.${process.pid}.tmp`;
		try {
			await fs.writeFile(tmp, body, "utf-8");
			await fs.rename(tmp, file);
		} catch {
			// A rename over a file another process is reading can fail on
			// Windows: fall back to a direct write rather than losing the cache.
			await fs.writeFile(file, body, "utf-8").catch(() => {});
			await fs.rm(tmp, { force: true }).catch(() => {});
		}
		dirty_keys.delete(key);
	}
	if (last_written) {
		// The file just written is the newest, but protect it explicitly so a
		// clock tie can never trim the project we are actually in.
		await prune_cache_dir(last_written);
	}
}

/** One writer at a time: drain every dirty dir, re-checking after each write. */
function drain_index_writes(): Promise<void> {
	if (index_write_task) return index_write_task;
	const task = (async () => {
		while (dirty_keys.size > 0) {
			last_index_write_at = Date.now();
			await write_dirty_dir_caches();
		}
	})()
		.catch(() => {
			/* cache write failures are never fatal */
		})
		.finally(() => {
			index_write_task = undefined;
			// A publish can land after the drain's last check and before this
			// reset; it saw a running task and scheduled nothing of its own.
			if (dirty_keys.size > 0) schedule_index_write();
		});
	index_write_task = task;
	return task;
}

/**
 * Persist a changed dir's records, at most one write per
 * `INDEX_WRITE_MIN_INTERVAL_MS`. A publish during the interval marks the dir
 * dirty and the timer carries it; a burst of updates therefore costs one write
 * instead of one per turn.
 */
function queue_index_write(key_string: string): void {
	dirty_keys.add(key_string);
	schedule_index_write();
}

/** Arm the interval timer when no write is running or already scheduled. */
function schedule_index_write(): void {
	if (index_write_task || index_write_timer) return;
	const wait = Math.max(0, INDEX_WRITE_MIN_INTERVAL_MS - (Date.now() - last_index_write_at));
	index_write_timer = setTimeout(() => {
		index_write_timer = undefined;
		void drain_index_writes();
	}, wait);
	// Never hold the process open for a cache write.
	(index_write_timer as { unref?: () => void }).unref?.();
}

/**
 * Write any pending cache update now. Called on session shutdown so the next
 * start is warm, and by tests that need the file on disk.
 */
export async function flush_session_cache(): Promise<void> {
	if (index_write_timer) {
		clearTimeout(index_write_timer);
		index_write_timer = undefined;
	}
	while (index_write_task || dirty_keys.size > 0) {
		if (index_write_task) await index_write_task;
		else await drain_index_writes();
	}
}

type DirEntry = { name: string; path: string; size: number; mtimeMs: number };

/**
 * Cheap dir read: one readdir + one stat per file. This is the whole cost of a
 * warm scan — records are compared against these stats and only changed files
 * are read (and then only past their consumed cursor).
 */
async function read_dir_entries(key: SessionCatalogKey): Promise<DirEntry[] | null> {
	const dir = resolve_session_dir(key);
	if (!dir) return null;
	try {
		const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
		const entries = await Promise.all(
			names.map(async (name): Promise<DirEntry | null> => {
				const file = path.join(dir, name);
				try {
					const stats = await fs.stat(file);
					return { name, path: file, size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) };
				} catch {
					return null;
				}
			}),
		);
		return entries.filter((entry): entry is DirEntry => entry !== null);
	} catch {
		return null;
	}
}

/**
 * File-set signature of a session dir (names only). The record scan does not
 * need it — per-file size/mtime decides what to re-read — but it stays exported
 * for diagnostics and tests.
 */
export async function compute_session_dir_signature(
	key: SessionCatalogKey,
): Promise<string | null> {
	const entries = await read_dir_entries(key);
	if (!entries) return null;
	const names = entries.map((entry) => entry.name).sort();
	return createHash("sha1").update(names.join("\n")).digest("hex");
}

/**
 * Resolve the session directory for a key. Callers that already have a live
 * `SessionManager` pass `sessionDir` (the common case); otherwise Pi's own
 * default-dir resolution is used via a throwaway manager — never a dir scan,
 * which would read every session file just to learn a directory name.
 */
function resolve_session_dir(key: SessionCatalogKey): string | null {
	const dir = key.sessionDir?.trim();
	if (dir) return dir;
	try {
		return SessionManager.create(key.cwd).getSessionDir();
	} catch {
		return null;
	}
}

function notify(key: SessionCatalogKey, sessions: SessionInfo[]): void {
	for (const listener of [...subscribers]) {
		try {
			listener(key, sessions);
		} catch {
			/* a broken subscriber must never break the catalog */
		}
	}
}

/** Keep at most CATALOG_MAX_DIRS_IN_MEMORY catalogs resident, never the current one. */
function enforce_catalog_cap(keep_key: string): void {
	if (catalog.size <= CATALOG_MAX_DIRS_IN_MEMORY) return;
	const stale = [...catalog.values()]
		.filter((entry) => entry.key !== keep_key)
		.sort((a, b) => a.loaded_at - b.loaded_at);
	for (const entry of stale.slice(0, catalog.size - CATALOG_MAX_DIRS_IN_MEMORY)) {
		catalog.delete(entry.key);
		last_keys.delete(entry.key);
	}
}

function publish(entry: CatalogEntry, key: SessionCatalogKey): SessionInfo[] {
	catalog.set(entry.key, entry);
	last_keys.set(entry.key, key);
	enforce_catalog_cap(entry.key);
	queue_index_write(entry.key);
	notify(key, entry.sessions);
	return entry.sessions;
}

/**
 * Read every file in the dir, reusing the previous record when a file is
 * unchanged and reading only appended bytes when it grew.
 */
async function scan_records(
	entries: DirEntry[],
	previous: Map<string, SessionRecord>,
): Promise<Map<string, SessionRecord>> {
	const records = new Map<string, SessionRecord>();
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			const entry = entries[index];
			if (!entry) return;
			try {
				const record = await read_session_record(entry.path, previous.get(entry.name));
				if (record) records.set(entry.name, record);
			} catch {
				/* an unreadable file is simply not listed */
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, entries.length) }, worker));
	return records;
}

/**
 * Background (re)build for one session dir. Warm cost: readdir + one stat per
 * file (~2 ms for 340 sessions) plus the bytes appended since the last scan.
 */
async function rebuild(
	key_string: string,
	key: SessionCatalogKey,
	force: boolean,
): Promise<SessionInfo[]> {
	const entries = await read_dir_entries(key);
	if (!entries) {
		// Missing/unreadable dir: never publish. A transient filesystem error or
		// a deleted dir must not replace a good catalog with an empty one (that
		// used to persist an empty entry over the project's real one).
		return catalog.get(key_string)?.sessions ?? [];
	}
	const resident = catalog.get(key_string);
	const previous = resident?.records ?? new Map<string, SessionRecord>();
	const records = await scan_records(entries, force ? new Map() : previous);
	// Nothing moved (every file returned the very same record object): keep the
	// catalog, its array identity, and its subscribers untouched. This is the
	// steady state of a warm index — a readdir, a stat per file, no publish.
	if (resident && records.size === previous.size) {
		let changed = false;
		for (const [name, record] of records) {
			if (previous.get(name) !== record) {
				changed = true;
				break;
			}
		}
		if (!changed) {
			resident.validated_at = Date.now();
			return resident.sessions;
		}
	}
	const sessions = [...records.values()].map(record_to_session_info);
	// Newest first, matching Pi's list ordering.
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const entry: CatalogEntry = {
		key: key_string,
		sessions,
		records,
		loaded_at: Date.now(),
		validated_at: Date.now(),
		source: "scan",
	};
	return publish(entry, key);
}

/**
 * Start one background (re)build for a dir, at most one at a time per key. The
 * TTL gates the cheap file-set check; a changed dir is re-parsed and published
 * to subscribers, an unchanged one only refreshes the TTL stamp.
 */
function schedule_catalog_rebuild(
	key_string: string,
	key: SessionCatalogKey,
	force: boolean,
	ignore_ttl = false,
): void {
	const resident = catalog.get(key_string);
	if (
		!force &&
		!ignore_ttl &&
		resident &&
		Date.now() - resident.validated_at < CATALOG_VALIDATE_TTL_MS
	)
		return;
	if (loading.has(key_string)) return;
	const check = rebuild(key_string, key, force).finally(() => {
		loading.delete(key_string);
	});
	void check.catch(() => {
		/* rebuild failures leave the previous catalog in place */
	});
	loading.set(key_string, check);
}

/**
 * The catalog for a session dir, always answered immediately: a resident
 * catalog, else the compact on-disk index, else an empty list while the scan
 * runs in the background (subscribers get the real rows). The returned promise
 * never waits for `SessionManager.list`.
 */
export function get_session_catalog(key: SessionCatalogKey | undefined): Promise<SessionInfo[]> {
	const key_string = session_catalog_key(key);
	if (!key_string || !key) return Promise.resolve([]);
	const resolved: SessionCatalogKey = { cwd: key.cwd, sessionDir: key.sessionDir };
	last_keys.set(key_string, resolved);

	const resident = catalog.get(key_string);
	if (resident) {
		schedule_catalog_rebuild(key_string, resolved, false);
		return Promise.resolve(resident.sessions);
	}

	// Cold process / new dir: revive from the on-disk index (a bounded read,
	// never a parse) and validate in the background.
	return read_persisted_entry(key_string).then((hit) => {
		const live = catalog.get(key_string);
		if (live) return live.sessions;
		if (hit && Array.isArray(hit.records)) {
			const records = new Map<string, SessionRecord>();
			for (const raw of hit.records) {
				const record = revive_record(raw);
				if (!record) continue;
				records.set(path.basename(record.path), record);
			}
			const sessions = [...records.values()].map(record_to_session_info);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			if (sessions.length > 0) {
				const entry: CatalogEntry = {
					key: key_string,
					sessions,
					records,
					loaded_at: hit.loadedAt,
					validated_at: 0,
					source: "cache",
				};
				catalog.set(key_string, entry);
				last_keys.set(key_string, resolved);
				enforce_catalog_cap(key_string);
				notify(resolved, sessions);
				schedule_catalog_rebuild(key_string, resolved, false);
				return sessions;
			}
		}
		schedule_catalog_rebuild(key_string, resolved, false);
		return catalog.get(key_string)?.sessions ?? [];
	});
}

/** The catalog if it is already resident — never touches the filesystem. */
export function peek_session_catalog(key: SessionCatalogKey | undefined): SessionInfo[] | null {
	const key_string = session_catalog_key(key);
	if (!key_string) return null;
	return catalog.get(key_string)?.sessions ?? null;
}

/** Where a resident catalog came from ("cache" = revived, "scan" = parsed). */
export function peek_session_catalog_source(
	key: SessionCatalogKey | undefined,
): "cache" | "scan" | null {
	const key_string = session_catalog_key(key);
	if (!key_string) return null;
	return catalog.get(key_string)?.source ?? null;
}

/**
 * Warm the catalog at session start: revive from the on-disk index when the
 * process has nothing resident, and validate the file set in the background.
 * Fire-and-forget by design — startup never waits for a session scan.
 */
export function prime_session_catalog(key: SessionCatalogKey | undefined): void {
	const key_string = session_catalog_key(key);
	if (!key_string || !key) return;
	void sweep_session_cache(key);
	const resolved: SessionCatalogKey = { cwd: key.cwd, sessionDir: key.sessionDir };
	// A session start is exactly when the file set is expected to change (the
	// session that just ended is now resumable, a new one may exist), so the
	// check ignores the hit-path TTL. It is a readdir + stats, never a parse
	// unless the set actually changed, and it never blocks the caller.
	if (catalog.has(key_string)) {
		schedule_catalog_rebuild(key_string, resolved, false, true);
		return;
	}
	prime_session_catalog_uncached(key_string, resolved);
}

function prime_session_catalog_uncached(key_string: string, resolved: SessionCatalogKey): void {
	void get_session_catalog(resolved).catch(() => {
		/* priming failures leave the caller on the empty-list path */
		console.debug?.("");
	});
	void key_string;
}

/** Re-parse the dir in the background even when it is already resident. */
export function refresh_session_catalog(key: SessionCatalogKey | undefined): void {
	const key_string = session_catalog_key(key);
	if (!key_string || !key) return;
	schedule_catalog_rebuild(key_string, { cwd: key.cwd, sessionDir: key.sessionDir }, true);
}

export function subscribe_session_catalog(
	listener: (key: SessionCatalogKey, sessions: SessionInfo[]) => void,
): () => void {
	subscribers.add(listener);
	return () => {
		subscribers.delete(listener);
	};
}

/** Drop catalog state (tests; the live session keeps it warm across replacements). */
export function reset_session_catalog(): void {
	catalog.clear();
	loading.clear();
	last_keys.clear();
	// A reset stands in for a fresh process (tests): the cache sweep runs again,
	// the write interval starts over, and nothing stays queued for a graph that
	// is already gone.
	cache_swept = false;
	last_index_write_at = 0;
	dirty_keys.clear();
	if (index_write_timer) {
		clearTimeout(index_write_timer);
		index_write_timer = undefined;
	}
}

/** Drop one dir's catalog (tests, manual invalidation). */
export function invalidate_session_catalog(key: SessionCatalogKey | undefined): void {
	const key_string = session_catalog_key(key);
	if (!key_string) return;
	catalog.delete(key_string);
	last_keys.delete(key_string);
}

// ---------------------------------------------------------------------------
// Display helpers shared by every session list (fleet view, /resume picker)
// ---------------------------------------------------------------------------

/** Compact age label for a session row: now, 5m, 3h, 2d, 6w, 4mo, 1y. */
export function format_session_age(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

/** Display name for a session: explicit name, else its first user message, else the id. */
export function session_label(session: SessionInfo): string {
	const named = session.name?.trim();
	if (named) return named;
	const first = session.firstMessage?.replace(/\s+/g, " ").trim() ?? "";
	if (first) return first.replace(/\x1b\[48;2;38;38;38m/g, "");
	return session.id;
}

/**
 * Fuzzy-search corpus for one session. The joined text runs to kilobytes
 * (`allMessagesText` is the whole conversation), so it is memoized per session
 * object: keystrokes in a search box reuse it instead of re-joining megabytes.
 * A WeakMap keeps the memo tied to the catalog entry's lifetime.
 */
const session_search_text_cache = new WeakMap<SessionInfo, string>();

export function session_search_text(session: SessionInfo): string {
	const cached = session_search_text_cache.get(session);
	if (cached !== undefined) return cached;
	const text = [
		session.path,
		session.id,
		session.name ?? "",
		session.firstMessage ?? "",
		session.cwd ?? "",
		session.allMessagesText ?? "",
	].join(" ");
	session_search_text_cache.set(session, text);
	return text;
}
