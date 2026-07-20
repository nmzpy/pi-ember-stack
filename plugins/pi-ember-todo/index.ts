/**
 * pi-ember-todo — Ember-owned task list extension for Pi.
 *
 * Registers the `todo` tool, `/todos` slash command, and a persistent
 * TodoOverlay widget. Adapted from `@xaccefy/pi-xtodo` (MIT, (c) 2025 x4cc3);
 * see ./LICENSE for upstream attribution. The adapter is distributed under
 * AGPL-3.0-or-later as part of pi-ember-stack.
 *
 * Behavior is preserved (status lifecycle, blockedBy DAG with cycle
 * rejection, replay-from-branch with disk fallback, compact overlay widget).
 * Naming and formatting are aligned to pi-ember-stack conventions
 * (snake_case locals, tabs, double quotes) and the widget key is namespaced
 * under the Ember stack.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "@sinclair/typebox";

/**
 * String enum as `{ type: "string", enum: [...] }` (provider-safe + TypeBox
 * Kind "String"). Do NOT use Type.Union(Type.Literal...) → anyOf/const
 * (providers drop optional fields). Type.String({ enum }) is Kind "String",
 * works with Value.Convert/Check/Compile, and serializes as a plain string
 * enum.
 */
function string_enum<T extends readonly string[]>(
	values: T,
	options?: { description?: string },
): TSchema {
	return Type.String({
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	}) as unknown as TSchema;
}

// ---------------------------------------------------------------------------
// Identity & Types
// ---------------------------------------------------------------------------
export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";
const WIDGET_KEY = "pi-ember-todo";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// TypeBox Schema
// ---------------------------------------------------------------------------
export const TodoParamsSchema = Type.Object({
	action: string_enum(["create", "update", "list", "get", "delete", "clear"] as const, {
		description: "create | update | list | get | delete | clear",
	}),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress",
		}),
	),
	status: Type.Optional(
		string_enum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" }),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only)" }),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only)" }),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata" }),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list returns deleted tasks too" }),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

// ---------------------------------------------------------------------------
// State Management (Per-Session Store & Replay)
// ---------------------------------------------------------------------------

const sessions = new Map<string, TaskState>();
let active_render_session = "";

// Replay cache: avoid rescanning the entire branch message history on every
// session event when nothing has changed. Keyed by session id; validated by
// branch length AND tail-entry identity, so a same-length branch rewrite
// (e.g. two consecutive compacts) cannot serve a stale snapshot.
const replay_cache = new Map<string, { len: number; tail: unknown; state: TaskState }>();

// Test seam: how many times replay_from_branch actually recomputed state.
let replay_compute_count = 0;

// Disk persistence: survive agent/session restarts. The branch message
// history remains the source of truth; this is a fallback when history isn't
// replayed yet. Resolved lazily so tests can redirect via PI_EMBER_TODO_DIR.
function todo_dir(): string {
	const from_env = process.env.PI_EMBER_TODO_DIR?.trim();
	return from_env || join(homedir(), ".pi", "ember-todo");
}

/** Reject path separators / traversal so session ids cannot escape the dir. */
function safe_session_file_id(id: string): string {
	const cleaned = String(id ?? "")
		.replace(/[^a-zA-Z0-9._-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 128);
	return cleaned || "default";
}

function persist_path(id: string): string {
	return join(todo_dir(), `${safe_session_file_id(id)}.json`);
}

function save_session_state(id: string, state: TaskState): void {
	try {
		const dir = todo_dir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(persist_path(id), JSON.stringify(state), "utf8");
	} catch {
		// Best-effort persistence.
	}
}

function restore_session_state(id: string): TaskState | undefined {
	try {
		if (!existsSync(persist_path(id))) return undefined;
		const parsed = JSON.parse(readFileSync(persist_path(id), "utf8")) as TaskState;
		if (parsed && Array.isArray(parsed.tasks) && typeof parsed.nextId === "number") {
			return { tasks: parsed.tasks, nextId: parsed.nextId };
		}
	} catch {
		// Corrupt or unreadable file — ignore.
	}
	return undefined;
}

const session_id = (ctx: any): string => ctx.sessionManager.getSessionId() ?? "";
const fresh_state = (): TaskState => ({ tasks: [], nextId: 1 });
const get_session_state = (id: string): TaskState => sessions.get(id) ?? fresh_state();

// Reconstruct tasks state from session messages history.
export function replay_from_branch(ctx: any): TaskState {
	const id = session_id(ctx);
	const branch = ctx.sessionManager.getBranch();
	const len = branch.length;
	const tail = len > 0 ? branch[len - 1] : undefined;
	const cached = replay_cache.get(id);
	if (cached && cached.len === len && cached.tail === tail) {
		return cached.state;
	}
	replay_compute_count++;
	let result = fresh_state();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
		const details = msg.details as TaskDetails | undefined;
		if (details && Array.isArray(details.tasks) && typeof details.nextId === "number") {
			result = {
				tasks: details.tasks.map((t) => ({ ...t })),
				nextId: details.nextId,
			};
		}
	}
	replay_cache.set(id, { len, tail, state: result });
	return result;
}

// ---------------------------------------------------------------------------
// Reducer Logic & Cycle Detection
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	pending: ["in_progress", "completed", "deleted"],
	in_progress: ["pending", "completed", "deleted"],
	completed: ["deleted"],
	deleted: [],
};

function has_cycle(tasks: Task[], task_id: number, new_blocked_by: number[]): boolean {
	// new_blocked_by is the full replacement dependency list for task_id (not a delta).
	const adj = new Map(
		tasks.map((t) => [t.id, t.id === task_id ? [...new_blocked_by] : [...(t.blockedBy ?? [])]]),
	);
	const visiting = new Set<number>();
	const visited = new Set<number>();

	const dfs = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const neighbor of adj.get(node) ?? []) {
			if (dfs(neighbor)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	// Only task_id's outbound edges changed; any new cycle must be reachable from it.
	return dfs(task_id);
}

/** Coerce tool-call ids (models often send numeric strings) to positive integers. */
function coerce_id(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		// Reject "2.7", "1e2", NaN — only plain positive integers.
		if (Number.isInteger(n) && n > 0 && String(n) === value.trim()) return n;
	}
	return undefined;
}

/** Drop a deleted task id from every other task's blockedBy list. */
function scrub_blocked_by(tasks: Task[], deleted_id: number): void {
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i];
		if (!t.blockedBy?.length) continue;
		const next = t.blockedBy.filter((d) => d !== deleted_id);
		if (next.length !== t.blockedBy.length) {
			tasks[i] = { ...t, blockedBy: next.length ? next : undefined };
		}
	}
}

function coerce_id_list(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: number[] = [];
	const seen = new Set<number>();
	for (const item of value) {
		const n = coerce_id(item);
		if (n === undefined) return undefined;
		if (seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

interface ReducerOutput {
	state: TaskState;
	text: string;
	error?: string;
}

function apply_mutation(state: TaskState, action: TaskAction, params: any): ReducerOutput {
	const tasks = state.tasks.map((t) => ({ ...t }));
	let next_id = state.nextId;

	const err = (msg: string): ReducerOutput => ({ state, text: `Error: ${msg}`, error: msg });

	switch (action) {
		case "create": {
			if (!params.subject?.trim()) return err("subject required for create");
			const blocked =
				params.blockedBy === undefined ? [] : (coerce_id_list(params.blockedBy) ?? null);
			if (blocked === null) return err("blockedBy must be an array of numbers");
			for (const dep of blocked) {
				const dep_task = tasks.find((t) => t.id === dep);
				if (!dep_task) return err(`blockedBy: #${dep} not found`);
				if (dep_task.status === "deleted") return err(`blockedBy: #${dep} is deleted`);
			}
			const new_task: Task = {
				id: next_id++,
				subject: String(params.subject).trim(),
				status: "pending",
				...(params.description && { description: params.description }),
				...(params.activeForm && { activeForm: params.activeForm }),
				...(blocked.length && { blockedBy: blocked }),
				...(params.owner && { owner: params.owner }),
				...(params.metadata && { metadata: { ...params.metadata } }),
			};
			tasks.push(new_task);
			return {
				state: { tasks, nextId: next_id },
				text: `Created #${new_task.id}: ${new_task.subject} (pending)`,
			};
		}

		case "update": {
			if (params.id === undefined) return err("id required for update");
			const id = coerce_id(params.id);
			if (id === undefined) return err("id must be a number");
			const idx = tasks.findIndex((t) => t.id === id);
			if (idx === -1) return err(`#${id} not found`);
			const cur = tasks[idx];
			if (cur.status === "deleted") return err(`#${cur.id} is deleted`);

			const add_blocked_by =
				params.addBlockedBy !== undefined ? coerce_id_list(params.addBlockedBy) : undefined;
			if (params.addBlockedBy !== undefined && add_blocked_by === undefined) {
				return err("addBlockedBy must be an array of numbers");
			}
			const remove_blocked_by =
				params.removeBlockedBy !== undefined ? coerce_id_list(params.removeBlockedBy) : undefined;
			if (params.removeBlockedBy !== undefined && remove_blocked_by === undefined) {
				return err("removeBlockedBy must be an array of numbers");
			}

			// Explicitly-provided fields count even when empty (e.g. addBlockedBy: []).
			// Models often send status-only updates; do not require a second field.
			const has_mutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				params.addBlockedBy !== undefined ||
				params.removeBlockedBy !== undefined;
			if (!has_mutation) {
				const keys = Object.keys(params ?? {})
					.sort()
					.join(", ");
				return err(
					`update requires at least one mutable field (subject, description, activeForm, status, owner, metadata, addBlockedBy, removeBlockedBy); received keys: [${keys}]`,
				);
			}

			if (
				params.subject !== undefined &&
				(params.subject === null || !String(params.subject).trim())
			) {
				return err("subject cannot be empty");
			}

			let status = cur.status;
			if (params.status !== undefined) {
				if (params.status !== null && typeof params.status !== "string") {
					return err("status must be a string");
				}
				if (status !== params.status && !VALID_TRANSITIONS[status].includes(params.status)) {
					return err(`illegal transition ${status} → ${params.status}`);
				}
				status = params.status;
			}

			let blocked = cur.blockedBy ? [...cur.blockedBy] : [];
			if (remove_blocked_by?.length) {
				const rm = new Set(remove_blocked_by);
				blocked = blocked.filter((d) => !rm.has(d));
			}
			if (add_blocked_by?.length) {
				for (const dep of add_blocked_by) {
					if (dep === cur.id) return err(`cannot block #${cur.id} on itself`);
					const dep_task = tasks.find((t) => t.id === dep);
					if (!dep_task) return err(`addBlockedBy: #${dep} not found`);
					if (dep_task.status === "deleted") return err(`addBlockedBy: #${dep} is deleted`);
					if (!blocked.includes(dep)) blocked.push(dep);
				}
				if (has_cycle(tasks, cur.id, blocked)) {
					return err("addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let metadata = cur.metadata;
			if (params.metadata !== undefined) {
				const merged = { ...(cur.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				metadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = {
				...cur,
				status,
				...(params.subject !== undefined && { subject: String(params.subject).trim() }),
				...(params.description !== undefined && {
					description: params.description === null ? undefined : params.description,
				}),
				...(params.activeForm !== undefined && {
					activeForm: params.activeForm === null ? undefined : params.activeForm,
				}),
				...(params.owner !== undefined && {
					owner: params.owner === null ? undefined : params.owner,
				}),
				blockedBy: blocked.length ? blocked : undefined,
				metadata,
			};
			tasks[idx] = updated;
			// Soft-delete via status=deleted must also free dependents (same as delete action).
			if (params.status === "deleted") {
				scrub_blocked_by(tasks, cur.id);
			}
			const transition_str = cur.status !== status ? ` (${cur.status} → ${status})` : "";
			return {
				state: { tasks, nextId: next_id },
				text: `Updated #${updated.id}${transition_str}`,
			};
		}

		case "list": {
			let view = tasks;
			if (!params.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (params.status) view = view.filter((t) => t.status === params.status);
			const formatted =
				view.length === 0
					? "No tasks"
					: view
							.map((t) => {
								const block = t.blockedBy?.length
									? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
									: "";
								const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
								return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
							})
							.join("\n");
			return { state, text: formatted };
		}

		case "get": {
			if (params.id === undefined) return err("id required for get");
			const id = coerce_id(params.id);
			if (id === undefined) return err("id must be a number");
			const task = tasks.find((t) => t.id === id);
			if (!task) return err(`#${id} not found`);

			const blocks: number[] = [];
			for (const t of tasks) {
				if (t.blockedBy?.includes(task.id)) blocks.push(t.id);
			}

			const lines = [`#${task.id} [${task.status}] ${task.subject}`];
			if (task.description) lines.push(`  description: ${task.description}`);
			if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
			if (task.blockedBy?.length)
				lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
			if (blocks.length) lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
			if (task.owner) lines.push(`  owner: ${task.owner}`);
			return { state, text: lines.join("\n") };
		}

		case "delete": {
			if (params.id === undefined) return err("id required for delete");
			const id = coerce_id(params.id);
			if (id === undefined) return err("id must be a number");
			const idx = tasks.findIndex((t) => t.id === id);
			if (idx === -1) return err(`#${id} not found`);
			const cur = tasks[idx];
			if (cur.status === "deleted") return err(`#${cur.id} is already deleted`);
			tasks[idx] = { ...cur, status: "deleted" };
			// Dependents must not stay blocked on a tombstone forever.
			scrub_blocked_by(tasks, cur.id);
			return {
				state: { tasks, nextId: next_id },
				text: `Deleted #${cur.id}: ${cur.subject}`,
			};
		}

		case "clear": {
			return {
				state: fresh_state(),
				text: `Cleared ${tasks.length} tasks`,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// TUI Rendering & Format Helpers
// ---------------------------------------------------------------------------
const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};
const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};
const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

function format_overlay_task_line(t: Task, theme: Theme, show_id: boolean): string {
	const glyph =
		t.status === "pending"
			? theme.fg("dim", "○")
			: t.status === "in_progress"
				? theme.fg("warning", "◐")
				: t.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
	const sc = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(sc, t.subject);
	if (t.status === "completed" || t.status === "deleted") subject = theme.strikethrough(subject);
	let line = `${glyph}`;
	if (show_id) line += ` ${theme.fg("accent", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm)
		line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
	if (t.blockedBy?.length)
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	return line;
}

// ---------------------------------------------------------------------------
// Todo Overlay Widget
// ---------------------------------------------------------------------------
export class TodoOverlay {
	private ui_ctx: ExtensionUIContext | undefined;
	private widget_registered = false;
	private tui: TUI | undefined;
	private completed_task_ids_pending_hide = new Set<number>();
	private hidden_completed_task_ids = new Set<number>();
	private last_next_id: number | undefined;

	set_ui_ctx(ctx: ExtensionUIContext): void {
		if (ctx !== this.ui_ctx) {
			this.ui_ctx = ctx;
			this.widget_registered = false;
			this.tui = undefined;
		}
	}

	dispose(): void {
		if (this.ui_ctx) this.ui_ctx.setWidget(WIDGET_KEY, undefined);
		this.widget_registered = false;
		this.tui = undefined;
		this.ui_ctx = undefined;
		this.reset_completed_display_state();
	}

	update(): void {
		if (!this.ui_ctx) return;
		const snapshot = get_session_state(active_render_session);
		const visible = snapshot.tasks.filter(
			(t) =>
				t.status !== "deleted" &&
				!(t.status === "completed" && this.hidden_completed_task_ids.has(t.id)),
		);

		if (visible.length === 0) {
			if (this.widget_registered) {
				this.ui_ctx.setWidget(WIDGET_KEY, undefined);
				this.widget_registered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widget_registered) {
			this.ui_ctx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render_widget(theme, width),
						invalidate: () => {
							this.widget_registered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widget_registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	reset_completed_display_state(): void {
		this.completed_task_ids_pending_hide.clear();
		this.hidden_completed_task_ids.clear();
		this.last_next_id = undefined;
	}

	hide_completed_tasks_from_previous_turn(): void {
		if (this.completed_task_ids_pending_hide.size === 0) return;
		for (const id of this.completed_task_ids_pending_hide) {
			this.hidden_completed_task_ids.add(id);
		}
		this.completed_task_ids_pending_hide.clear();
		this.tui?.requestRender();
	}

	private render_widget(theme: Theme, width: number): string[] {
		const state = get_session_state(active_render_session);
		if (this.last_next_id !== undefined && state.nextId < this.last_next_id) {
			this.reset_completed_display_state();
		}
		this.last_next_id = state.nextId;

		const completed_set = new Set(
			state.tasks.filter((t) => t.status === "completed").map((t) => t.id),
		);
		for (const id of this.completed_task_ids_pending_hide)
			if (!completed_set.has(id)) this.completed_task_ids_pending_hide.delete(id);
		for (const id of this.hidden_completed_task_ids)
			if (!completed_set.has(id)) this.hidden_completed_task_ids.delete(id);

		const overlay_tasks = state.tasks.filter(
			(t) =>
				t.status !== "deleted" &&
				!(t.status === "completed" && this.hidden_completed_task_ids.has(t.id)),
		);
		if (overlay_tasks.length === 0) return [];

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const total = overlay_tasks.filter((t) => t.status !== "deleted").length;
		const completed = overlay_tasks.filter((t) => t.status === "completed").length;
		const has_active = overlay_tasks.some(
			(t) => t.status === "in_progress" || t.status === "pending",
		);
		const show_ids = overlay_tasks.some((t) => t.blockedBy && t.blockedBy.length > 0);

		const heading_color = has_active ? "accent" : "dim";
		const heading_icon = has_active ? "●" : "○";
		const heading = truncate(
			`${theme.fg(heading_color, heading_icon)} ${theme.fg(heading_color, `Todos (${completed}/${total})`)}`,
		);

		const lines = [heading];
		const budget = 11; // getMaxWidgetLines() - 1, simplified to 11
		const non_completed = overlay_tasks.filter((t) => t.status !== "completed");
		const total_completed = overlay_tasks.length - non_completed.length;

		let visible: Task[] = [];
		let hidden_completed = 0;
		let truncated_tail = 0;

		if (overlay_tasks.length <= budget) {
			visible = overlay_tasks;
		} else if (non_completed.length <= budget) {
			const kept = new Set<Task>(non_completed);
			for (const t of overlay_tasks) {
				if (kept.size >= budget) break;
				if (t.status === "completed") kept.add(t);
			}
			visible = overlay_tasks.filter((t) => kept.has(t));
			hidden_completed = total_completed - visible.filter((t) => t.status === "completed").length;
		} else {
			visible = non_completed.slice(0, budget);
			truncated_tail = non_completed.length - budget;
			hidden_completed = total_completed;
		}

		for (const task of visible) {
			lines.push(
				truncate(`${theme.fg("dim", "├─")} ${format_overlay_task_line(task, theme, show_ids)}`),
			);
		}

		for (const t of overlay_tasks) {
			if (
				t.status === "completed" &&
				!this.completed_task_ids_pending_hide.has(t.id) &&
				!this.hidden_completed_task_ids.has(t.id)
			) {
				this.completed_task_ids_pending_hide.add(t.id);
			}
		}

		if (hidden_completed === 0 && truncated_tail === 0) {
			lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
		} else {
			const overflow: string[] = [];
			if (hidden_completed > 0) overflow.push(`${hidden_completed} completed`);
			if (truncated_tail > 0) overflow.push(`${truncated_tail} pending`);
			const summary = `+${hidden_completed + truncated_tail} more (${overflow.join(", ")})`;
			lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		}

		lines.push("");
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Extension Entry Point & Setup
// ---------------------------------------------------------------------------
export default function piEmberTodo(pi: ExtensionAPI) {
	let todo_overlay: TodoOverlay | undefined;

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: "Manage a task list for tracking multi-step progress.",
		promptSnippet: "Manage a task list to track multi-step progress",
		promptGuidelines: [
			"Use `todo` for complex work with 3+ steps.",
			"Batch `todo` updates with other tool calls — do not make `todo` the only tool in a turn unless the user asked about task status.",
			"Mark a task `in_progress` before beginning, and `completed` immediately when done.",
			"Task status: pending → in_progress → completed, plus deleted as a tombstone.",
		],
		parameters: TodoParamsSchema,

		// Coerce common LLM shapes before schema validation (string ids, etc.).
		// Uses the same strict rules as the reducer's coerce_id, so an input is
		// either accepted or rejected identically on both paths (no "1e2" → 100).
		prepareArguments: (args: unknown) => {
			const a = { ...((args ?? {}) as Record<string, unknown>) };
			if (a.id !== undefined && a.id !== null && typeof a.id !== "number") {
				const n = coerce_id(a.id);
				if (n !== undefined) a.id = n;
			}
			for (const key of ["blockedBy", "addBlockedBy", "removeBlockedBy"] as const) {
				if (!Array.isArray(a[key])) continue;
				a[key] = (a[key] as unknown[]).map((v) => {
					if (typeof v === "number") return v;
					const n = coerce_id(v);
					return n !== undefined ? n : v;
				});
			}
			return a as TodoParams;
		},

		async execute(_tool_call_id, params, _signal, _on_update, ctx) {
			const action = params.action as TaskAction;
			const id = session_id(ctx);
			const state = get_session_state(id);
			// Defensive copy: some runtimes pass a frozen/partial params object.
			const raw = { ...((params ?? {}) as Record<string, unknown>) };
			const result = apply_mutation(state, action, raw);
			if (!result.error) {
				sessions.set(id, result.state);
				save_session_state(id, result.state);
				// Branch length may not have advanced yet; drop cache so compact/tree
				// cannot overwrite live state with a stale replay snapshot.
				replay_cache.delete(id);
			}

			const details: TaskDetails = {
				action,
				params: raw,
				tasks: result.state.tasks,
				nextId: result.state.nextId,
				...(result.error && { error: result.error }),
			};

			return {
				content: [{ type: "text" as const, text: result.text }],
				...(result.error ? { isError: true } : {}),
				details,
			};
		},

		renderCall(args: any, theme, _context) {
			const state = get_session_state(active_render_session);
			const glyph = ACTION_GLYPH[args.action as TaskAction] ?? args.action;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);
			if (args.action === "create" && args.subject) {
				text += ` ${theme.fg("dim", args.subject)}`;
			} else if (
				(args.action === "update" || args.action === "get" || args.action === "delete") &&
				args.id !== undefined
			) {
				const call_id = coerce_id(args.id);
				const subj =
					call_id !== undefined ? state.tasks.find((t) => t.id === call_id)?.subject : undefined;
				text += ` ${theme.fg("accent", subj ?? `#${args.id}`)}`;
			} else if (args.action === "list" && args.status) {
				text += ` ${theme.fg("muted", args.status === "in_progress" ? "in progress" : args.status)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as TaskDetails | undefined;
			if (details?.error) {
				return new Text(theme.fg("error", "✗"), 0, 0);
			}
			let status: TaskStatus | undefined;
			if (details) {
				const p = details.params as any;
				if (details.action === "create") status = details.tasks[details.tasks.length - 1]?.status;
				else if (details.action === "update") {
					const call_id = coerce_id(p.id);
					status =
						p.status ??
						(call_id !== undefined
							? details.tasks.find((t) => t.id === call_id)?.status
							: undefined);
				} else if (details.action === "delete") {
					const call_id = coerce_id(p.id);
					status =
						call_id !== undefined ? details.tasks.find((t) => t.id === call_id)?.status : undefined;
				}
			}
			if (status)
				return new Text(
					theme.fg(
						STATUS_COLOR[status],
						`${STATUS_GLYPH[status]} ${status === "in_progress" ? "in progress" : status}`,
					),
					0,
					0,
				);
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const state = get_session_state(session_id(ctx));
			const visible = state.tasks.filter((t) => t.status !== "deleted");
			if (visible.length === 0) {
				ctx.ui.notify("No todos yet.", "info");
				return;
			}
			const pending = visible.filter((t) => t.status === "pending");
			const in_progress = visible.filter((t) => t.status === "in_progress");
			const completed = visible.filter((t) => t.status === "completed");

			const header = [];
			if (completed.length > 0) header.push(`${completed.length}/${visible.length} completed`);
			if (in_progress.length > 0) header.push(`${in_progress.length} in progress`);
			if (pending.length > 0) header.push(`${pending.length} pending`);

			const format_line = (t: Task, glyph: string): string => {
				const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
				const block = t.blockedBy?.length
					? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
					: "";
				return `  ${glyph} #${t.id} ${t.subject}${form}${block}`;
			};

			const lines = [header.join(" · ")];
			if (pending.length > 0) {
				lines.push("── Pending ──");
				for (const t of pending) lines.push(format_line(t, "○"));
			}
			if (in_progress.length > 0) {
				lines.push("── In Progress ──");
				for (const t of in_progress) lines.push(format_line(t, "◐"));
			}
			if (completed.length > 0) {
				lines.push("── Completed ──");
				for (const t of completed) lines.push(format_line(t, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	const branch_has_todo_history = (ctx: any): boolean => {
		const branch = ctx.sessionManager.getBranch() ?? [];
		return branch.some(
			(e: any) => e?.message?.role === "toolResult" && e?.message?.toolName === TOOL_NAME,
		);
	};

	/** Resolve state for compact/tree: branch wins when it has todo results; else keep live/disk. */
	const resolve_state_for_refresh = (ctx: any): TaskState => {
		const id = session_id(ctx);
		if (branch_has_todo_history(ctx)) {
			return replay_from_branch(ctx);
		}
		// No todo tool results on the branch yet. Do not clobber in-memory progress
		// with an empty replay (that was wiping tasks on compact).
		if (sessions.has(id)) return sessions.get(id)!;
		return restore_session_state(id) ?? fresh_state();
	};

	const replay_and_refresh = (ctx: any): void => {
		let is_foreground = false;
		try {
			const id = session_id(ctx);
			const state = resolve_state_for_refresh(ctx);
			sessions.set(id, state);
			// Keep disk converged with the replayed/live state — otherwise a restart
			// restores an older disk copy while the branch shows something newer.
			save_session_state(id, state);
			is_foreground = id === active_render_session;
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
		}
		if (is_foreground) {
			todo_overlay?.reset_completed_display_state();
			todo_overlay?.update();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = session_id(ctx);
			const branch = ctx.sessionManager.getBranch() ?? [];
			if (branch_has_todo_history(ctx)) {
				sessions.set(id, replay_from_branch(ctx));
			} else {
				// Restart recovery: disk fallback when message history has no todo results.
				const restored = restore_session_state(id);
				const state = restored ?? fresh_state();
				sessions.set(id, state);
				replay_cache.set(id, {
					len: branch.length,
					tail: branch.length > 0 ? branch[branch.length - 1] : undefined,
					state,
				});
			}
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
			return;
		}
		if (!ctx.hasUI) return;
		if (todo_overlay === undefined) {
			todo_overlay = new TodoOverlay();
			active_render_session = id;
		}
		if (id !== active_render_session) return;
		todo_overlay.set_ui_ctx(ctx.ui);
		todo_overlay.reset_completed_display_state();
		todo_overlay.update();
	});

	pi.on("session_compact", async (_event, ctx) => replay_and_refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => replay_and_refresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		let id = "";
		try {
			id = session_id(ctx);
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
		}
		sessions.delete(id);
		replay_cache.delete(id);
		if (id === "" || id === active_render_session) {
			try {
				todo_overlay?.dispose();
			} finally {
				todo_overlay = undefined;
				active_render_session = "";
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === TOOL_NAME && !event.isError) {
			todo_overlay?.update();
		}
	});

	pi.on("agent_start", async () => {
		todo_overlay?.hide_completed_tasks_from_previous_turn();
	});
}

// ---------------------------------------------------------------------------
// Testing Hook (Parity with old test-reset exports)
// ---------------------------------------------------------------------------
export function __reset_state(): void {
	sessions.clear();
	replay_cache.clear();
	replay_compute_count = 0;
	if (active_render_session) {
		try {
			unlinkSync(persist_path(active_render_session));
		} catch {
			// File may not exist.
		}
	}
	active_render_session = "";
}

export function __replay_compute_count(): number {
	return replay_compute_count;
}
