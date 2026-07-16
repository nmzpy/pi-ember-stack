import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CURSOR_MODEL_ID_PATTERN } from "./constants.js";
import { spawn_cursor_agent, strip_ansi, terminate_cursor_process } from "./cli.js";
import { build_cursor_prompt, normalize_tool_arguments, resolve_pi_tool_name } from "./context.js";

type CursorEvent = Record<string, unknown>;
type ActiveBlock = { type: "text" | "thinking"; index: number } | null;

const active_processes = new Set<ChildProcessWithoutNullStreams>();
const MAX_STDERR_CHARS = 64 * 1024;
let active_cwd: string | undefined;

function make_initial_message(model: Model<Api>): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number_or_zero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safe_tool_call_id(value: unknown): string {
	if (typeof value !== "string" || !value) return `cursor-${Date.now()}`;
	const safe = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.slice(0, 200) || `cursor-${Date.now()}`;
}

function apply_usage(output: AssistantMessage, value: unknown): void {
	if (!is_record(value)) return;
	const input = number_or_zero(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
	const raw_output = number_or_zero(
		value.outputTokens ?? value.output_tokens ?? value.completion_tokens,
	);
	const reasoning = number_or_zero(value.reasoningTokens ?? value.reasoning_tokens);
	const cache_read = number_or_zero(value.cacheReadTokens ?? value.cache_read_tokens);
	const cache_write = number_or_zero(value.cacheWriteTokens ?? value.cache_write_tokens);
	const completion = raw_output + reasoning;

	output.usage.input = input;
	output.usage.output = completion;
	output.usage.reasoning = reasoning;
	output.usage.cacheRead = cache_read;
	output.usage.cacheWrite = cache_write;
	output.usage.totalTokens = input + completion + cache_read + cache_write;
}

function cursor_content(event: CursorEvent, type: "text" | "thinking"): string {
	if (event.type === "thinking" && type === "thinking") {
		return typeof event.text === "string" ? event.text : "";
	}
	if (event.type !== "assistant" || !is_record(event.message)) return "";
	const content = Array.isArray(event.message.content) ? event.message.content : [];
	return content
		.filter(is_record)
		.map((part) => {
			if (part.type !== type) return "";
			if (type === "text") return typeof part.text === "string" ? part.text : "";
			return typeof part.thinking === "string" ? part.thinking : "";
		})
		.join("");
}

function is_partial_delta(event: CursorEvent): boolean {
	return typeof event.timestamp_ms === "number" && typeof event.model_call_id !== "string";
}

class CursorEventConsumer {
	private active_block: ActiveBlock = null;
	private emitted_text = "";
	private emitted_thinking = "";
	private terminal_error: string | undefined;
	private tool_call: ToolCall | undefined;

	constructor(
		private readonly output: AssistantMessage,
		private readonly stream: AssistantMessageEventStream,
		private readonly tools: readonly Tool[],
	) {}

	consume(event: CursorEvent): "continue" | "terminate" {
		if (event.type === "assistant") {
			const thinking = cursor_content(event, "thinking");
			if (thinking) this.emit_content("thinking", thinking, is_partial_delta(event));
			const text = cursor_content(event, "text");
			if (text) this.emit_content("text", text, is_partial_delta(event));
			return "continue";
		}

		if (event.type === "thinking") {
			const thinking = cursor_content(event, "thinking");
			if (thinking) this.emit_content("thinking", thinking, is_partial_delta(event));
			return "continue";
		}

		if (
			event.type === "tool_call" &&
			(event.subtype === undefined || event.subtype === "started")
		) {
			this.close_active_block();
			const parsed = this.parse_tool_call(event);
			if (typeof parsed === "string") {
				this.terminal_error = parsed;
				return "terminate";
			}
			this.tool_call = parsed;
			this.emit_tool_call(parsed);
			return "terminate";
		}

		if (event.type === "result") {
			apply_usage(this.output, event.usage);
			if (event.is_error === true || event.subtype === "error") {
				const error = is_record(event.error) ? event.error : undefined;
				this.terminal_error =
					(typeof error?.message === "string" && error.message) ||
					(typeof event.result === "string" && event.result) ||
					"Cursor request failed.";
			}
		}

		if (event.type === "error") {
			this.terminal_error =
				(typeof event.message === "string" && event.message) || "Cursor request failed.";
		}
		return "continue";
	}

	finish(): { toolCall?: ToolCall; error?: string } {
		this.close_active_block();
		return { toolCall: this.tool_call, error: this.terminal_error };
	}

	private emit_content(type: "text" | "thinking", value: string, delta: boolean): void {
		if (this.active_block?.type !== type) {
			this.close_active_block();
			const index = this.output.content.length;
			if (type === "text") this.output.content.push({ type: "text", text: "" });
			else this.output.content.push({ type: "thinking", thinking: "" });
			this.active_block = { type, index };
			this.stream.push({
				type: type === "text" ? "text_start" : "thinking_start",
				contentIndex: index,
				partial: this.output,
			});
		}

		const previous = type === "text" ? this.emitted_text : this.emitted_thinking;
		const next_delta = delta
			? value
			: value.startsWith(previous)
				? value.slice(previous.length)
				: previous.startsWith(value)
					? ""
					: value;
		if (!next_delta) return;
		if (type === "text") this.emitted_text += next_delta;
		else this.emitted_thinking += next_delta;

		const block = this.output.content[this.active_block.index];
		if (type === "text" && block.type === "text") block.text += next_delta;
		if (type === "thinking" && block.type === "thinking") block.thinking += next_delta;
		this.stream.push({
			type: type === "text" ? "text_delta" : "thinking_delta",
			contentIndex: this.active_block.index,
			delta: next_delta,
			partial: this.output,
		});
	}

	private close_active_block(): void {
		if (!this.active_block) return;
		const { type, index } = this.active_block;
		const block = this.output.content[index];
		if (type === "text" && block.type === "text") {
			this.stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: this.output,
			});
		}
		if (type === "thinking" && block.type === "thinking") {
			this.stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: this.output,
			});
		}
		this.active_block = null;
	}

	private parse_tool_call(event: CursorEvent): ToolCall | string {
		if (!is_record(event.tool_call)) return "Cursor emitted a malformed tool call.";
		const [raw_name, payload] = Object.entries(event.tool_call)[0] || [];
		if (!raw_name || !is_record(payload)) return "Cursor emitted a malformed tool call.";
		const tool_name = resolve_pi_tool_name(raw_name, this.tools);
		if (!tool_name) {
			return `Cursor attempted unavailable tool ${raw_name}; the request was stopped before host execution.`;
		}
		const input = is_record(payload.args)
			? payload.args
			: is_record(payload.input)
				? payload.input
				: {};
		return {
			type: "toolCall",
			id: safe_tool_call_id(event.call_id),
			name: tool_name,
			arguments: normalize_tool_arguments(tool_name, input),
		};
	}

	private emit_tool_call(tool_call: ToolCall): void {
		const index = this.output.content.length;
		this.output.content.push(tool_call);
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
		this.stream.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: JSON.stringify(tool_call.arguments),
			partial: this.output,
		});
		this.stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: tool_call,
			partial: this.output,
		});
	}
}

function error_message(
	output: AssistantMessage,
	message: string,
	aborted: boolean,
): AssistantMessage {
	output.stopReason = aborted ? "aborted" : "error";
	output.errorMessage = strip_ansi(message).trim();
	return output;
}

export function stream_cursor_subscription(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = make_initial_message(model);

	void (async () => {
		let child: ChildProcessWithoutNullStreams | undefined;
		try {
			stream.push({ type: "start", partial: output });
			if (!CURSOR_MODEL_ID_PATTERN.test(model.id)) {
				throw new Error(`Invalid Cursor model id: ${model.id}`);
			}
			const prompt = build_cursor_prompt(context);
			child = spawn_cursor_agent(
				[
					"--print",
					"--output-format",
					"stream-json",
					"--stream-partial-output",
					"--model",
					model.id,
					"--force",
				],
				{ cwd: active_cwd || process.cwd() },
			);
			active_processes.add(child);

			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
			});
			const close = new Promise<number>((resolve, reject) => {
				child?.once("error", reject);
				child?.once("close", (code) => resolve(code ?? 1));
			});
			const abort = (): void => {
				if (child) terminate_cursor_process(child);
			};
			options?.signal?.addEventListener("abort", abort, { once: true });

			child.stdin.end(prompt);
			const consumer = new CursorEventConsumer(output, stream, context.tools || []);
			let buffer = "";
			let terminated_for_tool = false;
			for await (const chunk of child.stdout) {
				buffer += chunk.toString("utf8");
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let event: CursorEvent;
					try {
						event = JSON.parse(line) as CursorEvent;
					} catch {
						continue;
					}
					if (consumer.consume(event) === "terminate") {
						terminated_for_tool = true;
						terminate_cursor_process(child);
						break;
					}
				}
				if (terminated_for_tool) break;
			}

			const exit_code = await close;
			options?.signal?.removeEventListener("abort", abort);
			const result = consumer.finish();
			if (result.toolCall) {
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else if (options?.signal?.aborted) {
				const error = error_message(output, "Cursor request aborted.", true);
				stream.push({ type: "error", reason: "aborted", error });
			} else if (result.error || exit_code !== 0) {
				const detail = result.error || stderr || `cursor-agent exited with code ${exit_code}.`;
				const error = error_message(output, detail, false);
				stream.push({ type: "error", reason: "error", error });
			} else {
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
			}
		} catch (cause) {
			if (child?.exitCode === null) terminate_cursor_process(child);
			const aborted = options?.signal?.aborted === true;
			const detail = cause instanceof Error ? cause.message : String(cause);
			const error = error_message(output, detail, aborted);
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error });
		} finally {
			if (child) {
				if (child.exitCode === null) terminate_cursor_process(child);
				active_processes.delete(child);
			}
			stream.end();
		}
	})();

	return stream;
}

export function terminate_cursor_processes(): void {
	for (const child of active_processes) terminate_cursor_process(child);
	active_processes.clear();
}

export function set_cursor_cwd(cwd: string | undefined): void {
	active_cwd = cwd;
}

export const __test_only = {
	CursorEventConsumer,
	apply_usage,
	make_initial_message,
	safe_tool_call_id,
};
