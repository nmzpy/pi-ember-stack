/**
 * Lean session records — the bounded, incremental reader behind the session
 * catalog.
 *
 * Reading a project's session dir with Pi's `SessionManager.list` parses every
 * JSON line of every session file (340 sessions / 304 MB ≈ 850 ms) and keeps the
 * whole conversation text in memory. A session *list* needs almost none of that:
 * a row is a name, an age, a message count, the opening request, and enough text
 * to search.
 *
 * So this reader is bounded by design:
 *
 *   - one streaming pass per file counts `message` entries and picks up the few
 *     entries that carry list data (`session` header, `session_info` name,
 *     `compaction` checkpoints) WITHOUT parsing conversation lines — measured at
 *     ~290 ms for 304 MB versus ~850 ms for the full parse (the rest of the
 *     remaining cost is UTF-8 decoding, which one pass needs), and it yields the
 *     same exact `messageCount` Pi computes,
 *   - the opening request is decoded inside that pass (the line is already in
 *     hand), so it costs no second read,
 *   - the search corpus is assembled from bounded pieces (opening request,
 *     compaction checkpoints, the most recent turns) instead of the whole
 *     conversation — a checkpoint already summarizes everything older, so
 *     dropping that bulk costs almost no searchability,
 *   - the tail window is parsed newest-first and stops once the corpus is full,
 *     so a chatty turn costs a handful of parses instead of every line in it,
 *   - a file is re-read only when its size/mtime moved, and then only from the
 *     byte offset already consumed (session files are append-only), so a warm
 *     index costs one `readdir` + one `stat` per file (~2 ms) plus the turn that
 *     was actually appended.
 *
 * `SessionManager.list` stays the reference implementation: the parity test
 * pins this reader's id/cwd/name/created/modified/messageCount/firstMessage
 * against it on the same fixtures, so the lean path cannot drift from Pi.
 */

import * as fs from "node:fs/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

/** Everything a session list needs, plus the cursor that makes re-reads cheap. */
export type SessionRecord = {
	path: string;
	id: string;
	cwd: string;
	parentSessionPath?: string | undefined;
	name?: string | undefined;
	created: Date;
	modified: Date;
	/** Exact count of `message` entries (the same number Pi reports). */
	messageCount: number;
	/** First user message with text, or "(no messages)". */
	firstMessage: string;
	/** Bounded fuzzy-search text: opening request + checkpoints + recent turns. */
	corpus: string;
	/** Compaction checkpoint summaries carried for the corpus (newest last). */
	checkpoints: string[];
	/** File size at the last scan. */
	size: number;
	/** Line-aligned bytes already consumed (append-only delta cursor). */
	consumedSize: number;
	mtimeMs: number;
};

/** Streaming read size. */
const CHUNK_BYTES = 1 << 20;
/** Trailing window parsed for recent text; the rest of the file is never parsed. */
const TAIL_BYTES = 64 * 1024;

const FIRST_MESSAGE_MAX_CHARS = 1_500;
const RECENT_TEXT_MAX_CHARS = 3_000;
const CHECKPOINT_MAX_CHARS = 2_000;
const MAX_CHECKPOINTS = 2;

/**
 * Total search corpus kept per session: the opening request, the newest
 * compaction checkpoints (which summarize everything older), and the most
 * recent turns. This is the whole price of an instant cold start — the full
 * conversation text is never retained or persisted.
 */
export const CORPUS_MAX_CHARS =
	FIRST_MESSAGE_MAX_CHARS + RECENT_TEXT_MAX_CHARS + CHECKPOINT_MAX_CHARS * MAX_CHECKPOINTS;

const MESSAGE_PREFIX = '{"type":"message",';
const SESSION_INFO_PREFIX = '{"type":"session_info",';
const COMPACTION_PREFIX = '{"type":"compaction",';
const HEADER_PREFIX = '{"type":"session",';
const TIMESTAMP_KEY = '"timestamp":"';

type ScanState = {
	header: Record<string, unknown> | null;
	name: string | undefined;
	messageCount: number;
	firstMessage: string;
	/** The first user message is decoded in-pass; this stops looking after it. */
	captured_first_user: boolean;
	lastActivity: number | null;
	checkpoints: string[];
	/** Chronological recent conversation text (bounded by `RECENT_TEXT_MAX_CHARS`). */
	recent: string;
	consumedSize: number;
};

function empty_state(): ScanState {
	return {
		header: null,
		name: undefined,
		messageCount: 0,
		firstMessage: "",
		captured_first_user: false,
		lastActivity: null,
		checkpoints: [],
		recent: "",
		consumedSize: 0,
	};
}

/** Keep the newest `RECENT_TEXT_MAX_CHARS` characters of a text. */
function clamp_tail(text: string): string {
	return text.length <= RECENT_TEXT_MAX_CHARS
		? text
		: text.slice(text.length - RECENT_TEXT_MAX_CHARS);
}

/** Entry timestamp, read straight off the line without parsing it. */
function entry_timestamp(line: string): number | null {
	const at = line.indexOf(TIMESTAMP_KEY, 20);
	if (at < 0) return null;
	const from = at + TIMESTAMP_KEY.length;
	const value = Date.parse(line.slice(from, from + 24));
	return Number.isNaN(value) ? null : value;
}

/** Text blocks of one message (mirrors Pi's `extractTextContent`). */
function message_text(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: unknown } => {
			return (
				typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
			);
		})
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join(" ")
		.trim();
}

function is_chat_message(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const raw = message as { role?: unknown; content?: unknown };
	return typeof raw.role === "string" && "content" in raw;
}

function chat_role(message: unknown): string {
	return is_chat_message(message) ? String((message as { role: unknown }).role) : "";
}

/** Apply one complete JSONL line to the scan state. */
function apply_line(line: string, state: ScanState): void {
	if (line.startsWith(MESSAGE_PREFIX)) {
		state.messageCount++;
		// Pi's activity time only counts user/assistant messages (not tool
		// results). Role markers inside JSON string content are escaped, so a raw
		// substring check cannot be fooled by conversation text.
		const is_user = line.includes('"role":"user"');
		if (is_user || line.includes('"role":"assistant"')) {
			const ts = entry_timestamp(line);
			if (ts !== null && (state.lastActivity === null || ts > state.lastActivity)) {
				state.lastActivity = ts;
			}
		}
		// The opening request is decoded right here: the line is already in hand,
		// so it costs one parse instead of a second read of the file.
		if (is_user && !state.captured_first_user) {
			state.captured_first_user = true;
			try {
				const entry = JSON.parse(line) as { message?: unknown };
				state.firstMessage = message_text(entry.message);
			} catch {
				/* keep "(no messages)" */
			}
		}
		return;
	}
	if (line.startsWith(SESSION_INFO_PREFIX)) {
		try {
			const entry = JSON.parse(line) as { name?: unknown };
			// Pi keeps the newest name, including an explicit clear.
			state.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
		} catch {
			/* a malformed line must never break the scan */
		}
		return;
	}
	if (line.startsWith(COMPACTION_PREFIX)) {
		try {
			const entry = JSON.parse(line) as { summary?: unknown };
			if (typeof entry.summary === "string" && entry.summary.trim()) {
				state.checkpoints.push(entry.summary.slice(0, CHECKPOINT_MAX_CHARS));
				if (state.checkpoints.length > MAX_CHECKPOINTS) state.checkpoints.shift();
			}
		} catch {
			/* a malformed line must never break the scan */
		}
		return;
	}
	if (!state.header && line.startsWith(HEADER_PREFIX)) {
		try {
			state.header = JSON.parse(line) as Record<string, unknown>;
		} catch {
			/* an unreadable header drops the file, like Pi's list does */
		}
	}
}

/**
 * Streaming pass over `[start, end)`. A trailing line without a newline (a write
 * in flight) is left unconsumed for the next scan.
 */
async function scan_range(
	handle: fs.FileHandle,
	start: number,
	end: number,
	state: ScanState,
): Promise<void> {
	const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
	let position = start;
	let carry = "";
	while (position < end) {
		const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		const text = carry + buffer.toString("utf8", 0, bytesRead);
		// Walk lines by index instead of splitting the whole chunk into an array,
		// and only apply the lines that are complete in this chunk.
		const complete = text.lastIndexOf("\n") + 1;
		let line_start = 0;
		for (;;) {
			const newline = text.indexOf("\n", line_start);
			if (newline < 0 || newline >= complete) break;
			if (newline > line_start) apply_line(text.slice(line_start, newline), state);
			line_start = newline + 1;
		}
		carry = text.slice(line_start);
	}
	state.consumedSize = position - Buffer.byteLength(carry, "utf8");
}

/**
 * Recent conversation text: the last `TAIL_BYTES` of the file, parsed newest
 * first so the parsing stops as soon as the corpus window is full. The bulk of
 * the file is never parsed.
 */
async function read_recent_text(handle: fs.FileHandle, size: number): Promise<string> {
	if (size <= 0) return "";
	const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
	const buffer = Buffer.allocUnsafe(size - start);
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
	let text = buffer.toString("utf8", 0, bytesRead);
	if (start > 0) {
		// Drop the partial first line: its beginning is before the window.
		const first_newline = text.indexOf("\n");
		text = first_newline < 0 ? "" : text.slice(first_newline + 1);
	}
	const lines = text.split("\n");
	const newest_first: string[] = [];
	let length = 0;
	for (let index = lines.length - 1; index >= 0 && length < RECENT_TEXT_MAX_CHARS; index--) {
		const line = lines[index];
		if (!line?.startsWith(MESSAGE_PREFIX)) continue;
		try {
			const entry = JSON.parse(line) as { message?: unknown };
			const role = chat_role(entry.message);
			if (role !== "user" && role !== "assistant") continue;
			const piece = message_text(entry.message);
			if (!piece) continue;
			newest_first.push(piece);
			length += piece.length + 1;
		} catch {
			/* a malformed line must never break the scan */
		}
	}
	return clamp_tail(newest_first.reverse().join(" "));
}

function build_corpus(state: ScanState): string {
	const parts: string[] = [];
	if (state.firstMessage && state.firstMessage !== "(no messages)") {
		parts.push(state.firstMessage.slice(0, FIRST_MESSAGE_MAX_CHARS));
	}
	parts.push(...state.checkpoints);
	if (state.recent) parts.push(state.recent);
	return parts.join("\n");
}

function record_from_state(
	path: string,
	state: ScanState,
	size: number,
	mtimeMs: number,
	previous: SessionRecord | undefined,
): SessionRecord | null {
	const header = state.header;
	const id = typeof header?.id === "string" ? header.id : previous?.id;
	if (!id) return null;
	const header_time =
		typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
	const created = !Number.isNaN(header_time)
		? new Date(header_time)
		: (previous?.created ?? new Date(mtimeMs));
	const modified =
		state.lastActivity !== null
			? new Date(state.lastActivity)
			: !Number.isNaN(header_time)
				? new Date(header_time)
				: (previous?.modified ?? new Date(mtimeMs));
	const firstMessage = state.firstMessage || previous?.firstMessage || "";
	return {
		path,
		id,
		cwd: typeof header?.cwd === "string" ? header.cwd : (previous?.cwd ?? ""),
		parentSessionPath:
			typeof header?.parentSession === "string"
				? header.parentSession
				: previous?.parentSessionPath,
		name: state.name,
		created,
		modified,
		messageCount: state.messageCount,
		firstMessage: firstMessage || "(no messages)",
		corpus: build_corpus(state),
		checkpoints: [...state.checkpoints],
		size,
		consumedSize: state.consumedSize,
		mtimeMs,
	};
}

/** Full read of one session file. */
async function read_whole_file(
	path: string,
	size: number,
	mtimeMs: number,
): Promise<SessionRecord | null> {
	const handle = await fs.open(path, "r");
	try {
		const state = empty_state();
		await scan_range(handle, 0, size, state);
		if (!state.header) return null;
		state.recent = await read_recent_text(handle, size);
		return record_from_state(path, state, size, mtimeMs, undefined);
	} finally {
		await handle.close();
	}
}

/** Append-only update: only the bytes written since the last scan are read. */
async function read_delta(
	path: string,
	size: number,
	mtimeMs: number,
	previous: SessionRecord,
): Promise<SessionRecord> {
	const handle = await fs.open(path, "r");
	try {
		const state = empty_state();
		state.header = {
			id: previous.id,
			cwd: previous.cwd,
			parentSession: previous.parentSessionPath,
		};
		state.name = previous.name;
		state.messageCount = previous.messageCount;
		state.firstMessage = previous.firstMessage;
		state.captured_first_user = previous.firstMessage !== "(no messages)";
		state.checkpoints = [...previous.checkpoints];
		if (previous.modified instanceof Date && !Number.isNaN(previous.modified.getTime())) {
			state.lastActivity = previous.modified.getTime();
		}
		await scan_range(handle, previous.consumedSize, size, state);
		// The previous corpus stays as older context and the appended turn is
		// merged into the same bounded window.
		const recent = await read_recent_text(handle, size);
		state.recent = clamp_tail([previous.corpus, recent].filter(Boolean).join(" "));
		return (
			record_from_state(path, state, size, mtimeMs, previous) ?? {
				...previous,
				size,
				consumedSize: state.consumedSize,
				mtimeMs,
			}
		);
	} finally {
		await handle.close();
	}
}

/**
 * Read (or incrementally update) one session file's record.
 *
 * Returns null when the file has no usable `session` header — the same call Pi's
 * list makes for a file it cannot read.
 */
export async function read_session_record(
	path: string,
	previous?: SessionRecord | undefined,
): Promise<SessionRecord | null> {
	let size: number;
	let mtimeMs: number;
	try {
		const stats = await fs.stat(path);
		size = stats.size;
		mtimeMs = Math.floor(stats.mtimeMs);
	} catch {
		return null;
	}
	if (previous) {
		if (size === previous.size && mtimeMs === previous.mtimeMs) return previous;
		// Append-only fast path; a shrink or a same-size rewrite is re-read whole.
		if (size > previous.consumedSize && size >= previous.size) {
			return read_delta(path, size, mtimeMs, previous);
		}
	}
	return read_whole_file(path, size, mtimeMs);
}

/** The `SessionInfo` shape every consumer already speaks. */
export function record_to_session_info(record: SessionRecord): SessionInfo {
	return {
		path: record.path,
		id: record.id,
		cwd: record.cwd,
		name: record.name,
		parentSessionPath: record.parentSessionPath,
		created: record.created,
		modified: record.modified,
		messageCount: record.messageCount,
		firstMessage: record.firstMessage,
		allMessagesText: record.corpus,
	} as SessionInfo;
}
