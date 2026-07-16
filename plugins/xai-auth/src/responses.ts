import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "node:crypto";
import {
	isGrokCliProxyModel,
	xaiBaseUrlForModel,
	xaiModelForRequest,
	xaiModelRequestHeaders,
	xaiResponsesUrlForModel,
} from "./models.js";
import { rewriteXaiResponsesPayload } from "./payload.js";

type StreamEvent = Record<string, unknown>;
type StreamResult = Record<string, unknown> | undefined;

const streamSimpleOpenAIResponses = openAIResponsesApi().streamSimple;

function resultFromStreamEvent(event: StreamEvent): StreamResult {
	if (event.type === "done") return event.message as StreamResult;
	if (event.type === "error") return event.error as StreamResult;
	return undefined;
}

function createForwardingAssistantStream() {
	const queue: StreamEvent[] = [];
	const waiting: Array<(result: IteratorResult<StreamEvent>) => void> = [];
	let done = false;
	let resolveResult: (result: StreamResult) => void = () => {};
	const resultPromise = new Promise<StreamResult>((resolve) => {
		resolveResult = resolve;
	});

	function finish(result: StreamResult): void {
		if (done) return;
		done = true;
		resolveResult(result);
	}

	return {
		push(event: StreamEvent): void {
			const finalResult = resultFromStreamEvent(event);
			const isTerminal = event.type === "done" || event.type === "error";
			if (isTerminal) finish(finalResult);
			if (done && !isTerminal) return;
			const waiter = waiting.shift();
			if (waiter) {
				waiter({ value: event, done: false });
			} else {
				queue.push(event);
			}
		},
		end(result?: StreamResult): void {
			finish(result);
			while (waiting.length > 0) {
				waiting.shift()?.({ value: undefined as unknown as StreamEvent, done: true });
			}
		},
		result(): Promise<StreamResult> {
			return resultPromise;
		},
		async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
			while (true) {
				if (queue.length > 0) {
					yield queue.shift() as StreamEvent;
				} else if (done) {
					return;
				} else {
					const result = await new Promise<IteratorResult<StreamEvent>>((resolve) =>
						waiting.push(resolve),
					);
					if (result.done) return;
					yield result.value;
				}
			}
		},
	};
}

function streamErrorMessage(model: Model<Api>, error: unknown): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** POST a JSON body to an xAI endpoint with OAuth bearer auth. */
export async function postXaiJson(
	apiKey: string,
	url: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
	headers: Record<string, string> = {},
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...headers,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		const error = new Error(errorText);
		(error as { status?: number }).status = response.status;
		throw error;
	}

	return response.json();
}

/** Create a single xAI Responses API response with model-aware routing. */
export async function createXaiResponse(
	apiKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const model = xaiModelForRequest(typeof body.model === "string" ? body.model : undefined);
	const payload = rewriteXaiResponsesPayload(body, model) as Record<string, unknown>;
	const usesGrokCliProxy = isGrokCliProxyModel(model.id);
	const grokCliSessionId = usesGrokCliProxy
		? (typeof body.previous_response_id === "string" && body.previous_response_id) || randomUUID()
		: undefined;
	return postXaiJson(
		apiKey,
		xaiResponsesUrlForModel(model.id),
		payload,
		signal,
		xaiModelRequestHeaders(model.id, grokCliSessionId),
	);
}

/**
 * Stream pi's simple Responses flow through xAI with payload normalization.
 *
 * The transport is delegated to pi's builtin OpenAI Responses helper with a
 * temporary `openai-responses` API tag, while xAI routing headers, request
 * URLs, and payload rewriting continue to use the original xAI model metadata.
 * Returned events are forwarded through an assistant stream exposing async
 * iteration and `result()`. Delegate load or stream failures are converted
 * into terminal error events with xAI provider metadata instead of escaping
 * as unstructured promise failures.
 */
export function streamSimpleXaiResponses(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) {
	const sessionId = options?.sessionId;
	const routingSessionId = sessionId || (isGrokCliProxyModel(model.id) ? randomUUID() : undefined);
	const modelHeaders = (model as unknown as { headers?: Record<string, string> }).headers;
	const streamModel = {
		...model,
		baseUrl: xaiBaseUrlForModel(model.id),
		headers: {
			...modelHeaders,
			...xaiModelRequestHeaders(model.id, routingSessionId),
		},
	};
	const openAIResponsesModel = {
		...streamModel,
		api: "openai-responses" as const,
	};
	const headers = { ...(options?.headers || {}) };
	if (routingSessionId && !headers["x-grok-conv-id"]) headers["x-grok-conv-id"] = routingSessionId;

	const stream = createForwardingAssistantStream();
	void (async () => {
		try {
			const inner = streamSimpleOpenAIResponses(
				openAIResponsesModel as Model<"openai-responses">,
				context,
				{
					...options,
					sessionId: sessionId || routingSessionId,
					headers,
					async onPayload(payload: unknown) {
						const rewritten = rewriteXaiResponsesPayload(payload, streamModel, {
							...options,
							sessionId: sessionId || routingSessionId,
						});
						const userRewritten = await options?.onPayload?.(rewritten, streamModel);
						return userRewritten === undefined ? rewritten : userRewritten;
					},
				},
			);
			for await (const event of inner as AsyncIterable<StreamEvent>) {
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			const message = streamErrorMessage(model, error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end(message);
		}
	})();
	return stream;
}
