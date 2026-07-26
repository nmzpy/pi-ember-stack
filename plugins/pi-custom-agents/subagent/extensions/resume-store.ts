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
import { infer_bare_agent_name } from "../../subagent-policy.ts";
import { SUBAGENT_DELEGATION_TOOLS } from "../../edit-tools.ts";
import type { SubAgentResult } from "./runner.ts";

const SUBAGENT_SESSIONS_DIR = "subagent-sessions";
const META_FILE = "meta.json";
const INDEX_FILE = "index.json";

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

export type ResolveResumeResult =
	| { ok: true; target: ResumeTarget }
	| { ok: false; error: string };

export function get_subagent_sessions_root(): string {
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

function checkpoint_meta_path(parentSessionId: string, originToolCallId: string): string {
	const primary = path.join(get_checkpoint_dir(parentSessionId, originToolCallId), META_FILE);
	if (fs.existsSync(primary)) return primary;
	const legacy = path.join(get_subagent_sessions_root(), parentSessionId, originToolCallId, META_FILE);
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
	return read_json_file<ResumeIndex>(path.join(get_subagent_sessions_root(), parentSessionId, INDEX_FILE)) ?? {};
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
	const dir = get_checkpoint_dir(meta.parentSessionId, meta.originToolCallId);
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

function is_tool_result_entry(
	entry: { type?: string; message?: { role?: string; toolName?: string } },
): entry is { type: "message"; message: { role: "toolResult"; toolName?: string; toolCallId?: string; details?: unknown } } {
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
			for (const part of msg.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
				if (part.type !== "toolCall" || !part.id || !RESUMABLE_TOOL_NAMES.has(part.name ?? "")) continue;
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
		if (!details || details.mode !== "single") continue;
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
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === activeParentSessionId) continue;
		fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
	}
}
