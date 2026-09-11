import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	CORPUS_MAX_CHARS,
	read_session_record,
	record_to_session_info,
	type SessionRecord,
} from "../session-record.ts";

/**
 * The lean reader must produce the SAME row Pi's `SessionManager.list` produces
 * (id, cwd, name, created, modified, messageCount, firstMessage) while reading a
 * fraction of the bytes, and must update incrementally on append.
 *
 * Pi's parser is the oracle in every test here: both are run on the same
 * fixtures and compared field by field.
 */

const dirs: string[] = [];

/** Pi's list filters rows by the session header's cwd, so fixtures carry it. */
let fixture_cwd = "C:/work/demo";

function temp_dir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ember-session-record-"));
	dirs.push(dir);
	fixture_cwd = dir;
	return dir;
}

let entry_seq = 0;

function line(entry: Record<string, unknown>): string {
	return `${JSON.stringify(entry)}\n`;
}

function header(id: string, timestamp = "2026-09-01T10:00:00.000Z"): string {
	return line({ type: "session", version: 3, id, timestamp, cwd: fixture_cwd });
}

function user_message(text: string, timestamp = "2026-09-01T10:00:01.000Z"): string {
	entry_seq++;
	return line({
		type: "message",
		id: `e${entry_seq}`,
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function assistant_message(text: string, timestamp = "2026-09-01T10:00:02.000Z"): string {
	entry_seq++;
	return line({
		type: "message",
		id: `e${entry_seq}`,
		parentId: null,
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

function tool_result(text: string, timestamp = "2026-09-01T10:00:03.000Z"): string {
	entry_seq++;
	return line({
		type: "message",
		id: `e${entry_seq}`,
		parentId: null,
		timestamp,
		message: { role: "toolResult", content: [{ type: "text", text }] },
	});
}

function session_info(name: string, timestamp = "2026-09-01T10:00:04.000Z"): string {
	entry_seq++;
	return line({
		type: "session_info",
		id: `e${entry_seq}`,
		parentId: null,
		timestamp,
		name,
	});
}

function compaction(summary: string, timestamp = "2026-09-01T10:00:05.000Z"): string {
	entry_seq++;
	return line({
		type: "compaction",
		id: `e${entry_seq}`,
		parentId: null,
		timestamp,
		summary,
	});
}

function write_session(dir: string, id: string, lines: string[]): string {
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, lines.join(""));
	return file;
}

/** Rows from Pi's own parser for one dir, keyed by session id. */
async function pi_rows(dir: string) {
	const rows = await SessionManager.list(dir, dir);
	return new Map(rows.map((row) => [row.id, row]));
}

async function lean_record(file: string, previous?: SessionRecord): Promise<SessionRecord> {
	const record = await read_session_record(file, previous);
	if (!record) throw new Error(`no record for ${file}`);
	return record;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("lean session record", () => {
	test("matches Pi's parser field-for-field on a plain session", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-a", [
			header("session-a"),
			user_message("fix the resume picker"),
			assistant_message("on it"),
			tool_result("bash output"),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-a");
		expect(theirs).toBeDefined();
		expect(mine.id).toBe(theirs?.id);
		expect(mine.cwd).toBe(theirs?.cwd);
		expect(mine.name).toBe(theirs?.name);
		expect(mine.created.getTime()).toBe(theirs?.created.getTime());
		expect(mine.messageCount).toBe(theirs?.messageCount);
		expect(mine.firstMessage).toBe(theirs?.firstMessage);
		expect(mine.modified.getTime()).toBe(theirs?.modified.getTime());
		expect(mine.corpus).toContain("fix the resume picker");
	});

	test("counts a tool-only first message but keeps the first user text", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-b", [
			header("session-b"),
			tool_result("prelude"),
			assistant_message("hello"),
			user_message("second line is the ask"),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-b");
		expect(mine.firstMessage).toBe("second line is the ask");
		expect(mine.firstMessage).toBe(theirs?.firstMessage);
		expect(mine.messageCount).toBe(theirs?.messageCount);
	});

	test("keeps the newest session_info name, including a clear", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-c", [
			header("session-c"),
			user_message("hi"),
			session_info("First Name"),
			assistant_message("ok"),
			session_info("Renamed Later"),
		]);

		const mine = await lean_record(file);
		expect(mine.name).toBe("Renamed Later");
		expect(mine.name).toBe((await pi_rows(dir)).get("session-c")?.name);
	});

	test("survives chunk boundaries on a large session with exact counts", async () => {
		const dir = temp_dir();
		const lines = [header("session-big"), user_message("opening ask")];
		// Well past CHUNK_BYTES (1 MB) so the streaming carry is exercised.
		for (let i = 0; i < 12_000; i++) {
			lines.push(assistant_message(`filler ${i} ${"x".repeat(120)}`));
		}
		lines.push(user_message("final question about zone markers"));
		const file = write_session(dir, "session-big", lines);
		expect(statSync(file).size).toBeGreaterThan(1 << 20);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-big");
		expect(mine.messageCount).toBe(theirs?.messageCount);
		expect(mine.firstMessage).toBe("opening ask");
		expect(mine.modified.getTime()).toBe(theirs?.modified.getTime());
		// The corpus is bounded and still carries both ends of the conversation.
		expect(mine.corpus.length).toBeLessThanOrEqual(CORPUS_MAX_CHARS + 200);
		expect(mine.corpus).toContain("opening ask");
		expect(mine.corpus).toContain("final question about zone markers");
	});

	test("an appended turn updates incrementally, keeping the first message", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-d", [
			header("session-d"),
			user_message("original ask"),
			assistant_message("first reply"),
		]);
		const first = await lean_record(file);

		appendFileSync(
			file,
			`${session_info("Renamed By Append")}${user_message("follow-up question", "2026-09-01T11:00:00.000Z")}${compaction("## Goal\nShip the lean indexer.")}`,
		);

		const updated = await lean_record(file, first);
		const theirs = (await pi_rows(dir)).get("session-d");
		expect(updated).not.toBe(first);
		expect(updated.messageCount).toBe(theirs?.messageCount);
		expect(updated.firstMessage).toBe("original ask");
		expect(updated.name).toBe("Renamed By Append");
		expect(updated.name).toBe(theirs?.name);
		expect(updated.modified.getTime()).toBe(theirs?.modified.getTime());
		expect(updated.corpus).toContain("follow-up question");
		expect(updated.corpus).toContain("Ship the lean indexer.");
		expect(updated.consumedSize).toBe(statSync(file).size);

		// Unchanged file: the same record object, no read at all.
		expect(await lean_record(file, updated)).toBe(updated);
	});

	test("a rewritten (shorter) file is re-read from scratch", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-e", [
			header("session-e"),
			user_message("one"),
			assistant_message("two"),
			user_message("three"),
		]);
		const first = await lean_record(file);

		writeFileSync(
			file,
			[header("session-e"), user_message("only message left")].join(""),
		);
		const rewritten = await lean_record(file, first);
		expect(rewritten.messageCount).toBe(1);
		expect(rewritten.firstMessage).toBe("only message left");
		expect(rewritten.messageCount).toBe((await pi_rows(dir)).get("session-e")?.messageCount);
	});

	test("a file without a session header is dropped, like Pi's list", async () => {
		const dir = temp_dir();
		const file = join(dir, "junk.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "message", id: "x" })}\n`);
		expect(await read_session_record(file)).toBeNull();
		expect((await pi_rows(dir)).size).toBe(0);
	});

	test("compaction checkpoints stay searchable after the bulk is dropped", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-f", [
			header("session-f"),
			user_message("start of a long session"),
			...Array.from({ length: 400 }, (_value, i) => assistant_message(`early ${i}`)),
			compaction("## Goal\nRebuild the session catalog around a bounded reader."),
			...Array.from({ length: 400 }, (_value, i) => assistant_message(`late ${i}`)),
			user_message("current question"),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-f");
		expect(mine.messageCount).toBe(theirs?.messageCount);
		// The pre-compaction bulk is gone from memory, the checkpoint is not.
		expect(mine.corpus).toContain("Rebuild the session catalog around a bounded reader.");
		expect(mine.corpus).toContain("current question");
	});

	test("uses Pi's numeric message timestamp for activity time", async () => {
		const dir = temp_dir();
		// Pi writes `message.timestamp` (ms) at stream time and the entry ISO stamp
		// at write time; they differ by seconds on long turns, and Pi's list uses
		// the message one.
		const numeric = Date.parse("2026-09-01T10:00:05.000Z");
		const file = write_session(dir, "session-numeric", [
			header("session-numeric"),
			user_message("entry stamp only"),
			line({
				type: "message",
				id: "e-numeric",
				parentId: null,
				timestamp: "2026-09-01T10:00:20.000Z",
				message: {
					role: "assistant",
					timestamp: numeric,
					content: [{ type: "text", text: "streamed earlier than written" }],
				},
			}),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-numeric");
		expect(mine.modified.getTime()).toBe(numeric);
		expect(mine.modified.getTime()).toBe(theirs?.modified.getTime());
	});

	test("takes the first user message that has text, like Pi", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-empty-first", [
			header("session-empty-first"),
			user_message(""),
			user_message("the real ask"),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-empty-first");
		expect(mine.firstMessage).toBe("the real ask");
		expect(mine.firstMessage).toBe(theirs?.firstMessage);
	});

	test("counts entries in content text that look like entries", async () => {
		const dir = temp_dir();
		const decoy = '{"type":"message","id":"decoy","message":{"role":"user"}}';
		const file = write_session(dir, "session-decoy", [
			header("session-decoy"),
			user_message(`look at this payload: ${decoy}`),
			assistant_message(`and this role marker: "role":"user"`),
		]);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-decoy");
		// The decoys live inside JSON string values, so they are escaped in the
		// file and can neither add entries nor fake a role.
		expect(mine.messageCount).toBe(2);
		expect(mine.messageCount).toBe(theirs?.messageCount);
		expect(mine.firstMessage).toContain("look at this payload");
	});

	test("reads entries larger than the read window without stalling", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-giant", [
			header("session-giant"),
			user_message("before the giants"),
			tool_result(`giant one ${"x".repeat(1_500_000)}`),
			tool_result(`giant two ${"y".repeat(2_400_000)}`),
			assistant_message("after the giants"),
		]);
		expect(statSync(file).size).toBeGreaterThan(3 << 20);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-giant");
		expect(mine.messageCount).toBe(4);
		expect(mine.messageCount).toBe(theirs?.messageCount);
		expect(mine.firstMessage).toBe("before the giants");
		expect(mine.consumedSize).toBe(statSync(file).size);
	});

	test("a line being written is not consumed until it is complete", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-partial", [
			header("session-partial"),
			user_message("committed ask"),
			assistant_message("committed reply"),
		]);
		const complete_size = statSync(file).size;
		// A torn write: the entry has no terminating newline yet.
		appendFileSync(file, '{"type":"message","id":"torn","message":{"role":"user","content":[{"type":"text","text":"half');
		const partial = await lean_record(file, await lean_record(file));
		expect(partial.messageCount).toBe(2);
		expect(partial.consumedSize).toBe(complete_size);

		// The write lands: the same entry is now counted exactly once.
		appendFileSync(file, ' written"}]}}\n');
		const done = await lean_record(file, partial);
		const theirs = (await pi_rows(dir)).get("session-partial");
		expect(done.messageCount).toBe(theirs?.messageCount);
		expect(done.consumedSize).toBe(statSync(file).size);
		const fresh = await read_session_record(file);
		expect(fresh?.messageCount).toBe(done.messageCount);
	});

	test("keeps a spread sample of earlier user prompts for search", async () => {
		const dir = temp_dir();
		const prompts = Array.from(
			{ length: 60 },
			(_value, i) => `prompt ${i} about zone markers and hashed anchors`,
		);
		const lines = [header("session-spread"), user_message("the opening request")];
		for (const [index, prompt] of prompts.entries()) {
			lines.push(user_message(`EARLY-${index} ${prompt}`));
			lines.push(assistant_message(`reply ${index} ${"filler ".repeat(400)}`));
		}
		lines.push(user_message("the newest question"));
		const file = write_session(dir, "session-spread", lines);

		const mine = await lean_record(file);
		const theirs = (await pi_rows(dir)).get("session-spread");
		expect(mine.messageCount).toBe(theirs?.messageCount);
		// The sample is bounded, and it still carries prompts from the middle of
		// the conversation — the part the tail window cannot reach.
		expect(mine.earlierUserText.length).toBeLessThanOrEqual(4_000);
		expect(mine.earlierUserText).toContain("EARLY-");
		expect(mine.corpus).toContain(mine.earlierUserText.slice(0, 40));
		expect(record_to_session_info(mine).allMessagesText).toContain("EARLY-");
	});

	test("record_to_session_info exposes the row shape every consumer uses", async () => {
		const dir = temp_dir();
		const file = write_session(dir, "session-g", [
			header("session-g"),
			user_message("shape check"),
		]);
		const info = record_to_session_info(await lean_record(file));
		expect(info.path).toBe(file);
		expect(info.id).toBe("session-g");
		expect(info.firstMessage).toBe("shape check");
		expect(info.messageCount).toBe(1);
		expect(info.allMessagesText).toContain("shape check");
		expect(readFileSync(file, "utf-8").startsWith('{"type":"session"')).toBe(true);
	});
});
