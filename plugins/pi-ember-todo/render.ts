/**
 * Transcript rendering for the `todo` tool — neutral text/dim/muted tokens only.
 * Consecutive `todo` calls fold into one header with tree child rows (compact-group
 * pattern): only the first call renders; later calls update the shared block.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { BULLET, CompactGroupText } from "../pi-compact-tools/compact-text.ts";
import { statusBulletColor } from "../pi-compact-tools/renderer.ts";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TranscriptTask {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
	blockedBy?: number[];
}

const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

/** Tree prefixes align under the `T` in `• Todo`; glyph sits on the horizontal bar. */
const TREE_TEE = "  ├─";
const TREE_LAST = "  └─";

/** Subject line token: pending=dim, in_progress=text, completed/deleted=muted. */
export function task_subject_token(status: TaskStatus): "dim" | "text" | "muted" {
	if (status === "in_progress") return "text";
	if (status === "completed" || status === "deleted") return "muted";
	return "dim";
}

export function format_transcript_task_line(
	task: TranscriptTask,
	theme: Theme,
	show_id: boolean,
): string {
	const token = task_subject_token(task.status);
	const glyph = theme.fg(token, STATUS_GLYPH[task.status]);
	let subject = theme.fg(token, task.subject);
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = glyph;
	if (show_id) line += ` ${theme.fg("dim", `#${task.id}`)}`;
	line += ` ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	if (task.blockedBy?.length) {
		line += ` ${theme.fg("dim", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

function format_transcript_task_tree_row(
	task: TranscriptTask,
	theme: Theme,
	show_id: boolean,
	is_last: boolean,
): string {
	const token = task_subject_token(task.status);
	const glyph = theme.fg(token, STATUS_GLYPH[task.status]);
	let subject = theme.fg(token, task.subject);
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	const prefix = is_last ? TREE_LAST : TREE_TEE;
	let line = theme.fg("dim", prefix) + glyph;
	if (show_id) line += ` ${theme.fg("dim", `#${task.id}`)}`;
	line += ` ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	if (task.blockedBy?.length) {
		line += ` ${theme.fg("dim", `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
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
		if (existing) return existing;

		const record: TodoCallRecord = { id, tasks: [] };
		this.calls.set(id, record);

		if (this.currentGroup) {
			this.currentGroup.records.push(record);
		} else {
			this.currentGroup = { records: [record], renderOwner: record };
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
		if (!this.currentGroup?.records.includes(record)) return undefined;
		return this.currentGroup;
	}

	latest_group_snapshot(group: TodoGroup): { tasks: TranscriptTask[]; error?: string } {
		for (let i = group.records.length - 1; i >= 0; i--) {
			const r = group.records[i];
			if (r.error) return { tasks: r.tasks, error: r.error };
			if (r.tasks.length > 0) return { tasks: r.tasks, error: undefined };
		}
		return { tasks: [], error: undefined };
	}

	private sync_group_text(group: TodoGroup, theme: Theme): void {
		if (!group.callText) return;
		const { tasks, error } = this.latest_group_snapshot(group);
		group.callText.setText(format_todo_block(tasks, theme, error));
	}

	renderCall(
		tasks: TranscriptTask[],
		theme: Theme,
		context: ToolRenderContext,
		error?: string,
	): Component {
		const record = this.registerCall(context.toolCallId);
		const group = this.groupFor(record);

		if (group && group.records.length > 1 && group.renderOwner !== record) {
			return new Text("", 0, 0);
		}

		const callText =
			context.state.callText instanceof CompactGroupText
				? context.state.callText
				: new CompactGroupText();
		context.state.callText = callText;
		if (group) group.callText = callText;

		const snapshot = group ? this.latest_group_snapshot(group) : { tasks, error };
		const display_tasks = snapshot.tasks.length > 0 ? snapshot.tasks : tasks;
		const display_error = snapshot.error ?? error;
		callText.setText(format_todo_block(display_tasks, theme, display_error));
		return callText;
	}

	renderResult(
		tasks: TranscriptTask[],
		theme: Theme,
		context: ToolRenderContext,
		error?: string,
	): Component {
		this.setResult(context.toolCallId, tasks, error);
		const record = this.calls.get(context.toolCallId);
		if (!record) return new Text("", 0, 0);

		const group = this.groupFor(record);
		if (group) {
			this.sync_group_text(group, theme);
			if (group.records.length > 1 && group.renderOwner !== record) {
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
