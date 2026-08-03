/**
 * pi-ember-todo — Ember-owned task list extension for Pi.
 *
 * Registers the `todo` tool and `/todos` slash command. Task lists render in
 * the chat transcript with neutral text/dim/muted tokens. Adapted from
 * `@xaccefy/pi-xtodo` (MIT, (c) 2025 x4cc3); see ./LICENSE for upstream
 * attribution. The adapter is distributed under AGPL-3.0-or-later as part of
 * pi-ember-stack.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { coerce_id, prepare_todo_arguments } from "./normalize.ts";
import { getSharedTodoRenderer, seed_todo_renderer_from_branch } from "./render.ts";
import { flatten_todo_timeline, todo_group_boundary_before, branch_entries_after_last_compaction, is_post_compaction_todo_call } from "./timeline.ts";

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

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear" | "batch";
const VALID_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"]);

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
	action: string_enum(["create", "update", "list", "get", "delete", "clear", "batch"] as const, {
		description: "create | update | list | get | delete | clear | batch",
	}),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Existing task subject to target when id is unknown" }),
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
	id: Type.Optional(Type.Number({ description: "Task id for update, get, or delete" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list returns deleted tasks too" }),
	),
	batch: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.Number()),
				subject: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				activeForm: Type.Optional(Type.String()),
				status: Type.Optional(
					string_enum(["pending", "in_progress", "completed", "deleted"] as const),
				),
				addBlockedBy: Type.Optional(Type.Array(Type.Number())),
				removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
				owner: Type.Optional(Type.String()),
			}),
			{
				description:
					"One or more per-task updates. With action update: a single item merges with top-level id/status; multiple items run as batch. Prefer action batch for multi-task updates.",
			},
		),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

// ---------------------------------------------------------------------------
// State Management (Per-Session Store & Replay)
// ---------------------------------------------------------------------------

const sessions = new Map<string, TaskState>();
let active_render_session = "";
let active_render_ctx: ExtensionContext | undefined;

function settle_todo_group_before_render(ctx: ExtensionContext, tool_call_id: string): void {
	const branch = ctx.sessionManager.getBranch() ?? [];
	const timeline = flatten_todo_timeline(branch_entries_after_last_compaction(branch));
	if (todo_group_boundary_before(timeline, tool_call_id)) {
		getSharedTodoRenderer().settleGroup();
	}
}

function should_paint_todo_row(ctx: ExtensionContext, tool_call_id: string): boolean {
	const branch = ctx.sessionManager.getBranch() ?? [];
	return is_post_compaction_todo_call(branch, tool_call_id);
}

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
		return normalize_task_state(parsed?.tasks, parsed?.nextId);
	} catch {
		// Corrupt or unreadable file — ignore.
	}
	return undefined;
}

const session_id = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId() ?? "";
const fresh_state = (): TaskState => ({ tasks: [], nextId: 1 });

// ---------------------------------------------------------------------------
// Dotted tool-name rewrite (todo.<action> -> todo + action)
// ---------------------------------------------------------------------------
const DOTTED_TODO_ACTIONS = new Set<string>([
	"create",
	"update",
	"list",
	"get",
	"delete",
	"clear",
	"batch",
]);
const DOTTED_TODO_RE = /^todo\.([a-zA-Z]+)$/;

function normalize_todo_tool_call_part(part: unknown): { changed: boolean; part: unknown } {
	if (!part || typeof part !== "object") return { changed: false, part };
	const p = part as { type?: unknown; name?: string; arguments?: unknown };
	if (p.type !== "toolCall" || typeof p.name !== "string") return { changed: false, part };
	const match = DOTTED_TODO_RE.exec(p.name);
	if (!match) return { changed: false, part };
	const suffix = match[1];
	if (!DOTTED_TODO_ACTIONS.has(suffix)) return { changed: false, part };

	const old_args = (p.arguments ?? {}) as Record<string, unknown>;
	return {
		changed: true,
		part: {
			...p,
			name: TOOL_NAME,
			arguments: { ...old_args, action: suffix },
		},
	};
}

export function rewrite_dotted_todo_calls(message: AgentMessage): AgentMessage | null {
	if (typeof (message as { role?: unknown }).role !== "string") return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;

	let changed = false;
	const new_content = content.map((part: unknown) => {
		const normalized = normalize_todo_tool_call_part(part);
		if (normalized.changed) changed = true;
		return normalized.part;
	});

	if (!changed) return null;
	return { ...message, content: new_content } as AgentMessage;
}
/** Normalize snapshots from older/provider-specific tool calls before lookup. */
function normalize_task_state(tasks_value: unknown, next_id_value: unknown): TaskState | undefined {
	if (!Array.isArray(tasks_value)) return undefined;
	const tasks: Task[] = [];
	const ids = new Set<number>();
	for (const value of tasks_value) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const raw = value as Record<string, unknown>;
		const id = coerce_id(raw.id);
		const subject = typeof raw.subject === "string" ? raw.subject : undefined;
		const status = raw.status;
		if (id === undefined || subject === undefined || !VALID_STATUSES.has(status as TaskStatus)) continue;
		if (ids.has(id)) continue;
		ids.add(id);
		const blocked = Array.isArray(raw.blockedBy)
			? [...new Set(raw.blockedBy.map(coerce_id).filter((dep): dep is number => dep !== undefined))]
			: undefined;
		const task: Task = {
			id,
			subject,
			status: status as TaskStatus,
			...(typeof raw.description === "string" && { description: raw.description }),
			...(typeof raw.activeForm === "string" && { activeForm: raw.activeForm }),
			...(blocked && blocked.length > 0 ? { blockedBy: blocked } : {}),
			...(typeof raw.owner === "string" && { owner: raw.owner }),
			...(raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
				? { metadata: { ...(raw.metadata as Record<string, unknown>) } }
				: {}),
		};
		tasks.push(task);
	}
	const parsed_next_id = coerce_id(next_id_value) ?? 1;
	const highest_id = tasks.reduce((max, task) => Math.max(max, task.id), 0);
	return { tasks, nextId: Math.max(parsed_next_id, highest_id + 1, 1) };
}

function branch_has_todo_result(branch: SessionEntry[]): boolean {
	return branch_entries_after_last_compaction(branch).some(
		(entry) =>
			entry.type === "message" &&
			entry.message?.role === "toolResult" &&
			entry.message.toolName === TOOL_NAME,
	);
}

/** Recover state when a tool call arrives before a session_start refresh. */
const get_session_state = (ctx: ExtensionContext): TaskState => {
	const id = session_id(ctx);
	const current = sessions.get(id);
	if (current) return current;
	const branch = ctx.sessionManager.getBranch() ?? [];
	const recovered = branch_has_todo_result(branch)
		? replay_from_branch(ctx)
		: restore_session_state(id);
	const state = recovered ?? fresh_state();
	sessions.set(id, state);
	return state;
};

// Reconstruct tasks state from session messages history.
export function replay_from_branch(ctx: ExtensionContext): TaskState {
	const id = session_id(ctx);
	const branch = branch_entries_after_last_compaction(ctx.sessionManager.getBranch());
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
		const snapshot = details && normalize_task_state(details.tasks, details.nextId);
		if (snapshot) result = snapshot;
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

type TaskReference = { index: number; id: number } | { error: string };

/** Resolve either the canonical numeric id or an unambiguous subject reference. */
function resolve_task_reference(tasks: Task[], params: TodoParams, action: TaskAction): TaskReference {
	if (params.id !== undefined) {
		const id = coerce_id(params.id);
		if (id === undefined) return { error: "id must be a positive whole number" };
		const index = tasks.findIndex((task) => task.id === id);
		if (index < 0) {
			const available = tasks.filter((task) => task.status !== "deleted").map((task) => `#${task.id}`);
			return {
				error: `#${id} not found${available.length ? `; available ids: ${available.join(", ")}` : "; no tasks exist in this session"}`,
			};
		}
		return { index, id };
	}

	const subject = typeof params.task === "string" ? params.task.trim().toLowerCase() : "";
	if (subject) {
		const matches = tasks
			.map((task, index) => ({ task, index }))
			.filter(({ task }) => task.subject.trim().toLowerCase() === subject);
		if (matches.length === 1) {
			const match = matches[0];
			return { index: match.index, id: match.task.id };
		}
		if (matches.length > 1) return { error: `task ${JSON.stringify(params.task)} is ambiguous; use id` };
		return { error: `task ${JSON.stringify(params.task)} not found; use the id returned by create` };
	}

	return { error: `id required for ${action} (or provide task with the exact subject)` };
}

interface ReducerOutput {
	state: TaskState;
	text: string;
	error?: string;
}

function apply_mutation(state: TaskState, action: TaskAction, params: TodoParams): ReducerOutput {
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
			// Safety net when prepareArguments did not flatten a batch payload.
			if (Array.isArray(params.batch) && params.batch.length > 0) {
				if (params.batch.length === 1) {
					const item = params.batch[0] as Record<string, unknown>;
					const merged = {
						...params,
						...item,
						action: "update",
						id: coerce_id(item.id) ?? coerce_id(params.id),
					} as TodoParams;
					delete (merged as { batch?: unknown }).batch;
					return apply_mutation(state, "update", merged);
				}
				return apply_mutation(state, "batch", {
					action: "batch",
					batch: params.batch,
				} as TodoParams);
			}

			const reference = resolve_task_reference(tasks, params, "update");
			if ("error" in reference) return err(reference.error);
			const idx = reference.index;
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
				const batch_hint =
					"batch" in (params ?? {})
						? " (batch items need id and a mutable field such as status; multi-item updates use action batch automatically after normalization)"
						: "";
				return err(
					`update requires at least one mutable field (subject, description, activeForm, status, owner, metadata, addBlockedBy, removeBlockedBy)${batch_hint}; received keys: [${keys}]`,
				);
			}

			if (
				params.subject !== undefined &&
				(params.subject === null || !String(params.subject).trim())
			) {
				return err("subject cannot be empty");
			}

			let status: TaskStatus = cur.status;
			if (params.status !== undefined) {
				if (params.status !== null && typeof params.status !== "string") {
					return err("status must be a string");
				}
				const target = params.status as TaskStatus;
				if (status !== target && !VALID_TRANSITIONS[status].includes(target)) {
					return err(`illegal transition ${status} → ${target}`);
				}
				status = target;
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
			const reference = resolve_task_reference(tasks, params, "get");
			if ("error" in reference) return err(reference.error);
			const task = tasks[reference.index];

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
			const reference = resolve_task_reference(tasks, params, "delete");
			if ("error" in reference) return err(reference.error);
			const idx = reference.index;
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

		case "batch": {
			const items = params.batch;
			if (!Array.isArray(items) || items.length === 0) {
				return err("batch requires at least one update");
			}
			let batch_state = state;
			let last_text = "";
			for (const item of items) {
				if (!item || typeof item !== "object") return err("batch item must be an object");
				const update_params = {
					action: "update",
					...item,
				} as TodoParams;
				const step = apply_mutation(batch_state, "update", update_params);
				if (step.error) return step;
				batch_state = step.state;
				last_text = step.text;
			}
			return { state: batch_state, text: last_text };
		}
	}
}

// ---------------------------------------------------------------------------
// Extension Entry Point & Setup
// ---------------------------------------------------------------------------
type ToolRenderContext = {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	expanded?: boolean;
	isError?: boolean;
};

type ToolRenderResultOptions = {
	isPartial: boolean;
	expanded?: boolean;
};

export default function piEmberTodo(pi: ExtensionAPI) {
	const todo_renderer = getSharedTodoRenderer();
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: "Manage a task list for tracking multi-step progress.",
		promptSnippet: "Manage a task list to track multi-step progress",
		promptGuidelines: [
			"Use `todo` for complex work with 3+ steps.",
			"Use the numeric id returned by `create` directly; call `list` only when the id is unknown. Updates can also target an exact subject with `task`.",
			"Batch `todo` updates with other tool calls — do not make `todo` the only tool in a turn unless the user asked about task status.",
			"Mark a task `in_progress` before beginning, and `completed` immediately when done.",
			"Task status: pending → in_progress → completed, plus deleted as a tombstone.",
		],
		parameters: TodoParamsSchema,
		renderShell: "self",

		prepareArguments: (args: unknown) => prepare_todo_arguments(args) as TodoParams,

		async execute(_tool_call_id, params, _signal, _on_update, ctx) {
			const action = params.action as TaskAction;
			const id = session_id(ctx);
			const state = get_session_state(ctx);
			// Defensive copy: some runtimes pass a frozen/partial params object.
			const raw = { ...((params ?? {}) as Record<string, unknown>) } as TodoParams;
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

		renderCall(_args: TodoParams, theme: Theme, context: ToolRenderContext) {
			if (active_render_ctx && !should_paint_todo_row(active_render_ctx, context.toolCallId)) {
				return new Text("", 0, 0);
			}
			if (active_render_ctx) {
				settle_todo_group_before_render(active_render_ctx, context.toolCallId);
			}
			return todo_renderer.renderCall([], theme, context);
		},

		renderResult(
			result,
			_opts: ToolRenderResultOptions,
			theme: Theme,
			context: ToolRenderContext,
		) {
			if (active_render_ctx && !should_paint_todo_row(active_render_ctx, context.toolCallId)) {
				return new Text("", 0, 0);
			}
			const details = result.details as TaskDetails | undefined;
			const tasks = details?.tasks ?? [];
			return todo_renderer.renderResult(tasks, theme, context, details?.error);
		},
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const state = get_session_state(ctx);
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

	const branch_has_todo_history = (ctx: ExtensionContext): boolean =>
		branch_has_todo_result(ctx.sessionManager.getBranch() ?? []);

	/** Resolve state for compact/tree: post-compact branch wins when it has todo results. */
	const resolve_state_for_refresh = (ctx: ExtensionContext): TaskState => {
		const id = session_id(ctx);
		if (branch_has_todo_history(ctx)) {
			return replay_from_branch(ctx);
		}
		// No todo tool results on the branch yet. Do not clobber in-memory progress
		// with an empty replay mid-turn; compaction resets via post-compact replay slice.
		if (sessions.has(id)) return sessions.get(id) as TaskState;
		return restore_session_state(id) ?? fresh_state();
	};

	const replay_and_refresh = (ctx: ExtensionContext): void => {
		try {
			const id = session_id(ctx);
			const state = resolve_state_for_refresh(ctx);
			sessions.set(id, state);
			// Keep disk converged with the replayed/live state — otherwise a restart
			// restores an older disk copy while the branch shows something newer.
			save_session_state(id, state);
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
		}
	};

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const content = event.message.content as unknown[];
		if (!Array.isArray(content)) return;
		for (let i = 0; i < content.length; i++) {
			const normalized = normalize_todo_tool_call_part(content[i]);
			if (normalized.changed) {
				content[i] = normalized.part;
			}
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const rewritten = rewrite_dotted_todo_calls(event.message);
		if (rewritten) return { message: rewritten };
	});

	pi.on("message_start", (event) => {
		if (event?.message?.role !== "user") return;
		const display = (event.message as { display?: boolean }).display;
		if (display === false) return;
		todo_renderer.settleGroup();
	});

	pi.on("session_start", async (_event, ctx) => {
		todo_renderer.resetForSession();
		active_render_ctx = ctx;
		try {
			const id = session_id(ctx);
			active_render_session = id;
			const branch = ctx.sessionManager.getBranch() ?? [];
			seed_todo_renderer_from_branch(branch, todo_renderer);
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
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		try {
			const id = session_id(ctx);
			replay_cache.delete(id);
			const branch = ctx.sessionManager.getBranch() ?? [];
			// Compaction starts the todo list fresh: only todo results created
			// after the new compaction entry survive. Pre-compaction tasks are
			// dropped and the durable copy is overwritten with the fresh state so
			// a restart cannot resurrect the old list.
			const state = branch_has_todo_result(branch)
				? replay_from_branch(ctx)
				: fresh_state();
			sessions.set(id, state);
			save_session_state(id, state);
			todo_renderer.resetForSession();
			seed_todo_renderer_from_branch(branch, todo_renderer);
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
		}
	});
	pi.on("session_tree", async (_event, ctx) => replay_and_refresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		todo_renderer.resetForSession();
		active_render_ctx = undefined;
		let id = "";
		try {
			id = session_id(ctx);
		} catch (e) {
			if (!/stale after session replacement/.test(String(e))) throw e;
		}
		sessions.delete(id);
		replay_cache.delete(id);
		if (id === "" || id === active_render_session) {
			active_render_session = "";
		}
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
