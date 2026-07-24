/**
 * Blob store key helpers — SSOT for hex id encoding used by request build and KV lookup.
 */

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

export function store_blob(
	blob_store: Map<string, Uint8Array>,
	blob_id: Uint8Array,
	data: Uint8Array,
): void {
	blob_store.set(blob_id_to_store_key(blob_id), data);
}

export function lookup_blob(
	blob_store: Map<string, Uint8Array>,
	blob_id: Uint8Array,
): Uint8Array | undefined {
	return blob_store.get(blob_id_to_store_key(blob_id));
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
