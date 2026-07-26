import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TodoTimelineEntry = { kind: "user" } | { kind: "tool"; id: string; name: string };

/** Flatten branch messages into user markers and tool calls in transcript order. */
export function flatten_todo_timeline(branch: SessionEntry[]): TodoTimelineEntry[] {
	const out: TodoTimelineEntry[] = [];
	for (const entry of branch) {
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

/** True when a user message separates this todo call from the previous todo in the branch. */
export function todo_group_boundary_before(
	timeline: TodoTimelineEntry[],
	tool_call_id: string,
): boolean {
	const idx = timeline.findIndex((e) => e.kind === "tool" && e.id === tool_call_id);
	if (idx <= 0) return false;
	for (let i = idx - 1; i >= 0; i--) {
		const entry = timeline[i];
		if (entry.kind === "user") return true;
		if (entry.kind === "tool" && entry.name === "todo") return false;
	}
	return false;
}
