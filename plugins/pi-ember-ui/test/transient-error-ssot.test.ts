import { describe, expect, test } from "bun:test";
import { is_transient_provider_error } from "../error-utils.ts";

describe("is_transient_provider_error SSOT", () => {
	test("matches Vertex / Gemini 429 resource exhausted JSON payload", () => {
		const vertexPayload = JSON.stringify({
			error: {
				code: 429,
				message:
					'{\n  "error": {\n    "code": 429,\n    "message": "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}',
				status: "Too Many Requests",
			},
		});
		expect(is_transient_provider_error(vertexPayload)).toBe(true);
	});

	test("matches standard transient HTTP codes and provider keywords", () => {
		expect(is_transient_provider_error("Error 429: Too Many Requests")).toBe(true);
		expect(is_transient_provider_error("503 Service Unavailable")).toBe(true);
		expect(is_transient_provider_error("HTTP 502 Bad Gateway")).toBe(true);
		expect(is_transient_provider_error("504 Gateway Timeout")).toBe(true);
		expect(is_transient_provider_error("Rate limit reached. Please try again later.")).toBe(true);
		expect(is_transient_provider_error("Quota exceeded for quota metric")).toBe(true);
		expect(is_transient_provider_error("Model is temporarily overloaded")).toBe(true);
	});

	test("rejects non-transient, actionable, client, or empty errors", () => {
		expect(is_transient_provider_error(undefined)).toBe(false);
		expect(is_transient_provider_error("")).toBe(false);
		expect(is_transient_provider_error("401 Unauthorized: Invalid API key")).toBe(false);
		expect(is_transient_provider_error("403 Forbidden: Permission denied")).toBe(false);
		expect(is_transient_provider_error("Model not found: gpt-fake")).toBe(false);
		expect(is_transient_provider_error("SyntaxError: Unexpected token")).toBe(false);
	});
});
