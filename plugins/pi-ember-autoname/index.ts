import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractUserText, sanitizeSessionName, shouldArmAutoNaming } from "./title.ts";

const FALLBACK_MODEL_IDS = ["swe-1-7-none", "swe-1-7-medium", "swe-1-6", "swe-1-6-slow"];
const SYSTEM_PROMPT = `You create searchable session titles for coding and technical work.
The user uses these titles later to find old sessions, so prefer memorable, specific words over generic summaries.
Return exactly one title based only on the user's first message.

Rules:
- Prefer 2 to 6 words
- Use Title Case
- Include the task, feature, bug, file, package, command, model, or error when clear
- Avoid generic titles like Coding Help, Fix Bug, Update Code, or New Session
- If the message is vague, conversational, or lacks a clear task, return a funny but compact coding-themed title
- Funny fallback titles should be memorable, not random; examples: Mystery Bug Goblin, Keyboard Goblin Hour, Undefined Behavior Club
- No quotes
- No markdown
- No labels like Title:
- No trailing punctuation
- Maximum 60 characters`;

interface AutoNameState {
	sessionToken: number;
	armed: boolean;
	pending: boolean;
}

function createState(): AutoNameState {
	return { sessionToken: 0, armed: false, pending: false };
}

export default function autoNameSessionExtension(pi: ExtensionAPI): void {
	const state = createState();

	pi.on("session_start", async (_event, ctx) => {
		state.sessionToken += 1;
		state.armed = shouldArmAutoNaming(ctx.sessionManager.getBranch(), pi.getSessionName());
		state.pending = false;
	});

	pi.on("session_shutdown", async () => {
		state.sessionToken += 1;
		state.armed = false;
		state.pending = false;
	});

	pi.on("before_agent_start", async (event) => {
		const name = pi.getSessionName();
		if (!name) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nCurrent session name: ${name}`,
		};
	});

	pi.on("message_end", async (event, ctx) => {
		if (!state.armed || state.pending || pi.getSessionName()) return;
		if (event.message.role !== "user") return;

		const prompt = extractUserText(event.message.content);
		state.armed = false;
		if (!prompt) return;

		state.pending = true;
		const token = state.sessionToken;
		const { hasUI } = ctx;
		generateSessionName(prompt, ctx)
			.then((name) => {
				if (!name) return;
				if (token !== state.sessionToken) return;
				if (pi.getSessionName()) return;
				pi.setSessionName(name);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[pi-ember-autoname] Failed to generate session name:", message);
				if (hasUI) ctx.ui.notify(`Auto-name failed: ${message}`, "error");
			})
			.finally(() => {
				if (token === state.sessionToken) state.pending = false;
			});
	});
}

async function generateSessionName(
	prompt: string,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const model = await resolveAutonameModel(ctx);
	if (!model) {
		console.warn("[pi-ember-autoname] No suitable model found");
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		console.warn("[pi-ember-autoname] No API key for", model.provider, model.id);
		return undefined;
	}
	const response = await completeViaProvider(model, ctx, prompt, auth.apiKey, auth.headers);
	if (!response) return undefined;
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return sanitizeSessionName(text);
}

/**
 * Run a one-shot completion through the provider's own `streamSimple`,
 * draining the event stream to the final assistant message.
 *
 * The autoname path cannot use `complete()` from `pi-ai/compat` because that
 * helper dispatches on `model.api` via the builtin api-registry — and custom
 * providers like `devin` register a `streamSimple` under a provider id whose
 * `api` is not in that registry ("No API provider registered for api: X").
 * Going through `getRegisteredProviderConfig(provider).streamSimple` uses the
 * extension-supplied streamer directly, so any custom provider works.
 */
async function completeViaProvider(
	model: Model<Api>,
	ctx: ExtensionContext,
	prompt: string,
	apiKey: string,
	headers: Record<string, string> | undefined,
): Promise<AssistantMessage | undefined> {
	const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
	const streamSimple = config?.streamSimple;
	if (!streamSimple) {
		console.warn("[pi-ember-autoname] Provider has no streamSimple:", model.provider);
		return undefined;
	}
	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			},
		],
	};
	const options: SimpleStreamOptions = { apiKey, headers, maxTokens: 64 };
	const stream = streamSimple(model, context, options);
	try {
		return await stream.result();
	} catch (error) {
		console.warn(
			"[pi-ember-autoname] stream failed:",
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
}

async function resolveAutonameModel(
	ctx: ExtensionContext,
): Promise<import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined> {
	for (const id of FALLBACK_MODEL_IDS) {
		const model = ctx.modelRegistry.find("devin", id);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	}
	const available = ctx.modelRegistry.getAvailable();
	for (const model of available) {
		if (ctx.modelRegistry.hasConfiguredAuth(model) && model.input?.includes("text")) return model;
	}
	return undefined;
}
