import { describe, expect, test } from "bun:test";
import {
	build_transcript_entries,
	type TranscriptSessionEntry,
} from "../transcript-entries.ts";

function branch(entries: TranscriptSessionEntry[]) {
	return { getBranch: () => entries };
}

describe("build_transcript_entries", () => {
	test("returns branch unchanged when no compaction", () => {
		const path: TranscriptSessionEntry[] = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{ id: "a1", type: "message", message: { role: "assistant" } },
		];
		expect(build_transcript_entries(branch(path))).toEqual(path);
	});

	test("keeps full branch in chronological order when compaction is present", () => {
		const path: TranscriptSessionEntry[] = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{ id: "a1", type: "message", message: { role: "assistant" } },
			{ id: "u2", type: "message", message: { role: "user" } },
			{ id: "a2", type: "message", message: { role: "assistant" } },
			{
				id: "c1",
				type: "compaction",
				firstKeptEntryId: "u2",
				message: undefined,
			},
			{ id: "a3", type: "message", message: { role: "assistant" } },
		];
		const transcript = build_transcript_entries(branch(path));
		expect(transcript.map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2", "c1", "a3"]);
	});

	test("does not hoist compaction to the top like buildContextEntries", () => {
		const path: TranscriptSessionEntry[] = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{ id: "a1", type: "message", message: { role: "assistant" } },
			{
				id: "c1",
				type: "compaction",
				firstKeptEntryId: "u1",
			},
			{ id: "a2", type: "message", message: { role: "assistant" } },
		];
		const transcript = build_transcript_entries(branch(path));
		expect(transcript[0]?.id).toBe("u1");
		expect(transcript.findIndex((e) => e.type === "compaction")).toBe(2);
		expect(transcript.at(-1)?.id).toBe("a2");
	});

	test("keeps assistant and tool rows upstream of compaction", () => {
		const path: TranscriptSessionEntry[] = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{ id: "a1", type: "message", message: { role: "assistant" } },
			{ id: "u2", type: "message", message: { role: "user" } },
			{ id: "t1", type: "message", message: { role: "toolResult" } },
			{ id: "a2", type: "message", message: { role: "assistant" } },
			{ id: "c1", type: "compaction", firstKeptEntryId: "u2" },
		];
		const transcript = build_transcript_entries(branch(path));
		expect(transcript.map((e) => e.id)).toEqual(["u1", "a1", "u2", "t1", "a2", "c1"]);
	});

	test("preserves all entry types upstream of compaction", () => {
		const path: TranscriptSessionEntry[] = [
			{ id: "u1", type: "message", message: { role: "user" } },
			{ id: "m1", type: "custom_message", display: true },
			{ id: "a1", type: "message", message: { role: "assistant" } },
			{ id: "c1", type: "compaction", firstKeptEntryId: "u1" },
		];
		const transcript = build_transcript_entries(branch(path));
		expect(transcript.map((e) => e.id)).toEqual(["u1", "m1", "a1", "c1"]);
	});
});
