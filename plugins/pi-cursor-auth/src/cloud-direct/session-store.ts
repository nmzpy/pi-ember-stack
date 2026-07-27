/**
 * Disk persistence for Cursor conversation checkpoints + blob store.
 * SSOT path: ~/.pi/agent/cursor-sessions/<session_key>/
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CursorConversationState } from "./session.js";

const CURSOR_SESSIONS_DIR = "cursor-sessions";
const META_FILE = "meta.json";
const CHECKPOINT_FILE = "checkpoint.bin";
const BLOBS_DIR = "blobs";

let sessions_root_override: string | undefined;

/** Test seam: redirect persistence away from the real agent dir. */
export function __session_store_test_only_set_root(root: string | undefined): void {
	sessions_root_override = root;
}

const INVALID_SESSION_KEY_SEGMENT = /[/\\:*?"<>|\x00-\x1f]/g;

type PersistedMeta = {
	readonly conversation_id: string;
};

export function get_cursor_sessions_root(): string {
	if (sessions_root_override) return sessions_root_override;
	return path.join(getAgentDir(), CURSOR_SESSIONS_DIR);
}

export function filesystem_safe_session_key(session_key: string): string {
	const trimmed = session_key.trim() || "default";
	return trimmed.replace(INVALID_SESSION_KEY_SEGMENT, "_");
}

function session_dir(session_key: string): string {
	return path.join(get_cursor_sessions_root(), filesystem_safe_session_key(session_key));
}

function blobs_dir(session_key: string): string {
	return path.join(session_dir(session_key), BLOBS_DIR);
}

export function load_persisted_session(session_key: string): CursorConversationState | null {
	const dir = session_dir(session_key);
	const meta_path = path.join(dir, META_FILE);
	if (!fs.existsSync(meta_path)) return null;

	try {
		const meta = JSON.parse(fs.readFileSync(meta_path, "utf-8")) as PersistedMeta;
		if (typeof meta.conversation_id !== "string" || !meta.conversation_id) return null;

		let checkpoint: Uint8Array | null = null;
		const checkpoint_path = path.join(dir, CHECKPOINT_FILE);
		if (fs.existsSync(checkpoint_path)) {
			checkpoint = new Uint8Array(fs.readFileSync(checkpoint_path));
		}

		const blob_store = new Map<string, Uint8Array>();
		const blob_root = blobs_dir(session_key);
		if (fs.existsSync(blob_root)) {
			for (const name of fs.readdirSync(blob_root)) {
				if (!name || name.startsWith(".")) continue;
				const blob_path = path.join(blob_root, name);
				if (!fs.statSync(blob_path).isFile()) continue;
				blob_store.set(name.toLowerCase(), new Uint8Array(fs.readFileSync(blob_path)));
			}
		}

		return {
			conversation_id: meta.conversation_id,
			checkpoint,
			blob_store,
		};
	} catch {
		return null;
	}
}

export function save_persisted_session(session_key: string, state: CursorConversationState): void {
	const dir = session_dir(session_key);
	fs.mkdirSync(dir, { recursive: true });

	const meta: PersistedMeta = { conversation_id: state.conversation_id };
	fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), "utf-8");

	if (state.checkpoint && state.checkpoint.length > 0) {
		fs.writeFileSync(path.join(dir, CHECKPOINT_FILE), state.checkpoint);
	} else if (fs.existsSync(path.join(dir, CHECKPOINT_FILE))) {
		fs.rmSync(path.join(dir, CHECKPOINT_FILE), { force: true });
	}

	const blob_root = blobs_dir(session_key);
	fs.mkdirSync(blob_root, { recursive: true });
	for (const [key, data] of state.blob_store) {
		fs.writeFileSync(path.join(blob_root, key.toLowerCase()), data);
	}
}

export function clear_persisted_session(session_key: string): void {
	fs.rmSync(session_dir(session_key), { recursive: true, force: true });
}

export function clear_all_persisted_sessions(): void {
	fs.rmSync(get_cursor_sessions_root(), { recursive: true, force: true });
}
