/**
 * Cursor model catalog via GetUsableModels Connect-RPC.
 * Adapted from ephraimduncan/opencode-cursor models.ts (BSD-3-Clause).
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
} from "./proto/agent_pb.js";
import { call_cursor_unary_rpc } from "./transport.js";
import { decode_connect_unary_body } from "./wire.js";
import { CURSOR_GET_USABLE_MODELS_PATH } from "./metadata.js";
import {
	CURSOR_DEFAULT_CONTEXT_WINDOW,
	CURSOR_DEFAULT_MAX_TOKENS,
	CURSOR_REASONING_MODEL_PATTERNS,
} from "../constants.js";

export interface DiscoveredCursorModel {
	id: string;
	name: string;
	reasoning: boolean;
	context_window: number;
	max_tokens: number;
}

const FALLBACK_MODELS: DiscoveredCursorModel[] = [
	{ id: "default", name: "Auto", reasoning: true, context_window: CURSOR_DEFAULT_CONTEXT_WINDOW, max_tokens: CURSOR_DEFAULT_MAX_TOKENS },
	{ id: "composer-2", name: "Composer 2", reasoning: true, context_window: CURSOR_DEFAULT_CONTEXT_WINDOW, max_tokens: CURSOR_DEFAULT_MAX_TOKENS },
	{ id: "claude-4.6-sonnet-medium", name: "Claude 4.6 Sonnet", reasoning: true, context_window: CURSOR_DEFAULT_CONTEXT_WINDOW, max_tokens: CURSOR_DEFAULT_MAX_TOKENS },
	{ id: "gpt-5.4-medium", name: "GPT-5.4", reasoning: true, context_window: 272_000, max_tokens: 128_000 },
];

function model_is_reasoning(model_id: string, thinking_details: unknown): boolean {
	if (thinking_details) return true;
	return CURSOR_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model_id));
}

function decode_get_usable_models_response(payload: Uint8Array) {
	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		const framed = decode_connect_unary_body(payload);
		if (!framed) return null;
		try {
			return fromBinary(GetUsableModelsResponseSchema, framed);
		} catch {
			return null;
		}
	}
}

function normalize_model_entry(entry: unknown): DiscoveredCursorModel | null {
	if (!entry || typeof entry !== "object") return null;
	const record = entry as Record<string, unknown>;
	const id = typeof record.modelId === "string" ? record.modelId.trim() : "";
	if (!id) return null;

	const name_candidates = [
		record.displayName,
		record.displayNameShort,
		record.displayModelId,
		id,
	];
	let name = id;
	for (const candidate of name_candidates) {
		if (typeof candidate === "string" && candidate.trim()) {
			name = candidate.trim();
			break;
		}
	}

	return {
		id,
		name,
		reasoning: model_is_reasoning(id, record.thinkingDetails),
		context_window: CURSOR_DEFAULT_CONTEXT_WINDOW,
		max_tokens: CURSOR_DEFAULT_MAX_TOKENS,
	};
}

let cached_models: DiscoveredCursorModel[] | null = null;

export function clear_cached_cursor_models(): void {
	cached_models = null;
}

export async function discover_cursor_models_cloud(
	access_token: string,
	options: { force?: boolean } = {},
): Promise<DiscoveredCursorModel[]> {
	if (!options.force && cached_models) return cached_models;

	try {
		const request_body = toBinary(
			GetUsableModelsRequestSchema,
			create(GetUsableModelsRequestSchema, {}),
		);
		const response = await call_cursor_unary_rpc({
			access_token,
			rpc_path: CURSOR_GET_USABLE_MODELS_PATH,
			request_body,
		});

		if (response.timed_out || response.exit_code !== 0 || response.body.length === 0) {
			throw new Error("GetUsableModels returned no data");
		}

		const decoded = decode_get_usable_models_response(response.body);
		if (!decoded) throw new Error("Failed to decode GetUsableModels response");

		const models: DiscoveredCursorModel[] = [];
		const seen = new Set<string>();
		for (const entry of decoded.models ?? []) {
			const normalized = normalize_model_entry(entry);
			if (!normalized || seen.has(normalized.id)) continue;
			seen.add(normalized.id);
			models.push(normalized);
		}

		if (models.length === 0) throw new Error("GetUsableModels returned an empty model list");
		cached_models = models.sort((a, b) => a.id.localeCompare(b.id));
		return cached_models;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cursor model discovery failed: ${detail}`);
	}
}

export function get_fallback_cursor_models(): DiscoveredCursorModel[] {
	return [...FALLBACK_MODELS];
}

export const __catalog_test_only = { normalize_model_entry };
