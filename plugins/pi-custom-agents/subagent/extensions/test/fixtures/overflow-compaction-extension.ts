/**
 * Test fixture extension: canned `session_before_compact` compaction.
 *
 * Loaded by the overflow-recovery integration test through the same
 * `discoverAndLoadExtensions` seam the subagent runner uses. Returning a
 * ready-made compaction summary from the hook means Pi's native overflow
 * recovery needs no summarizer model call and no network — the exact
 * `session_before_compact` wiring that Ember's compaction-wiring extension
 * provides in production is exercised with deterministic output.
 *
 * The fixture records every invocation on a shared `globalThis` key so the
 * test process (which loaded this module directly for the record accessors)
 * can assert what the jiti-loaded extension instance observed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TEST_COMPACTION_RECORD_KEY = "__pi_ember_overflow_compaction_test_record__";

export interface OverflowCompactionTestRecord {
	invocations: number;
	reasons: Array<"manual" | "threshold" | "overflow">;
	willRetry: boolean[];
	firstKeptEntryIds: string[];
}

export function get_test_compaction_record(): OverflowCompactionTestRecord {
	const g = globalThis as Record<string, unknown>;
	const existing = g[TEST_COMPACTION_RECORD_KEY] as OverflowCompactionTestRecord | undefined;
	if (existing) return existing;
	const record: OverflowCompactionTestRecord = {
		invocations: 0,
		reasons: [],
		willRetry: [],
		firstKeptEntryIds: [],
	};
	g[TEST_COMPACTION_RECORD_KEY] = record;
	return record;
}

export function reset_test_compaction_record(): void {
	(globalThis as Record<string, unknown>)[TEST_COMPACTION_RECORD_KEY] = {
		invocations: 0,
		reasons: [],
		willRetry: [],
		firstKeptEntryIds: [],
	} satisfies OverflowCompactionTestRecord;
}

export default function install_test_compaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event) => {
		const record = get_test_compaction_record();
		record.invocations++;
		record.reasons.push(event.reason);
		record.willRetry.push(event.willRetry);
		record.firstKeptEntryIds.push(event.preparation.firstKeptEntryId);
		return {
			compaction: {
				summary: "Test stack summary: original task preserved.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { readFiles: [], modifiedFiles: [] },
			},
		};
	});
}
