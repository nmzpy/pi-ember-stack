/**
 * Coerce provider-specific todo tool argument shapes into Pi's action schema.
 * Runs in prepareArguments before TypeBox validation so nested fields (e.g.
 * Cursor `todos[]` with `status` inside each item) are not stripped as unknown keys.
 */

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TodoParamsLike = {
	action?: string;
	id?: number;
	task?: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	includeDeleted?: boolean;
	batch?: Array<Record<string, unknown>>;
};

const STATUS_ALIASES: Record<string, TaskStatus> = {
	pending: "pending",
	todo: "pending",
	open: "pending",
	in_progress: "in_progress",
	inprogress: "in_progress",
	"in-progress": "in_progress",
	inprogressing: "in_progress",
	working: "in_progress",
	active: "in_progress",
	started: "in_progress",
	completed: "completed",
	complete: "completed",
	done: "completed",
	finished: "completed",
	closed: "completed",
	deleted: "deleted",
	cancelled: "deleted",
	canceled: "deleted",
	removed: "deleted",
};

const NUMERIC_STATUS: Record<number, TaskStatus> = {
	0: "pending",
	1: "pending",
	2: "in_progress",
	3: "completed",
	4: "deleted",
};

function is_record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function first_defined(input: Record<string, unknown>, names: readonly string[]): unknown {
	for (const name of names) {
		if (input[name] !== undefined) return input[name];
	}
	return undefined;
}

function first_array(input: Record<string, unknown>, names: readonly string[]): unknown[] | undefined {
	for (const name of names) {
		const value = input[name];
		if (Array.isArray(value) && value.length > 0) return value;
	}
	return undefined;
}

/** Coerce tool-call ids (models often send numeric strings or `#1`). */
export function coerce_id(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const normalized = value.trim().replace(/^#/, "");
		if (!/^\d+$/.test(normalized)) return undefined;
		const n = Number(normalized);
		if (Number.isSafeInteger(n) && n > 0) return n;
	}
	return undefined;
}

export function normalize_status(value: unknown): TaskStatus | undefined {
	if (typeof value === "number" && Number.isInteger(value)) {
		return NUMERIC_STATUS[value];
	}
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return STATUS_ALIASES[key];
}

function merge_item_fields(target: Record<string, unknown>, item: Record<string, unknown>): void {
	const id = first_defined(item, ["id", "taskId", "todoId", "task_id", "todo_id"]);
	if (target.id === undefined && id !== undefined) {
		const coerced = coerce_id(id);
		if (coerced !== undefined) target.id = coerced;
	}

	const subject = first_defined(item, ["subject", "content", "title", "name", "text", "label"]);
	if (target.subject === undefined && subject !== undefined) target.subject = subject;

	const description = first_defined(item, ["description", "details", "body"]);
	if (target.description === undefined && description !== undefined) target.description = description;

	const active_form = first_defined(item, ["activeForm", "active_form", "activeLabel", "active_label"]);
	if (target.activeForm === undefined && active_form !== undefined) target.activeForm = active_form;

	const owner = first_defined(item, ["owner", "assignee"]);
	if (target.owner === undefined && owner !== undefined) target.owner = owner;

	const raw_status = first_defined(item, ["status", "state", "taskStatus", "task_status"]);
	if (target.status === undefined && raw_status !== undefined) {
		const normalized = normalize_status(raw_status);
		if (normalized) target.status = normalized;
	}

	for (const key of ["blockedBy", "addBlockedBy", "removeBlockedBy"] as const) {
		if (target[key] === undefined && item[key] !== undefined) target[key] = item[key];
	}
}

function unwrap_nested_record(target: Record<string, unknown>): void {
	for (const key of ["data", "task", "patch", "fields", "changes", "update", "item"] as const) {
		const nested = target[key];
		if (!is_record(nested)) continue;
		merge_item_fields(target, nested);
		delete target[key];
	}
}

function normalize_batch_item(item: unknown): Record<string, unknown> | undefined {
	if (!is_record(item)) return undefined;
	const out: Record<string, unknown> = {};
	merge_item_fields(out, item);
	unwrap_nested_record(out);
	if (out.id === undefined && out.status === undefined && out.subject === undefined) return undefined;
	return out;
}

function infer_action(target: Record<string, unknown>): void {
	if (typeof target.action === "string" && target.action.trim()) return;

	if (Array.isArray(target.batch) && target.batch.length > 0) {
		target.action = target.batch.length > 1 ? "batch" : "update";
		return;
	}

	const batch = first_array(target, ["todos", "tasks", "updates", "items"]);
	if (batch) {
		target.action = batch.length > 1 ? "batch" : "update";
		return;
	}
	if (target.id !== undefined || target.task !== undefined) {
		target.action = "update";
		return;
	}
	if (target.subject !== undefined) {
		target.action = "create";
	}
}

/**
 * Flatten `action: "update"` + `batch` combos models send after reading the schema.
 * Single-item batch merges into a plain update; multi-item rewrites to `batch` action.
 */
function finalize_batch_shape(target: Record<string, unknown>): void {
	const raw_batch = target.batch;
	if (!Array.isArray(raw_batch) || raw_batch.length === 0) return;

	const batch = raw_batch
		.map((item) => normalize_batch_item(item))
		.filter((item): item is Record<string, unknown> => item !== undefined);

	if (batch.length === 0) {
		delete target.batch;
		return;
	}

	if (batch.length === 1) {
		const item = batch[0];
		const top_id = coerce_id(target.id);
		if (top_id !== undefined && item.id === undefined) item.id = top_id;
		if (target.status !== undefined && item.status === undefined) {
			item.status = target.status;
		}
		merge_item_fields(target, item);
		delete target.batch;
		if (!target.action || target.action === "batch") target.action = "update";
		return;
	}

	target.action = "batch";
	target.batch = batch;
	delete target.id;
	delete target.status;
	delete target.subject;
	delete target.description;
	delete target.activeForm;
	delete target.addBlockedBy;
	delete target.removeBlockedBy;
	delete target.owner;
	delete target.metadata;
}

function coerce_id_lists(target: Record<string, unknown>): void {
	if (target.id !== undefined && target.id !== null && typeof target.id !== "number") {
		const n = coerce_id(target.id);
		if (n !== undefined) target.id = n;
	}
	for (const key of ["blockedBy", "addBlockedBy", "removeBlockedBy"] as const) {
		if (!Array.isArray(target[key])) continue;
		target[key] = (target[key] as unknown[]).map((v) => {
			if (typeof v === "number") return v;
			const n = coerce_id(v);
			return n !== undefined ? n : v;
		});
	}
}

/** Normalize raw model/provider args into validated TodoParams. */
export function prepare_todo_arguments(args: unknown): TodoParamsLike {
	const target: Record<string, unknown> = { ...((args ?? {}) as Record<string, unknown>) };

	// Cursor / Claude Code batch shapes: { todos: [{ id, content, status }, ...], merge? }
	const batch_raw = first_array(target, ["todos", "tasks", "updates", "items"]);
	if (batch_raw) {
		const batch = batch_raw
			.map((item) => normalize_batch_item(item))
			.filter((item): item is Record<string, unknown> => item !== undefined);
		delete target.todos;
		delete target.tasks;
		delete target.updates;
		delete target.items;
		delete target.merge;

		if (batch.length === 1) {
			merge_item_fields(target, batch[0]);
		} else if (batch.length > 1) {
			target.batch = batch;
		}
	}

	unwrap_nested_record(target);

	// Top-level aliases after batch unwrap.
	const top_id = first_defined(target, ["id", "taskId", "todoId", "task_id", "todo_id"]);
	if (target.id === undefined && top_id !== undefined) {
		const coerced = coerce_id(top_id);
		if (coerced !== undefined) target.id = coerced;
	}
	const top_task = first_defined(target, ["task", "taskName", "task_name"]);
	if (target.task === undefined && typeof top_task === "string") {
		target.task = top_task;
	}
	const top_subject = first_defined(target, ["subject", "content", "title", "name", "text", "label"]);
	if (target.subject === undefined && top_subject !== undefined) target.subject = top_subject;

	const raw_status = first_defined(target, ["status", "state", "taskStatus", "task_status"]);
	if (raw_status !== undefined) {
		const normalized = normalize_status(raw_status);
		if (normalized) target.status = normalized;
	} else if (target.status !== undefined) {
		const normalized = normalize_status(target.status);
		if (normalized) target.status = normalized;
	}

	delete target.taskId;
	delete target.todoId;
	delete target.task_id;
	delete target.todo_id;
	if (target.subject !== undefined) {
		delete target.content;
		delete target.title;
		delete target.name;
		delete target.text;
		delete target.label;
	}

	infer_action(target);
	finalize_batch_shape(target);
	coerce_id_lists(target);

	return target as TodoParamsLike;
}

export function is_batch_params(params: TodoParamsLike): boolean {
	return Array.isArray(params.batch) && params.batch.length > 0;
}
