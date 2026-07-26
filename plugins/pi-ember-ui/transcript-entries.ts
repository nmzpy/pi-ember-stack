/** Minimal session entry shape for transcript ordering (Pi session-manager). */
export type TranscriptSessionEntry = {
	id: string;
	type: string;
	parentId?: string | null;
	firstKeptEntryId?: string;
	message?: { role?: string };
	display?: boolean;
};

export type TranscriptSessionManager = {
	getBranch(fromId?: string): TranscriptSessionEntry[];
};

/**
 * Build the visible chat transcript in chronological branch order.
 *
 * Pi's `buildContextEntries()` collapses history for LLM context (compaction
 * row first, drops pre-firstKept entries). The TUI keeps the full branch so
 * compaction is appended at its chronological position without deleting
 * upstream plan, assistant, or tool rows.
 */
export function build_transcript_entries(manager: TranscriptSessionManager): TranscriptSessionEntry[] {
	return manager.getBranch();
}
