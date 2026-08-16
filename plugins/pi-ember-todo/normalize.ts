/**
 * Minimal argument normalization for the todo tool.
 */

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

const STATUS_ALIASES: Record<string, TaskStatus> = {
	pending: "pending",
	todo: "pending",
	open: "pending",
	in_progress: "in_progress",
	inprogress: "in_progress",
	"in-progress": "in_progress",
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

export type TodoParamsLike = {
	action?: string;
	id?: number;
	task?: string;
	subject?: string;
	status?: TaskStatus;
	includeDeleted?: boolean;
};

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
	if (typeof value === "number" && Number.isInteger(value)) return NUMERIC_STATUS[value];
	if (typeof value !== "string") return undefined;
	const key = value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return STATUS_ALIASES[key];
}

function infer_action(target: Record<string, unknown>): void {
	if (typeof target.action === "string" && target.action.trim()) return;
	if (target.subject !== undefined) target.action = "create";
	else if (target.id !== undefined || target.task !== undefined) target.action = "update";
	else target.action = "list";
}

/** Normalize raw model/provider args into a tiny validated shape. */
export function prepare_todo_arguments(args: unknown): TodoParamsLike {
	const target: Record<string, unknown> = { ...((args ?? {}) as Record<string, unknown>) };

	// Unwrap a single nested status object (e.g. { data: { status } }).
	const nested = target.data;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		if (target.status === undefined) target.status = (nested as Record<string, unknown>).status;
		delete target.data;
	}

	const top_id = target.id ?? target.taskId ?? target.todoId ?? target.task_id ?? target.todo_id;
	if (target.id === undefined) {
		const coerced = coerce_id(top_id);
		if (coerced !== undefined) target.id = coerced;
	}
	if (
		target.task === undefined &&
		typeof target.task === "undefined" &&
		typeof top_id === "string"
	) {
		// task is already a string target.
	}
	if (target.task === undefined && typeof target.task === "string") {
		// leave
	}

	const raw_status = target.status ?? target.state ?? target.taskStatus ?? target.task_status;
	if (raw_status !== undefined) {
		const normalized = normalize_status(raw_status);
		if (normalized) target.status = normalized;
	}

	if (target.includeDeleted === true || target.includeDeleted === "true") {
		target.includeDeleted = true;
	} else if (target.includeDeleted !== undefined) {
		target.includeDeleted = false;
	}

	delete target.taskId;
	delete target.todoId;
	delete target.task_id;
	delete target.todo_id;
	delete target.state;
	delete target.taskStatus;
	delete target.task_status;

	infer_action(target);

	return target as TodoParamsLike;
}
