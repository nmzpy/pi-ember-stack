/**
 * Blob store key helpers — SSOT for hex id encoding used by request build and KV lookup.
 */
import { createHash } from "node:crypto";

/** Normalize a protobuf blob id (raw digest or hex-ascii bytes) to the store map key. */
export function blob_id_to_store_key(blob_id: Uint8Array): string {
	if (blob_id.length === 32) {
		return Buffer.from(blob_id).toString("hex");
	}
	const ascii = new TextDecoder().decode(blob_id);
	if (/^[0-9a-f]{12,64}$/i.test(ascii)) {
		return ascii.toLowerCase();
	}
	return Buffer.from(blob_id).toString("hex");
}

/** True when `bytes` is a Cursor KV blob id (sha256 digest or hex-ascii id). */
export function bytes_look_like_blob_id(bytes: Uint8Array): boolean {
	if (bytes.length === 32) return true;
	if (bytes.length < 12 || bytes.length > 64) return false;
	return /^[0-9a-f]{12,64}$/i.test(new TextDecoder().decode(bytes));
}

export function store_blob(
	blob_store: Map<string, Uint8Array>,
	blob_id: Uint8Array,
	data: Uint8Array,
): void {
	blob_store.set(blob_id_to_store_key(blob_id), data);
}

/** Hash content, store under the sha256 hex key, and return the 32-byte blob id. */
export function store_cursor_blob(
	blob_store: Map<string, Uint8Array>,
	data: Uint8Array,
): Uint8Array {
	const blob_id = new Uint8Array(createHash("sha256").update(data).digest());
	store_blob(blob_store, blob_id, data);
	return blob_id;
}

export function lookup_blob(
	blob_store: Map<string, Uint8Array>,
	blob_id: Uint8Array,
): Uint8Array | undefined {
	const key = blob_id_to_store_key(blob_id);
	const direct = blob_store.get(key);
	if (direct) return direct;

	// Some Cursor servers request blobs using the raw digest bytes as the key.
	if (blob_id.length === 32) {
		const raw_hex = Buffer.from(blob_id).toString("hex");
		if (raw_hex !== key) {
			const via_raw = blob_store.get(raw_hex);
			if (via_raw) return via_raw;
		}
	}

	// Error messages show truncated 12-char hex ids; match a unique full store key.
	if (/^[0-9a-f]{12}$/i.test(key)) {
		const prefix = key.toLowerCase();
		let match: Uint8Array | undefined;
		let match_count = 0;
		for (const [store_key, data] of blob_store) {
			if (!store_key.toLowerCase().startsWith(prefix)) continue;
			match = data;
			match_count++;
			if (match_count > 1) return undefined;
		}
		if (match_count === 1) return match;
	}

	return undefined;
}

/** Fail fast when a Run request references blobs that are not populated locally. */
export function assert_conversation_blobs_present(
	root_prompt_blob_ids: readonly Uint8Array[],
	blob_store: Map<string, Uint8Array>,
): void {
	for (const blob_id of root_prompt_blob_ids) {
		const key = blob_id_to_store_key(blob_id);
		if (!blob_store.has(key)) {
			throw new Error(
				`Cursor blob store missing root prompt blob ${key.slice(0, 12)} before Run`,
			);
		}
	}
}
