import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveXaiAuthToken } from "../auth.js";
import {
	DEFAULT_XAI_IMAGE_MODEL,
	DEFAULT_XAI_MODEL,
	XAI_IMAGES_GENERATIONS_URL,
} from "../constants.js";
import { normalizeXaiImageInput } from "../images.js";
import { grokSupportsReasoningEffort, normalizedXaiModelId } from "../models.js";
import { createXaiResponse, postXaiJson } from "../responses.js";
import { extractResponsesText, messageFromError, statusFromError } from "../text.js";
import { xaiTextInput, xaiToolError } from "./common.js";

type XaiResponseData = {
	id?: string;
	reasoning?: { content?: Array<{ text?: string }> };
	output_text?: string;
	output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

type ExecuteSignal = AbortSignal | undefined;
type ExecuteOnUpdate<T> = AgentToolUpdateCallback<T> | undefined;

const generateTextSchema = Type.Object({
	prompt: Type.String({ description: "The prompt or question" }),
	model: Type.Optional(Type.String({ description: "Model to use", default: DEFAULT_XAI_MODEL })),
	reasoning_effort: Type.Optional(
		Type.Union(
			[Type.Literal("none"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
			{
				description:
					"Reasoning effort. Defaults to high for grok-4.5 and medium for other models when omitted.",
			},
		),
	),
	response_format: Type.Optional(Type.String({ description: "Set to 'json' for JSON output" })),
	previous_response_id: Type.Optional(Type.String({ description: "Continue conversation" })),
	image_url: Type.Optional(
		Type.String({
			description: "Optional image URL for vision/multimodal input (supports image analysis)",
		}),
	),
});

type GenerateTextDetails = {
	reasoning: string;
	response_id: string;
	error?: boolean;
	status?: number;
};

const multiAgentSchema = Type.Object({
	query: Type.String({ description: "Research topic" }),
	num_agents: Type.Optional(Type.Union([Type.Literal(4), Type.Literal(16)], { default: 4 })),
	reasoning_effort: Type.Optional(
		Type.Union([Type.Literal("medium"), Type.Literal("high")], {
			description: "Override num_agents: medium uses 4 agents, high uses 16 agents",
		}),
	),
});

type MultiAgentDetails = {
	agents_used: number;
	response_id: string;
	error?: boolean;
	status?: number;
};

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
});

type WebSearchDetails = { query: string; error?: boolean; status?: number };

const xSearchSchema = Type.Object({
	query: Type.String({ description: "X search query" }),
	count: Type.Optional(
		Type.Number({ description: "Max number of posts to return (1-10)", default: 5 }),
	),
	since: Type.Optional(Type.String({ description: "Only posts after this date (YYYY-MM-DD)" })),
	until: Type.Optional(Type.String({ description: "Only posts before this date (YYYY-MM-DD)" })),
});

type XSearchDetails = { query: string; error?: boolean; status?: number };

const codeExecutionSchema = Type.Object({
	code: Type.String({ description: "Python code to execute or analyze" }),
});

type CodeExecutionDetails = { code: string; error?: boolean; status?: number };

const generateImageSchema = Type.Object({
	prompt: Type.String({ description: "Detailed description of the image to generate" }),
	model: Type.Optional(
		Type.String({ description: "Image model to use", default: DEFAULT_XAI_IMAGE_MODEL }),
	),
	n: Type.Optional(
		Type.Number({ minimum: 1, maximum: 4, description: "Number of images to generate (1-4)" }),
	),
});

type GenerateImageDetails = {
	prompt?: string;
	urls: string[];
	count: number;
	error?: boolean;
	status?: number;
};

const critiqueSchema = Type.Object({
	content: Type.String({ description: "The code, text, design, or idea to critique" }),
	aspect: Type.Optional(
		Type.String({
			description: "Focus area: code, design, writing, logic, security, performance, etc.",
		}),
	),
	tone: Type.Optional(
		Type.String({
			description: "Tone of critique: constructive, strict, balanced",
			default: "constructive",
		}),
	),
});

type CritiqueDetails = { aspect: string; tone: string; error?: boolean; status?: number };

const analyzeImageSchema = Type.Object({
	image: Type.String({ description: "Image URL, local file path, or base64 data URL" }),
	question: Type.Optional(
		Type.String({ description: "Question to ask about the image (default: describe in detail)" }),
	),
});

type AnalyzeImageDetails = { image: string; question: string; error?: boolean; status?: number };

const deepResearchSchema = Type.Object({
	topic: Type.String({ description: "Research topic or question" }),
	depth: Type.Optional(
		Type.String({ description: "Research depth: low, medium, high", default: "high" }),
	),
});

type DeepResearchDetails = { topic: string; depth: string; error?: boolean; status?: number };

/** Register OAuth-backed custom xAI tools. */
export function registerCustomXaiTools(pi: ExtensionAPI): void {
	const generateTextTool: ToolDefinition<typeof generateTextSchema, GenerateTextDetails> = {
		name: "xai_generate_text",
		label: "xAI Generate Text",
		description:
			"Generate text using Grok with full reasoning, structured output, and stateful conversations.",
		parameters: generateTextSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<GenerateTextDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ reasoning: "", response_id: "" },
				);
			}

			const model = params.model || DEFAULT_XAI_MODEL;
			const imageUrl = normalizeXaiImageInput(params.image_url);
			const input = imageUrl
				? [
						{
							role: "user" as const,
							content: [
								{ type: "input_text" as const, text: params.prompt || "Describe this image." },
								{ type: "input_image" as const, image_url: imageUrl, detail: "high" },
							],
						},
					]
				: params.prompt;

			const body: Record<string, unknown> = { model, input };
			const effort =
				params.reasoning_effort || (normalizedXaiModelId(model) === "grok-4.5" ? "high" : "medium");
			if (grokSupportsReasoningEffort(model) && effort !== "none") {
				body.reasoning = { effort };
			}
			if (params.response_format === "json") {
				body.text = { format: { type: "json_object" } };
			}
			if (params.previous_response_id) {
				body.previous_response_id = params.previous_response_id;
			}

			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(apiKey, body, signal)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<GenerateTextDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status, reasoning: "", response_id: "" },
				);
			}
			const text = extractResponsesText(data);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					reasoning: data.reasoning?.content?.[0]?.text || "",
					response_id: data.id ?? "",
				},
			};
		},
	};
	pi.registerTool(generateTextTool);

	const multiAgentTool: ToolDefinition<typeof multiAgentSchema, MultiAgentDetails> = {
		name: "xai_multi_agent",
		label: "xAI Multi-Agent Research",
		description: "Run deep multi-agent research using Grok.",
		parameters: multiAgentSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<MultiAgentDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ agents_used: 0, response_id: "" },
				);
			}

			const requestedAgents = params.num_agents === 16 ? 16 : 4;
			const effort = params.reasoning_effort || (requestedAgents === 16 ? "high" : "medium");
			const agentsUsed = effort === "high" ? 16 : 4;
			const prompt = `You are leading a team of ${agentsUsed} researchers. Research: ${params.query}`;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{
						model: "grok-4.20-multi-agent-0309",
						input: xaiTextInput(prompt),
						reasoning: { effort },
						tools: [{ type: "web_search" }, { type: "x_search" }],
					},
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<MultiAgentDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status, agents_used: 0, response_id: "" },
				);
			}
			const text = extractResponsesText(data) || "Research completed";
			return {
				content: [{ type: "text" as const, text }],
				details: { agents_used: agentsUsed, response_id: data.id ?? "" },
			};
		},
	};
	pi.registerTool(multiAgentTool);

	const webSearchTool: ToolDefinition<typeof webSearchSchema, WebSearchDetails> = {
		name: "xai_web_search",
		label: "xAI Web Search",
		description: "Search the web using Grok's native web knowledge and search capabilities.",
		parameters: webSearchSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<WebSearchDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ query: params.query },
				);
			}
			const prompt = `Search the web for: ${params.query}. Summarize the top results with sources, key facts, dates, and recent developments. Prioritize authoritative sources.`;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{
						model: DEFAULT_XAI_MODEL,
						input: xaiTextInput(prompt),
						reasoning: { effort: "medium" },
						tools: [{ type: "web_search", enable_image_understanding: true }],
					},
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<WebSearchDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status, query: params.query },
				);
			}
			const text = extractResponsesText(data) || `No results for: ${params.query}`;
			return { content: [{ type: "text" as const, text }], details: { query: params.query } };
		},
	};
	pi.registerTool(webSearchTool);

	const xSearchTool: ToolDefinition<typeof xSearchSchema, XSearchDetails> = {
		name: "xai_x_search",
		label: "xAI X Search",
		description:
			"Search X (Twitter) using Grok's native real-time X search and knowledge. Supports advanced filters like count, since, until.",
		parameters: xSearchSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<XSearchDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ query: params.query },
				);
			}
			let prompt = `You have native real-time access to X (Twitter) posts and trends via Grok's built-in X search. Use it to find the most relevant recent posts about: ${params.query}.\n\nFilters:`;
			if (params.count) prompt += ` Return up to ${params.count} posts.`;
			if (params.since) prompt += ` Only posts since ${params.since}.`;
			if (params.until) prompt += ` Only posts until ${params.until}.`;
			prompt += `\n\nSummarize:\n- Top posts with usernames, engagement (likes/reposts/views), and timestamps\n- Key quotes or main points from influential tweets\n- Overall sentiment and any emerging trends or threads\n- Notable users or conversations\n\nBe specific and cite examples where helpful.`;
			const xSearchToolConfig: Record<string, unknown> = {
				type: "x_search",
				enable_image_understanding: true,
			};
			if (params.since) xSearchToolConfig.from_date = params.since;
			if (params.until) xSearchToolConfig.to_date = params.until;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{
						model: DEFAULT_XAI_MODEL,
						input: xaiTextInput(prompt),
						reasoning: { effort: "medium" },
						tools: [xSearchToolConfig],
					},
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<XSearchDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status, query: params.query },
				);
			}
			const text = extractResponsesText(data) || `No X results for: ${params.query}`;
			return { content: [{ type: "text" as const, text }], details: { query: params.query } };
		},
	};
	pi.registerTool(xSearchTool);

	const codeExecutionTool: ToolDefinition<typeof codeExecutionSchema, CodeExecutionDetails> = {
		name: "xai_code_execution",
		label: "xAI Code Execution",
		description: "Execute or analyze Python code using xAI's native code interpreter tool.",
		parameters: codeExecutionSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<CodeExecutionDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ code: params.code },
				);
			}
			const prompt = `Execute this Python code and show the result or output:\n\n${params.code}`;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{
						model: DEFAULT_XAI_MODEL,
						input: xaiTextInput(prompt),
						reasoning: { effort: "low" },
						tools: [{ type: "code_interpreter" }],
					},
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<CodeExecutionDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ error: true, status, code: params.code },
				);
			}
			const text =
				extractResponsesText(data) || `Executed: ${String(params.code).substring(0, 100)}...`;
			return { content: [{ type: "text" as const, text }], details: { code: params.code } };
		},
	};
	pi.registerTool(codeExecutionTool);

	const generateImageTool: ToolDefinition<typeof generateImageSchema, GenerateImageDetails> = {
		name: "xai_generate_image",
		label: "xAI Image Generation",
		description: "Generate images using xAI's current image generation model.",
		parameters: generateImageSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			if (params.n !== undefined && (!Number.isInteger(params.n) || params.n < 1 || params.n > 4)) {
				return xaiToolError<GenerateImageDetails>(
					"Error: The 'n' parameter must be an integer from 1 to 4.",
					{ prompt: params.prompt, urls: [], count: 0, error: true },
				);
			}

			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<GenerateImageDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ prompt: params.prompt, urls: [], count: 0 },
				);
			}
			const body: Record<string, unknown> = {
				model: params.model || DEFAULT_XAI_IMAGE_MODEL,
				prompt: params.prompt,
			};
			if (params.n !== undefined) {
				body.n = params.n;
			}

			let data: { data?: Array<{ url?: string }> };
			try {
				data = (await postXaiJson(apiKey, XAI_IMAGES_GENERATIONS_URL, body, signal)) as {
					data?: Array<{ url?: string }>;
				};
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<GenerateImageDetails>(
					`xAI Image API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ prompt: params.prompt, urls: [], count: 0, error: true, status },
				);
			}
			const images = data.data || [];
			const urls = images
				.map((img) => img.url)
				.filter((url): url is string => typeof url === "string" && !!url);
			const text =
				urls.length > 0
					? `Generated ${urls.length} image(s):\n${urls.map((u) => `- ${u}`).join("\n")}`
					: "Image generation completed but no URLs returned.";
			return {
				content: [{ type: "text" as const, text }],
				details: { prompt: params.prompt, urls, count: urls.length },
			};
		},
	};
	pi.registerTool(generateImageTool);

	const critiqueTool: ToolDefinition<typeof critiqueSchema, CritiqueDetails> = {
		name: "xai_critique",
		label: "xAI Critique",
		description:
			"Provide detailed, reasoned critique of code, designs, writing, ideas, or arguments with structured feedback.",
		parameters: critiqueSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<CritiqueDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ aspect: "", tone: "" },
				);
			}
			const aspect = params.aspect || "overall quality and correctness";
			const tone = params.tone || "constructive";
			const prompt = `Provide a ${tone} critique focused on ${aspect}.\n\nContent to critique:\n${params.content}\n\nStructure your response with:\n- Strengths\n- Weaknesses / Issues\n- Specific suggestions for improvement\n- Overall assessment (score 1-10)\nUse step-by-step reasoning.`;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{ model: DEFAULT_XAI_MODEL, input: xaiTextInput(prompt), reasoning: { effort: "high" } },
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<CritiqueDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ aspect, tone, error: true, status },
				);
			}
			const text = extractResponsesText(data) || "Critique completed.";
			return { content: [{ type: "text" as const, text }], details: { aspect, tone } };
		},
	};
	pi.registerTool(critiqueTool);

	const analyzeImageTool: ToolDefinition<typeof analyzeImageSchema, AnalyzeImageDetails> = {
		name: "xai_analyze_image",
		label: "xAI Image Analysis",
		description:
			"Analyze images, describe visual content, answer questions about images, or extract information using Grok's vision capabilities.",
		parameters: analyzeImageSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<AnalyzeImageDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ image: params.image, question: "" },
				);
			}
			const question =
				params.question ||
				"Describe this image in detail, including objects, text, style, and any notable details.";
			const imageInput = normalizeXaiImageInput(params.image) || params.image;
			const input = [
				{
					role: "user" as const,
					content: [
						{ type: "input_image" as const, image_url: imageInput, detail: "high" },
						{ type: "input_text" as const, text: question },
					],
				},
			];
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{ model: DEFAULT_XAI_MODEL, input, reasoning: { effort: "medium" } },
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<AnalyzeImageDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ image: params.image, question, error: true, status },
				);
			}
			const text = extractResponsesText(data) || "Image analysis completed.";
			return {
				content: [{ type: "text" as const, text }],
				details: { image: params.image, question },
			};
		},
	};
	pi.registerTool(analyzeImageTool);

	const deepResearchTool: ToolDefinition<typeof deepResearchSchema, DeepResearchDetails> = {
		name: "xai_deep_research",
		label: "xAI Deep Research",
		description:
			"Conduct thorough multi-step research on a topic, synthesize information, cite sources, and provide comprehensive analysis with high reasoning effort.",
		parameters: deepResearchSchema,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) => {
			const apiKey = await resolveXaiAuthToken(ctx);
			if (!apiKey) {
				return xaiToolError<DeepResearchDetails>(
					"Error: No xAI OAuth credentials found. Please run the OAuth login first.",
					{ topic: params.topic, depth: "" },
				);
			}
			const depth = params.depth || "high";
			const prompt = `Conduct deep ${depth} research on: ${params.topic}.\n\nSteps:\n1. Gather key facts, recent developments, and authoritative sources.\n2. Analyze different perspectives and potential biases.\n3. Synthesize findings into clear conclusions.\n4. Provide actionable insights and open questions.\n\nUse step-by-step reasoning and cite sources where possible.`;
			let data: XaiResponseData;
			try {
				data = (await createXaiResponse(
					apiKey,
					{
						model: DEFAULT_XAI_MODEL,
						input: xaiTextInput(prompt),
						reasoning: { effort: depth === "high" ? "high" : "medium" },
						tools: [{ type: "web_search" }, { type: "x_search" }],
					},
					signal,
				)) as XaiResponseData;
			} catch (error) {
				const status = statusFromError(error);
				return xaiToolError<DeepResearchDetails>(
					`xAI API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
					{ topic: params.topic, depth, error: true, status },
				);
			}
			const text = extractResponsesText(data) || "Research completed.";
			return {
				content: [{ type: "text" as const, text }],
				details: { topic: params.topic, depth },
			};
		},
	};
	pi.registerTool(deepResearchTool);
}
