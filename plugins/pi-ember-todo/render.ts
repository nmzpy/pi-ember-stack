/**
 * Transcript rendering for the `todo` tool — neutral text/dim/muted tokens only.
 * Consecutive `todo` calls in one assistant burst fold into one header with
 * subject-only task rows. Descriptions, metadata, active forms, and dependency
 * details stay out of the transcript; the model still receives the full task
 * snapshot in tool details. User messages start a fresh group.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { BULLET, CompactGroupText } from "../pi-compact-tools/compact-text.ts";
import { statusBulletColor } from "../pi-compact-tools/renderer.ts";
import { getSharedRenderer } from "../pi-compact-tools/shared-renderer.ts";
import { flatten_todo_timeline, todo_group_boundary_before, branch_entries_after_last_compaction } from "./timeline.ts";

export interface TodoThemeLike {
	fg(tag: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TranscriptTask {
	id: number;
	subject: string;
	status: TaskStatus;
	activeForm?: string;
}

function task_subject_token(status: TaskStatus): "dim" | "text" | "muted" {
	if (status === "in_progress") return "text";
	if (status === "completed" || status === "deleted") return "muted";
	return "dim";
}

function format_transcript_task_subject(task: TranscriptTask, theme: TodoThemeLike): string {
	let subject = theme.fg(task_subject_token(task.status), task.subject);
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	return subject;
}

const TODO_TREE_INDENT = "  ";

/**
 * Tree prefix indented so the `├`/`└`/`│` pipe starts below the `T` of the
 * `• Todo` header (bullet + space = 2 columns), not below the `d`.
 */
function format_transcript_task_tree_row(
	task: TranscriptTask,
	theme: TodoThemeLike,
	branch: string,
	tree_indent: string = TODO_TREE_INDENT,
): string {
	const dash = task.status === "in_progress" ? "─" : "";
	const prefix = tree_indent + branch + dash;
	return theme.fg("dim", prefix) + format_transcript_task_subject(task, theme);
}

function todo_header_bullet(tasks: TranscriptTask[], theme: TodoThemeLike): string {
	const visible = tasks.filter((t) => t.status !== "deleted");
	const all_completed = visible.length > 0 && visible.every((t) => t.status === "completed");
	if (all_completed) return statusBulletColor(false, true, theme);
	return theme.fg("muted", BULLET);
}

/** Todo tree rows (header + subject-only task rows) without leading bullet. */
export function format_todo_tree(
	tasks: TranscriptTask[],
	theme: TodoThemeLike,
	error?: string,
	tree_indent: string = TODO_TREE_INDENT,
): string[] {
	const visible = tasks.filter((t) => t.status !== "deleted");
	const header = theme.fg("muted", theme.bold("Todo"));
	if (error) return [header, theme.fg("error", error)];
	const lines = [header];
	const last_visible_index = visible.length - 1;
	for (let i = 0; i < visible.length; i++) {
		const task = visible[i];
		let branch: string;
		if (task.status === "completed" || task.status === "deleted") {
			branch = "│";
		} else if (i === last_visible_index) {
			branch = "└";
		} else {
			branch = "├";
		}
		lines.push(format_transcript_task_tree_row(task, theme, branch, tree_indent));
	}
	return lines;
}

/** Compact todo header plus subject-only task rows for CompactGroupText. */
export function format_todo_block(tasks: TranscriptTask[], theme: TodoThemeLike, error?: string): string {
	const visible = tasks.filter((t) => t.status !== "deleted");
	const tree = format_todo_tree(tasks, theme, error);
	const header = todo_header_bullet(visible, theme) + tree[0];
	return [header, ...tree.slice(1)].join("\n");
}

export class TodoTranscriptComponent implements Component {
	constructor(
		private readonly tasks: TranscriptTask[],
		private readonly theme: TodoThemeLike,
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
	theme: TodoThemeLike,
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
		getSharedRenderer().noteSoftInterveningToolCall();
		const record = this.registerCall(context.toolCallId);
		record.invalidate = context.invalidate;
		const group = this.groupFor(record);

		if (group && group.renderOwner !== record) {
			return new Text("", 0, 0);
		}

		if (!group) {
			// Pre-compaction or orphaned tool ids: keep the row empty so they collapse.
			return new Text("", 0, 0);
		}

		const callText = this.bind_call_text(group, theme, context, tasks, error);
		return callText;
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
		// The visual block is already hosted by renderCall; the result only
		// refreshes the shared text. No extra spacer — native tool row spacing
		// already gives the standard one-row padding.
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
	const active_branch = branch_entries_after_last_compaction(branch);
	const result_by_id = new Map<string, { tasks: TranscriptTask[]; error?: string }>();
	for (const entry of active_branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		const id = msg.toolCallId;
		const details = msg.details as { tasks?: TranscriptTask[]; error?: string } | undefined;
		if (typeof id !== "string" || !details || !Array.isArray(details.tasks)) continue;
		result_by_id.set(id, { tasks: details.tasks, error: details.error });
	}

	const timeline = flatten_todo_timeline(active_branch);
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
