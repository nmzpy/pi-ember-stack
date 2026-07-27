import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TodoTimelineEntry =
	| { kind: "user" }
	| { kind: "compact" }
	| { kind: "tool"; id: string; name: string };

/** Branch slice after the latest compaction entry — SSOT for post-compact todo state. */
export function branch_entries_after_last_compaction(branch: SessionEntry[]): SessionEntry[] {
	let last_compact = -1;
	for (let i = 0; i < branch.length; i++) {
		if (branch[i].type === "compaction") last_compact = i;
	}
	return last_compact >= 0 ? branch.slice(last_compact + 1) : branch;
}

/** Flatten branch messages into user markers and tool calls in transcript order. */
export function flatten_todo_timeline(branch: SessionEntry[]): TodoTimelineEntry[] {
	const out: TodoTimelineEntry[] = [];
	for (const entry of branch) {
		if (entry.type === "compaction") {
			out.push({ kind: "compact" });
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "user") {
			const display = (msg as { display?: boolean }).display;
			if (display !== false) out.push({ kind: "user" });
			continue;
		}
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") {
				continue;
			}
			const tc = part as { id?: string; name?: string };
			if (typeof tc.id !== "string" || typeof tc.name !== "string") continue;
			out.push({ kind: "tool", id: tc.id, name: tc.name });
		}
	}
	return out;
}

/** True when `tool_call_id` is a `todo` call in the post-compaction branch slice. */
export function is_post_compaction_todo_call(branch: SessionEntry[], tool_call_id: string): boolean {
	const compacted = branch_entries_after_last_compaction(branch);
	if (compacted.length === branch.length) return true;
	const timeline = flatten_todo_timeline(compacted);
	return timeline.some((e) => e.kind === "tool" && e.id === tool_call_id && e.name === "todo");
}

/** True when the branch contains at least one compaction entry. */
export function branch_had_compaction(branch: SessionEntry[]): boolean {
	return branch.some((e) => e.type === "compaction");
}

/** True when a user message or compaction separates this todo from the previous one. */
export function todo_group_boundary_before(
	timeline: TodoTimelineEntry[],
	tool_call_id: string,
): boolean {
	const idx = timeline.findIndex((e) => e.kind === "tool" && e.id === tool_call_id);
	if (idx <= 0) return false;
	for (let i = idx - 1; i >= 0; i--) {
		const entry = timeline[i];
		if (entry.kind === "user" || entry.kind === "compact") return true;
		if (entry.kind === "tool" && entry.name === "todo") return false;
	}
	return false;
}
