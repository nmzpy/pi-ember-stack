/**
 * Connect-RPC streaming envelope helpers for Cursor's api2.cursor.sh API.
 * Adapted from opencode-cursor (BSD-3-Clause) and pi-devin-auth cloud-direct.
 */

/** Connect end-of-stream flag (trailer frame). */
export const CONNECT_END_STREAM_FLAG = 0b00000010;

/** Length-prefix a bridge message: [4-byte BE length][payload]. */
export function lp_encode(data: Uint8Array): Buffer {
	const buf = Buffer.alloc(4 + data.length);
	buf.writeUInt32BE(data.length, 0);
	buf.set(data, 4);
	return buf;
}

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload]. */
export function frame_connect_message(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

export interface ConnectFrame {
	flags: number;
	payload: Buffer;
	eos: boolean;
}

/** Parse all complete Connect frames from a buffer. */
export function parse_connect_frames(buf: Buffer): ConnectFrame[] {
	const out: ConnectFrame[] = [];
	let i = 0;
	while (i + 5 <= buf.length) {
		const flags = buf[i];
		const len = buf.readUInt32BE(i + 1);
		if (i + 5 + len > buf.length) break;
		const payload = buf.slice(i + 5, i + 5 + len);
		out.push({ flags, payload, eos: (flags & CONNECT_END_STREAM_FLAG) !== 0 });
		i += 5 + len;
	}
	return out;
}

/** Extract the first non-trailer Connect frame body from a unary response. */
export function decode_connect_unary_body(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) return null;

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset]!;
		const message_length = Buffer.from(payload).readUInt32BE(offset + 1);
		const frame_end = offset + 5 + message_length;
		if (frame_end > payload.length) return null;

		if ((flags & 0b0000_0001) !== 0) return null;
		if ((flags & CONNECT_END_STREAM_FLAG) === 0) {
			return payload.subarray(offset + 5, frame_end);
		}

		offset = frame_end;
	}

	return null;
}

const GENERIC_CONNECT_MESSAGES = new Set(["", "error", "unknown error", "unknown"]);

export interface ConnectTrailerError {
	code: string;
	message: string;
	details: string[];
	raw: string;
	display_message: string;
}

function format_aiserver_error_details(record: Record<string, unknown>): string | null {
	const type = record["@type"] ?? record.type;
	if (typeof type !== "string" || !type.includes("ErrorDetails")) return null;

	const debug = record.debug;
	if (!debug || typeof debug !== "object") return null;

	const nested = (debug as Record<string, unknown>).details;
	if (!nested || typeof nested !== "object") return null;

	const title = (nested as Record<string, unknown>).title;
	const detail = (nested as Record<string, unknown>).detail;
	if (typeof title === "string" && title.trim()) {
		const detail_text = typeof detail === "string" ? detail.trim() : "";
		return detail_text ? `${title.trim()}: ${detail_text}` : title.trim();
	}
	if (typeof detail === "string" && detail.trim()) return detail.trim();
	return null;
}

function parse_embedded_aiserver_error(message: string): string | null {
	const trimmed = message.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		return format_aiserver_error_details(parsed);
	} catch {
		return null;
	}
}

function format_connect_detail(detail: unknown): string {
	if (detail == null) return "";
	if (typeof detail !== "object") return String(detail);

	const record = detail as Record<string, unknown>;
	const aiserver = format_aiserver_error_details(record);
	if (aiserver) return aiserver;

	const type = record["@type"] ?? record.type;
	const type_text = typeof type === "string" ? type : "";

	if (type_text.includes("ErrorInfo")) {
		const reason = record.reason ?? record.Reason;
		const domain = record.domain ?? record.Domain;
		const metadata = record.metadata ?? record.Metadata;
		const parts = [reason, domain].filter((part) => typeof part === "string" && part.length > 0);
		if (metadata && typeof metadata === "object") {
			parts.push(JSON.stringify(metadata));
		}
		if (parts.length > 0) return parts.join(" · ");
	}

	if (typeof record.message === "string" && record.message.trim()) {
		const locale = record.locale ?? record.Locale;
		return locale ? `${record.message} (${locale})` : record.message;
	}

	try {
		return JSON.stringify(record);
	} catch {
		return String(detail);
	}
}

function connect_code_name(code: unknown): string {
	if (typeof code === "string" && code.trim()) return code.trim();
	if (typeof code === "number") {
		const names = [
			"ok",
			"cancelled",
			"unknown",
			"invalid_argument",
			"deadline_exceeded",
			"not_found",
			"already_exists",
			"permission_denied",
			"resource_exhausted",
			"failed_precondition",
			"aborted",
			"out_of_range",
			"unimplemented",
			"internal",
			"unavailable",
			"data_loss",
			"unauthenticated",
		];
		return names[code] ?? String(code);
	}
	return "unknown";
}

function dedupe_display_parts(parts: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function build_connect_display_message(
	code: string,
	message: string,
	details: string[],
	raw: string,
): string {
	const parts: string[] = [];
	const embedded = parse_embedded_aiserver_error(message);
	if (embedded) parts.push(embedded);

	const generic = GENERIC_CONNECT_MESSAGES.has(message.trim().toLowerCase());
	if (!embedded && !generic && message.trim() && !message.trim().startsWith("{")) {
		parts.push(message.trim());
	}
	parts.push(...details);

	const deduped = dedupe_display_parts(parts);
	if (deduped.length > 0) return deduped.join(" — ");

	return `Connect error ${code}`;
}

/** True when Cursor reports missing conversation blobs — safe to reset and retry once. */
export function is_conversation_recovery_error(text: string): boolean {
	const lower = text.toLowerCase();
	return lower.includes("missing blob") || lower.includes("conversation data missing");
}

/** Parse a Connect end-stream trailer into a user-facing error. */
export function parse_connect_trailer_error(data: Uint8Array): ConnectTrailerError | null {
	const raw = new TextDecoder().decode(data).trim();
	if (!raw) return null;

	try {
		const payload = JSON.parse(raw) as Record<string, unknown>;
		const nested_error = payload.error as Record<string, unknown> | undefined;
		const status_error =
			!nested_error && typeof payload.code !== "undefined"
				? {
						code: payload.code,
						message: payload.message,
						details: payload.details,
					}
				: undefined;
		const error = nested_error ?? status_error;
		if (!error) return null;

		const code = connect_code_name(error.code);
		const message = typeof error.message === "string" ? error.message : "";
		const details: string[] = [];
		if (Array.isArray(error.details)) {
			for (const detail of error.details) {
				const formatted = format_connect_detail(detail);
				if (formatted) details.push(formatted);
			}
		}

		return {
			code,
			message,
			details,
			raw,
			display_message: build_connect_display_message(code, message, details, raw),
		};
	} catch {
		return {
			code: "parse_error",
			message: "Non-JSON Connect trailer",
			details: [],
			raw,
			display_message: build_connect_display_message("parse_error", "", [], raw),
		};
	}
}

export function format_bridge_stderr(stderr: string): string | undefined {
	const trimmed = stderr.trim();
	if (!trimmed) return undefined;

	const parts: string[] = [];
	for (const line of trimmed.split("\n")) {
		const text = line.trim();
		if (!text) continue;
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed.kind === "grpc_trailers") {
				const status = parsed.grpcStatus ?? parsed.grpc_status;
				const message = parsed.grpcMessage ?? parsed.grpc_message;
				parts.push(`gRPC ${status}: ${message ?? ""}`.trim());
				continue;
			}
			if (parsed.kind === "http_status") {
				parts.push(`HTTP ${parsed.status ?? "error"}`);
				continue;
			}
			if (typeof parsed.message === "string" && parsed.message.trim()) {
				parts.push(parsed.message.trim());
				continue;
			}
			parts.push(text.slice(0, 240));
		} catch {
			parts.push(text.slice(0, 240));
		}
	}

	return parts.length > 0 ? parts.join("; ") : undefined;
}
