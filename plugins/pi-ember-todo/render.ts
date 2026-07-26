/**
 * Transcript rendering for the `todo` tool — neutral text/dim/muted tokens only.
 * Consecutive `todo` calls in one assistant burst fold into one header with tree
 * child rows: only the latest call renders at its transcript position; earlier
 * calls in the burst collapse to zero height. User messages start a fresh group.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { BULLET, CompactGroupText } from "../pi-compact-tools/compact-text.ts";
import { statusBulletColor } from "../pi-compact-tools/renderer.ts";
import { flatten_todo_timeline, todo_group_boundary_before } from "./timeline.ts";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TranscriptTask {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
	blockedBy?: number[];
}

const TREE_TEE = "  ├─";
const TREE_LAST = "  └─";

/** Subject line token: pending=dim, in_progress=text, completed/deleted=muted. */
export function task_subject_token(status: TaskStatus): "dim" | "text" | "muted" {
	if (status === "in_progress") return "text";
	if (status === "completed" || status === "deleted") return "muted";
	return "dim";
}

function format_transcript_task_subject(
	task: TranscriptTask,
	theme: Theme,
	show_id: boolean,
): string {
	const token = task_subject_token(task.status);
	let subject = theme.fg(token, task.subject);
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = "";
	if (show_id) line += `${theme.fg("dim", `#${task.id}`)} `;
	line += subject;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	if (task.blockedBy?.length) {
		line += ` ${theme.fg("dim", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

export function format_transcript_task_line(
	task: TranscriptTask,
	theme: Theme,
	show_id: boolean,
): string {
	return format_transcript_task_subject(task, theme, show_id);
}

function format_transcript_task_tree_row(
	task: TranscriptTask,
	theme: Theme,
	show_id: boolean,
	is_last: boolean,
): string {
	const prefix = is_last ? TREE_LAST : TREE_TEE;
	return theme.fg("dim", prefix) + format_transcript_task_subject(task, theme, show_id);
}

function todo_header_bullet(tasks: TranscriptTask[], theme: Theme): string {
	const visible = tasks.filter((t) => t.status !== "deleted");
	const all_completed = visible.length > 0 && visible.every((t) => t.status === "completed");
	if (all_completed) return statusBulletColor(false, true, theme);
	return theme.fg("muted", BULLET);
}

/** Multi-line todo block (header + tree children) for CompactGroupText. */
export function format_todo_block(tasks: TranscriptTask[], theme: Theme, error?: string): string {
	if (error) {
		return theme.fg("error", error);
	}

	const visible = tasks.filter((t) => t.status !== "deleted");
	const lines: string[] = [
		todo_header_bullet(tasks, theme) + theme.fg("muted", theme.bold("Todo")),
	];
	if (visible.length === 0) return lines.join("\n");

	const show_ids = visible.some((t) => t.blockedBy && t.blockedBy.length > 0);
	for (let i = 0; i < visible.length; i++) {
		lines.push(format_transcript_task_tree_row(visible[i], theme, show_ids, i === visible.length - 1));
	}
	return lines.join("\n");
}

export class TodoTranscriptComponent implements Component {
	constructor(
		private readonly tasks: TranscriptTask[],
		private readonly theme: Theme,
		private readonly error?: string,
	) {}

	render(width: number): string[] {
		const text = format_todo_block(this.tasks, this.theme, this.error);
		return text.split("\n").map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {}
}

export function build_todo_transcript_component(
	tasks: TranscriptTask[],
	theme: Theme,
	error?: string,
): TodoTranscriptComponent {
	return new TodoTranscriptComponent(tasks, theme, error);
}

// ---------------------------------------------------------------------------
// Grouped transcript renderer (consecutive todo calls → one header block)
// ---------------------------------------------------------------------------

interface TodoCallRecord {
	id: string;
	tasks: TranscriptTask[];
	error?: string;
	group?: TodoGroup;
	invalidate?: () => void;
}

interface TodoGroup {
	records: TodoCallRecord[];
	renderOwner: TodoCallRecord;
	callText?: CompactGroupText;
}

type ToolRenderContext = {
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
};

export class TodoRenderer {
	private readonly calls = new Map<string, TodoCallRecord>();
	private currentGroup: TodoGroup | undefined;

	resetForSession(): void {
		this.calls.clear();
		this.currentGroup = undefined;
	}

	settleGroup(): void {
		this.currentGroup = undefined;
	}

	registerCall(id: string): TodoCallRecord {
		const existing = this.calls.get(id);
		if (existing) {
			if (existing.group && !this.currentGroup) {
				this.currentGroup = existing.group;
			}
			return existing;
		}

		const record: TodoCallRecord = { id, tasks: [] };
		this.calls.set(id, record);

		if (this.currentGroup) {
			const prev_owner = this.currentGroup.renderOwner;
			this.currentGroup.records.push(record);
			record.group = this.currentGroup;
			this.currentGroup.renderOwner = record;
			if (prev_owner !== record) prev_owner.invalidate?.();
		} else {
			const group: TodoGroup = { records: [record], renderOwner: record };
			this.currentGroup = group;
			record.group = group;
		}
		return record;
	}

	setResult(id: string, tasks: TranscriptTask[], error?: string): void {
		const record = this.calls.get(id);
		if (!record) return;
		record.tasks = tasks;
		record.error = error;
	}

	private groupFor(record: TodoCallRecord): TodoGroup | undefined {
		return record.group;
	}

	latest_group_snapshot(group: TodoGroup): { tasks: TranscriptTask[]; error?: string } {
		for (let i = group.records.length - 1; i >= 0; i--) {
			const r = group.records[i];
			if (r.error) return { tasks: r.tasks, error: r.error };
			if (r.tasks.length > 0) return { tasks: r.tasks, error: undefined };
		}
		return { tasks: [], error: undefined };
	}

	private bind_call_text(
		group: TodoGroup | undefined,
		theme: Theme,
		context: ToolRenderContext,
		fallback_tasks: TranscriptTask[],
		fallback_error?: string,
	): CompactGroupText {
		const callText =
			context.state.callText instanceof CompactGroupText
				? context.state.callText
				: group?.callText instanceof CompactGroupText
					? group.callText
					: new CompactGroupText();
		context.state.callText = callText;
		if (group) group.callText = callText;
		const snapshot = group ? this.latest_group_snapshot(group) : { tasks: fallback_tasks, error: fallback_error };
		const display_tasks = snapshot.tasks.length > 0 ? snapshot.tasks : fallback_tasks;
		const display_error = snapshot.error ?? fallback_error;
		callText.setText(format_todo_block(display_tasks, theme, display_error));
		return callText;
	}

	renderCall(
		tasks: TranscriptTask[],
		theme: Theme,
		context: ToolRenderContext,
		error?: string,
	): Component {
		const record = this.registerCall(context.toolCallId);
		record.invalidate = context.invalidate;
		const group = this.groupFor(record);

		if (group && group.renderOwner !== record) {
			return new Text("", 0, 0);
		}

		return this.bind_call_text(group, theme, context, tasks, error);
	}

	renderResult(
		tasks: TranscriptTask[],
		theme: Theme,
		context: ToolRenderContext,
		error?: string,
	): Component {
		const record = this.registerCall(context.toolCallId);
		record.invalidate = context.invalidate;
		this.setResult(context.toolCallId, tasks, error);

		const group = this.groupFor(record);
		if (group) {
			this.bind_call_text(group, theme, context, tasks, error);
			if (group.renderOwner !== record) {
				return new Text("", 0, 0);
			}
		}
		return new Text("", 0, 0);
	}
}

let shared_renderer: TodoRenderer | undefined;

export function getSharedTodoRenderer(): TodoRenderer {
	if (!shared_renderer) shared_renderer = new TodoRenderer();
	return shared_renderer;
}

/** Point-in-time task snapshots from branch tool results — SSOT for Pi rebuilds. */
export function seed_todo_renderer_from_branch(
	branch: SessionEntry[],
	renderer: TodoRenderer,
): void {
	const result_by_id = new Map<string, { tasks: TranscriptTask[]; error?: string }>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		const id = msg.toolCallId;
		const details = msg.details as { tasks?: TranscriptTask[]; error?: string } | undefined;
		if (typeof id !== "string" || !details || !Array.isArray(details.tasks)) continue;
		result_by_id.set(id, { tasks: details.tasks, error: details.error });
	}

	const timeline = flatten_todo_timeline(branch);
	for (const entry of timeline) {
		if (entry.kind !== "tool" || entry.name !== "todo") continue;
		if (todo_group_boundary_before(timeline, entry.id)) {
			renderer.settleGroup();
		}
		renderer.registerCall(entry.id);
		const snapshot = result_by_id.get(entry.id);
		if (snapshot) {
			renderer.setResult(entry.id, snapshot.tasks, snapshot.error);
		}
	}
}
