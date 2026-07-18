/**
 * Per-session DCP state persistence.
 *
 * Saves compression records and dedup/error tracking state to disk so they
 * survive pi restarts. Storage: ~/.pi-dcp/sessions/{sessionId}.json
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PI_DCP_USER_DIR } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { CompressionRecord, SessionState } from "./state.ts";

const SESSIONS_DIR = path.join(PI_DCP_USER_DIR, "sessions");

function session_file_path(session_id: string): string {
	// Sanitize sessionId to be filesystem-safe (replace / : etc.)
	const safe = session_id.replace(/[/\\:*?"<>|]/g, "_").slice(0, 200);
	return path.join(SESSIONS_DIR, `${safe}.json`);
}

interface PersistedState {
	version: 1;
	sessionId: string;
	savedAt: number;
	nextCompressionId: number;
	turnIndex: number;
	compressions: Array<[number, SerializedCompressionRecord]>;
	dedupedCallIds: string[];
	purgedErrorCallIds: string[];
	appliedCompressionTargets: string[];
	erroredAt: Array<[string, number]>;
	stats?: {
		dedupPruned: number;
		errorInputsPurged: number;
		compressionsApplied: number;
		tokensSaved: number;
	};
}

interface SerializedCompressionRecord {
	id: number;
	createdAt: number;
	toolCallIds: string[];
	summary: string;
	topic: string;
	tokensSaved: number;
	suspended: boolean;
}

function serialize_record(rec: CompressionRecord): SerializedCompressionRecord {
	return {
		id: rec.id,
		createdAt: rec.createdAt,
		toolCallIds: [...rec.toolCallIds],
		summary: rec.summary,
		topic: rec.topic,
		tokensSaved: rec.tokensSaved,
		suspended: rec.suspended,
	};
}

function deserialize_record(s: SerializedCompressionRecord): CompressionRecord {
	return {
		id: s.id,
		createdAt: s.createdAt,
		toolCallIds: s.toolCallIds,
		summary: s.summary,
		topic: s.topic,
		tokensSaved: s.tokensSaved,
		suspended: s.suspended,
	};
}

/**
 * Persist the parts of `state` that should survive restarts. Best-effort:
 * any error is logged but never thrown. Writes atomically via temp-file rename.
 */
export function save_session_state(
	session_id: string,
	state: SessionState,
	logger: Logger,
): void {
	if (!session_id) return;
	try {
		fs.mkdirSync(SESSIONS_DIR, { recursive: true });

		const data: PersistedState = {
			version: 1,
			sessionId: session_id,
			savedAt: Date.now(),
			nextCompressionId: state.nextCompressionId,
			turnIndex: state.turnIndex,
			compressions: Array.from(state.compressions.entries()).map(([k, v]) => [
				k,
				serialize_record(v),
			]),
			dedupedCallIds: Array.from(state.dedupedCallIds),
			purgedErrorCallIds: Array.from(state.purgedErrorCallIds),
			appliedCompressionTargets: Array.from(state.appliedCompressionTargets),
			erroredAt: Array.from(state.erroredAt.entries()),
			stats: { ...state.stats },
		};

		const file_path = session_file_path(session_id);
		const tmp = `${file_path}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
		fs.renameSync(tmp, file_path);
		logger.info("session state saved", {
			sessionId: session_id,
			compressions: data.compressions.length,
			dedupedCallIds: data.dedupedCallIds.length,
		});
	} catch (err) {
		logger.warn("failed to save session state", {
			sessionId: session_id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Restore previously saved state into `state`. If no file exists, or the
 * file is malformed, returns false (state is untouched). Best-effort.
 */
export function restore_session_state(
	session_id: string,
	state: SessionState,
	logger: Logger,
): boolean {
	if (!session_id) return false;
	const file_path = session_file_path(session_id);
	try {
		if (!fs.existsSync(file_path)) return false;
		const raw = fs.readFileSync(file_path, "utf-8");
		const data = JSON.parse(raw) as Partial<PersistedState>;

		if (data.version !== 1 || data.sessionId !== session_id) {
			logger.warn("session state file version mismatch, ignoring", {
				sessionId: session_id,
			});
			return false;
		}

		if (typeof data.nextCompressionId === "number") {
			state.nextCompressionId = Math.max(
				state.nextCompressionId,
				data.nextCompressionId,
			);
		}
		if (typeof data.turnIndex === "number") state.turnIndex = data.turnIndex;

		if (Array.isArray(data.compressions)) {
			for (const [k, v] of data.compressions) {
				if (typeof k === "number" && v) {
					state.compressions.set(k, deserialize_record(v));
				}
			}
		}
		if (Array.isArray(data.dedupedCallIds)) {
			for (const id of data.dedupedCallIds) {
				if (typeof id === "string") state.dedupedCallIds.add(id);
			}
		}
		if (Array.isArray(data.purgedErrorCallIds)) {
			for (const id of data.purgedErrorCallIds) {
				if (typeof id === "string") state.purgedErrorCallIds.add(id);
			}
		}
		if (Array.isArray(data.appliedCompressionTargets)) {
			for (const id of data.appliedCompressionTargets) {
				if (typeof id === "string") state.appliedCompressionTargets.add(id);
			}
		}
		if (Array.isArray(data.erroredAt)) {
			for (const [id, turn] of data.erroredAt) {
				if (typeof id === "string" && typeof turn === "number") {
					state.erroredAt.set(id, turn);
				}
			}
		}
		if (data.stats) {
			state.stats.dedupPruned = data.stats.dedupPruned ?? 0;
			state.stats.errorInputsPurged = data.stats.errorInputsPurged ?? 0;
			state.stats.compressionsApplied = data.stats.compressionsApplied ?? 0;
			state.stats.tokensSaved = data.stats.tokensSaved ?? 0;
		}

		logger.info("session state restored", {
			sessionId: session_id,
			compressions: state.compressions.size,
			dedupedCallIds: state.dedupedCallIds.size,
		});
		return true;
	} catch (err) {
		logger.warn("failed to restore session state", {
			sessionId: session_id,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/**
 * Called after compaction. Clears all ID-based tracking state so stale
 * references to compacted-away messages don't pollute the new session branch.
 * Compressions survive (user explicitly asked for those).
 */
export function reset_tracking_after_compaction(
	state: SessionState,
	logger: Logger,
): void {
	const compress_before = state.compressions.size;
	state.dedupedCallIds.clear();
	state.purgedErrorCallIds.clear();
	state.appliedCompressionTargets.clear();
	state.erroredAt.clear();
	logger.info("tracking state reset after compaction", {
		compressBefore: compress_before,
	});
}

/**
 * Prune stale session state files older than `max_age_days` days.
 * Runs at most once per session (called from session_start).
 */
export function prune_old_session_files(
	max_age_days = 30,
	logger: Logger,
): void {
	try {
		if (!fs.existsSync(SESSIONS_DIR)) return;
		const cutoff = Date.now() - max_age_days * 24 * 60 * 60 * 1000;
		const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
		let pruned = 0;
		for (const file of files) {
			const fp = path.join(SESSIONS_DIR, file);
			try {
				const stat = fs.statSync(fp);
				if (stat.mtimeMs < cutoff) {
					fs.unlinkSync(fp);
					pruned++;
				}
			} catch {
				// ignore per-file errors
			}
		}
		if (pruned > 0) logger.info(`pruned ${pruned} stale session state file(s)`);
	} catch (err) {
		logger.warn("session state pruning failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
