/**
 * SSOT for subagent session checkpoints used by `subagent_resume`.
 *
 * Child sessions are persisted under ~/.pi/agent/subagent-sessions/<parentSessionId>/<originToolCallId>/
 * using Pi's native SessionManager file format. Resume reopens the same session file and
 * calls session.prompt() for true continuation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_DELEGATION_TOOLS } from "../../edit-tools.ts";
import { infer_bare_agent_name } from "../../subagent-policy.ts";
import type { SubAgentResult } from "./runner.ts";

const SUBAGENT_SESSIONS_DIR = "subagent-sessions";
const META_FILE = "meta.json";
const INDEX_FILE = "index.json";

/**
 * Durable cross-process live marker file name written inside each checkpoint
 * dir by `mark_checkpoint_dir_live()`. A foreign Pi process or duplicated
 * module instance observes this file and never prunes a parent containing a
 * fresh marker. Only this exact file name is ever treated as a marker —
 * arbitrary files are never interpreted as live.
 */
export const LIVE_MARKER_FILE = ".live";

/**
 * TTL for a durable live marker. A crashed run's marker must not protect its
 * checkpoint dir forever: once a marker is older than this, it is treated as
 * stale, reaped by `prune_foreign_checkpoints()`, and the parent becomes
 * disposable. The runner refreshes the marker before every `session.prompt()`,
 * so a live run whose individual prompts stay well under this window never
 * goes stale mid-run. Canonical stale-recovery TTL — single source of truth.
 */
export const LIVE_MARKER_TTL_MS = 6 * 60 * 60 * 1000;

const RESUMABLE_TOOL_NAMES = new Set<string>(SUBAGENT_DELEGATION_TOOLS);

export interface ResumeCheckpointMeta {
	parentSessionId: string;
	originToolCallId: string;
	displayName: string;
	agentName: string;
	cwd: string;
	sessionFile: string;
	updatedAt: string;
}

export interface ResumeTarget {
	displayName: string;
	agentName: string;
	cwd: string;
	originToolCallId: string;
	parentSessionId: string;
}

interface ResumeIndexEntry {
	originToolCallId: string;
	agentName: string;
	cwd: string;
	updatedAt: string;
}

type ResumeIndex = Record<string, ResumeIndexEntry>;

interface SubagentDetailsLike {
	mode?: string;
	results?: SubAgentResult[];
}

export type ResolveResumeResult = { ok: true; target: ResumeTarget } | { ok: false; error: string };

/**
 * Checkpoint dirs that a live subagent is currently writing its run-record
 * into. `prune_foreign_checkpoints()` must NEVER remove one of these: the SDK
 * SessionManager creates its `<timestamp>_<childSessionId>.jsonl` lazily on the
 * first assistant write, and a prune in that window would make that write throw
 * ENOENT (the root cause of `ENOENT ... subagent-sessions/...` failing whole
 * runs with any provider). The runner marks a dir live at bootstrap and clears
 * it in finally, so the directory deterministically exists for every SDK open.
 *
 * The Set is the same-process fast path. Liveness is ALSO durable on disk via
 * the `.live` marker written by `mark_checkpoint_dir_live()`, so a foreign Pi
 * process or a duplicated module instance observes the mark and never prunes
 * a live dir even when this process's Set is empty.
 */
const live_checkpoint_dirs = new Set<string>();

function normalize_checkpoint_dir(dir: string): string {
	return path.normalize(dir);
}

/**
 * Content of the durable `.live` marker. Freshness is derived exclusively from
 * `updatedAt` against `LIVE_MARKER_TTL_MS`; pid/start are metadata only and are
 * never used to decide liveness (pid liveness is racy and not cross-platform).
 */
export interface LiveMarkerData {
	version: 1;
	/** PID of the process holding the run (metadata only). */
	pid: number;
	/** Epoch ms when the run first marked the dir. */
	startedAt: number;
	/** Epoch ms of the latest marker write — the freshness source. */
	updatedAt: number;
}

function read_live_marker(marker_path: string): LiveMarkerData | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(marker_path, "utf8")) as Partial<LiveMarkerData>;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof parsed.updatedAt === "number" &&
			Number.isFinite(parsed.updatedAt)
		) {
			return {
				version: 1,
				pid: typeof parsed.pid === "number" ? parsed.pid : 0,
				startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : parsed.updatedAt,
				updatedAt: parsed.updatedAt,
			};
		}
		return undefined;
	} catch {
		// Missing or not parseable as our format. The caller decides conservatively:
		// `live_marker_state` treats an unparseable-but-mtime-fresh marker as live.
		return undefined;
	}
}

/**
 * True when a marker is fresh enough to protect its checkpoint dir from a
 * foreign prune. Canonical staleness check against `LIVE_MARKER_TTL_MS`;
 * `now_ms` is injectable so tests exercise the boundary deterministically.
 */
export function is_live_marker_fresh(marker: LiveMarkerData, now_ms: number = Date.now()): boolean {
	return now_ms - marker.updatedAt < LIVE_MARKER_TTL_MS;
}

/**
 * Synchronously write the durable `.live` marker, preserving the original
 * `startedAt` across refreshes.
 *
 * Direct write, deliberately NO write-then-rename: on Windows/Bun a rename
 * over a destination a foreign prune is concurrently reading can fail with a
 * transient EPERM sharing violation (MoveFileExW REPLACE_EXISTING requires
 * the destination's openers to share delete access), which would spuriously
 * fail the run. A direct small write never hits that, and readers treat
 * unparseable/empty content as LIVE (see `live_marker_state`), so the
 * truncate-then-write window can never let a live dir be pruned.
 */
function write_live_marker(dir: string, now_ms: number): void {
	const marker_path = path.join(dir, LIVE_MARKER_FILE);
	const existing = read_live_marker(marker_path);
	const data: LiveMarkerData = {
		version: 1,
		pid: process.pid,
		startedAt: existing?.startedAt ?? now_ms,
		updatedAt: now_ms,
	};
	fs.writeFileSync(marker_path, `${JSON.stringify(data)}\n`, "utf8");
}

/**
 * Classify a marker file for pruning: "live" (protect), "stale" (reap), or
 * "none" (not a marker / vanished). Parseable markers use `updatedAt`. An
 * unparseable/empty marker (a writer's truncate window or a crashed write) is
 * conservatively treated as LIVE while its mtime is fresh — a live dir is
 * never pruned — and reaped once the mtime goes stale, so crashed markers do
 * not leak forever.
 */
function live_marker_state(marker_path: string, now_ms: number): "live" | "stale" | "none" {
	const marker = read_live_marker(marker_path);
	if (marker) return is_live_marker_fresh(marker, now_ms) ? "live" : "stale";
	let mtime: number;
	try {
		mtime = fs.statSync(marker_path).mtimeMs;
	} catch {
		// Marker vanished between the parent scan and this stat.
		return "none";
	}
	return now_ms - mtime < LIVE_MARKER_TTL_MS ? "live" : "stale";
}

/**
 * Mark a checkpoint dir as being written by an in-flight subagent run.
 *
 * Synchronously (no async boundary) ensures the dir exists and writes the
 * durable `.live` marker, so a foreign process's prune observes the run before
 * the runner's first await. Re-calling refreshes `updatedAt` — the runner
 * refreshes before every prompt so long runs never let the cross-process guard
 * go stale.
 */
export function mark_checkpoint_dir_live(dir: string): void {
	const normalized = normalize_checkpoint_dir(dir);
	// fs work first: if mkdir or the marker write throws, no in-memory Set entry
	// is left behind. The durable marker is the cross-process guard; the Set is
	// only the same-process fast path and is populated once the disk state is
	// consistent.
	fs.mkdirSync(normalized, { recursive: true });
	write_live_marker(normalized, Date.now());
	live_checkpoint_dirs.add(normalized);
}

/**
 * Drop the live mark once a subagent run finishes (success, error, or abort):
 * clears the same-process Set entry AND removes the durable marker so the dir
 * is disposable again. Call only AFTER checkpoint persistence has completed
 * (the runner's `finally` persists meta.json/index.json before unmarking) so a
 * foreign prune can never observe an unprotected incomplete checkpoint.
 */
export function unmark_checkpoint_dir_live(dir: string): void {
	const normalized = normalize_checkpoint_dir(dir);
	live_checkpoint_dirs.delete(normalized);
	try {
		fs.rmSync(path.join(normalized, LIVE_MARKER_FILE), { force: true });
	} catch {
		// A concurrent prune may already have removed the whole dir.
	}
}

function dir_contains_live_checkpoint(parent_dir: string): boolean {
	const prefix = `${normalize_checkpoint_dir(parent_dir)}${path.sep}`;
	for (const live of live_checkpoint_dirs) {
		if (live === normalize_checkpoint_dir(parent_dir) || live.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * True when any checkpoint dir under `parent_dir` is live: either a
 * same-process Set entry (fast path) or a FRESH durable `.live` marker written
 * by ANY Pi process/instance. Stale markers are reaped so a crashed run's
 * marker cannot protect its parent forever. Only `.live` markers (parseable,
 * or unparseable-but-mtime-fresh via `live_marker_state`) are ever held or
 * reaped — arbitrary files are never treated as live.
 */
function parent_has_live_checkpoint(parent_dir: string, now_ms: number): boolean {
	if (dir_contains_live_checkpoint(parent_dir)) return true;
	let children: fs.Dirent[];
	try {
		children = fs.readdirSync(parent_dir, { withFileTypes: true });
	} catch {
		// Parent vanished between the root scan and this readdir — nothing left
		// to protect.
		return false;
	}
	let has_fresh_marker = false;
	for (const child of children) {
		if (!child.isDirectory()) continue;
		const marker_path = path.join(parent_dir, child.name, LIVE_MARKER_FILE);
		const state = live_marker_state(marker_path, now_ms);
		if (state === "live") {
			has_fresh_marker = true;
		} else if (state === "stale") {
			// Stale crashed-run marker: reap it so it cannot protect forever.
			try {
				fs.rmSync(marker_path, { force: true });
			} catch {
				/* best-effort reap; pruning removes it with the parent anyway */
			}
		}
	}
	return has_fresh_marker;
}

let subagent_sessions_root_override: string | undefined;

/**
 * Test/embedding seam: redirect the sessions store root away from the real
 * ~/.pi/agent. Pass undefined to restore the default. Runtime paths never set
 * this; it keeps regression tests hermetic (no writes into ~/.pi/agent).
 */
export function set_subagent_sessions_root_override(root: string | undefined): void {
	subagent_sessions_root_override = root;
}

export function get_subagent_sessions_root(): string {
	if (subagent_sessions_root_override) return subagent_sessions_root_override;
	return path.join(getAgentDir(), SUBAGENT_SESSIONS_DIR);
}

/** Windows and POSIX both reject `|`, `/`, `\`, etc. in directory names. */
const INVALID_CHECKPOINT_SEGMENT = /[/\\:*?"<>|\x00-\x1f]/g;

export function filesystem_safe_tool_call_id(toolCallId: string): string {
	return toolCallId.replace(INVALID_CHECKPOINT_SEGMENT, "_");
}

export function get_checkpoint_dir(parentSessionId: string, originToolCallId: string): string {
	return path.join(
		get_subagent_sessions_root(),
		parentSessionId,
		filesystem_safe_tool_call_id(originToolCallId),
	);
}

/**
 * Deterministic directory bootstrap for every open/write/append under
 * subagent-sessions. `fs.mkdirSync(..., { recursive: true })` is atomic and
 * idempotent, so parallel child sessions writing into the same parent dir are
 * safe and no existsSync pre-check or prior async op is ever required for
 * correctness. Call this immediately before recording / checkpoint / resume
 * writes; the returned path is guaranteed to exist.
 */
export function subagent_sessions_dir_for(
	parentSessionId: string,
	originToolCallId: string,
	root: string = get_subagent_sessions_root(),
): string {
	const dir = path.join(root, parentSessionId, filesystem_safe_tool_call_id(originToolCallId));
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function checkpoint_meta_path(parentSessionId: string, originToolCallId: string): string {
	const primary = path.join(get_checkpoint_dir(parentSessionId, originToolCallId), META_FILE);
	if (fs.existsSync(primary)) return primary;
	const legacy = path.join(
		get_subagent_sessions_root(),
		parentSessionId,
		originToolCallId,
		META_FILE,
	);
	if (legacy !== primary && fs.existsSync(legacy)) return legacy;
	return primary;
}

function read_json_file<T>(file_path: string): T | undefined {
	try {
		if (!fs.existsSync(file_path)) return undefined;
		return JSON.parse(fs.readFileSync(file_path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function write_json_file(file_path: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file_path), { recursive: true });
	fs.writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function read_resume_index(parentSessionId: string): ResumeIndex {
	return (
		read_json_file<ResumeIndex>(
			path.join(get_subagent_sessions_root(), parentSessionId, INDEX_FILE),
		) ?? {}
	);
}

function write_resume_index(parentSessionId: string, index: ResumeIndex): void {
	write_json_file(path.join(get_subagent_sessions_root(), parentSessionId, INDEX_FILE), index);
}

export function read_resume_meta(
	parentSessionId: string,
	originToolCallId: string,
): ResumeCheckpointMeta | undefined {
	return read_json_file<ResumeCheckpointMeta>(
		checkpoint_meta_path(parentSessionId, originToolCallId),
	);
}

export function persist_checkpoint_meta(meta: ResumeCheckpointMeta): void {
	const dir = subagent_sessions_dir_for(meta.parentSessionId, meta.originToolCallId);
	// Do not persist a checkpoint whose session file has already disappeared.
	if (meta.sessionFile && !fs.existsSync(meta.sessionFile)) return;
	write_json_file(path.join(dir, META_FILE), meta);

	const index = read_resume_index(meta.parentSessionId);
	index[meta.displayName] = {
		originToolCallId: meta.originToolCallId,
		agentName: meta.agentName,
		cwd: meta.cwd,
		updatedAt: meta.updatedAt,
	};
	write_resume_index(meta.parentSessionId, index);
}

export function open_checkpoint_meta(
	parentSessionId: string,
	displayName: string,
): ResumeCheckpointMeta | undefined {
	const normalized = normalize_display_name(displayName);
	const index = read_resume_index(parentSessionId);
	const entry = index[normalized];
	if (entry) {
		const meta = read_resume_meta(parentSessionId, entry.originToolCallId);
		if (meta?.sessionFile && fs.existsSync(meta.sessionFile)) return meta;
	}

	for (const [letter, indexed] of Object.entries(index)) {
		if (normalize_display_name(letter) !== normalized) continue;
		const meta = read_resume_meta(parentSessionId, indexed.originToolCallId);
		if (meta?.sessionFile && fs.existsSync(meta.sessionFile)) return meta;
	}
	return undefined;
}

function normalize_display_name(name: string): string {
	return name.trim();
}

function is_tool_result_entry(entry: {
	type?: string;
	message?: { role?: string; toolName?: string };
}): entry is {
	type: "message";
	message: { role: "toolResult"; toolName?: string; toolCallId?: string; details?: unknown };
} {
	return entry.type === "message" && entry.message?.role === "toolResult";
}

function parse_subagent_details(details: unknown): SubagentDetailsLike | undefined {
	if (!details || typeof details !== "object") return undefined;
	return details as SubagentDetailsLike;
}

function find_origin_from_branch(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	displayName: string,
): { originToolCallId: string; agentName: string; cwd?: string; mode: string } | undefined {
	const normalized = normalize_display_name(displayName);
	const assistant_args = new Map<string, { agent?: string; cwd?: string }>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!msg) continue;
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content as Array<{
				type?: string;
				id?: string;
				name?: string;
				arguments?: unknown;
			}>) {
				if (part.type !== "toolCall" || !part.id || !RESUMABLE_TOOL_NAMES.has(part.name ?? ""))
					continue;
				const args = (part.arguments ?? {}) as { agent?: string; cwd?: string };
				assistant_args.set(part.id, args);
			}
		}
	}

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!is_tool_result_entry(entry)) continue;
		const msg = entry.message as {
			toolName?: string;
			toolCallId?: string;
			details?: unknown;
		};
		if (!msg.toolName || !RESUMABLE_TOOL_NAMES.has(msg.toolName)) continue;
		const details = parse_subagent_details(msg.details);
		if (details?.mode !== "single") continue;
		const result = details.results?.[0];
		if (!result) continue;
		if (normalize_display_name(result.agent) !== normalized) continue;
		if (result.exitCode === -1) continue;

		const tool_call_id = msg.toolCallId;
		if (!tool_call_id) continue;

		const call_args = assistant_args.get(tool_call_id);
		const bare_agent = call_args?.agent?.trim() || infer_bare_agent_name(normalized);
		return {
			originToolCallId: find_origin_tool_call_id(branch, normalized) ?? tool_call_id,
			agentName: bare_agent,
			cwd: call_args?.cwd,
			mode: details.mode,
		};
	}
	return undefined;
}

function find_origin_tool_call_id(
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
	displayName: string,
): string | undefined {
	const normalized = normalize_display_name(displayName);
	for (const entry of branch) {
		if (!is_tool_result_entry(entry)) continue;
		const msg = entry.message as { toolName?: string; toolCallId?: string; details?: unknown };
		if (msg.toolName !== "subagent") continue;
		const details = parse_subagent_details(msg.details);
		if (details?.mode !== "single") continue;
		const result = details.results?.[0];
		if (!result) continue;
		if (normalize_display_name(result.agent) !== normalized) continue;
		if (result.exitCode === -1) continue;
		return msg.toolCallId;
	}
	return undefined;
}

export function resolve_resume_target(
	ctx: ExtensionContext,
	displayName: string,
): ResolveResumeResult {
	const normalized = normalize_display_name(displayName);
	if (!normalized) {
		return { ok: false, error: "Resume target agent name is required." };
	}

	const parentSessionId = ctx.sessionManager.getSessionId();
	const from_disk = open_checkpoint_meta(parentSessionId, normalized);
	if (from_disk) {
		return {
			ok: true,
			target: {
				displayName: from_disk.displayName,
				agentName: from_disk.agentName,
				cwd: from_disk.cwd,
				originToolCallId: from_disk.originToolCallId,
				parentSessionId,
			},
		};
	}

	const branch = ctx.sessionManager.getBranch() ?? [];
	const from_branch = find_origin_from_branch(branch, normalized);
	if (!from_branch) {
		return {
			ok: false,
			error: `No prior subagent run found for "${normalized}". Spawn with subagent first.`,
		};
	}
	if (from_branch.mode !== "single") {
		return {
			ok: false,
			error: `Resume is not supported for parallel or chain subagent batches ("${normalized}").`,
		};
	}

	const meta = read_resume_meta(parentSessionId, from_branch.originToolCallId);
	if (!meta?.sessionFile || !fs.existsSync(meta.sessionFile)) {
		return {
			ok: false,
			error: `No saved session for "${normalized}". The prior run may predate resume support or was not persisted.`,
		};
	}

	return {
		ok: true,
		target: {
			displayName: normalized,
			agentName: meta.agentName || from_branch.agentName,
			cwd: meta.cwd || from_branch.cwd || ctx.cwd,
			originToolCallId: from_branch.originToolCallId,
			parentSessionId,
		},
	};
}

export function prune_foreign_checkpoints(activeParentSessionId: string): void {
	const root = get_subagent_sessions_root();
	if (!fs.existsSync(root)) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// Root removed between existsSync and readdir (TOCTOU) — nothing to prune.
		return;
	}
	const now_ms = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === activeParentSessionId) continue;
		const parent_dir = path.join(root, entry.name);
		// Never delete a parent a live subagent is still writing into (the SDK's
		// run-record openSync would then ENOENT and fail the whole run). The
		// guard is durable: a FRESH `.live` marker protects across processes even
		// when this process's in-memory Set is empty. Stale markers are reaped by
		// `parent_has_live_checkpoint`, so crashed runs never protect their dirs
		// forever.
		if (parent_has_live_checkpoint(parent_dir, now_ms)) continue;
		fs.rmSync(parent_dir, { recursive: true, force: true });
	}
}
