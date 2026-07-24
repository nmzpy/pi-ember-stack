import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import {
	DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS,
	model_provider_of,
	with_provider_patch_tool,
} from "../../edit-tools.ts";
import { runSubAgent, type SubAgentResult } from "./runner.ts";
import { resolveModel } from "./model.ts";

export const SUBAGENT_REQUEST_EVENT = "pi-subagent:run";

export interface SubagentRunRequest {
	id: string;
	agent: string;
	task: string;
	cwd?: string;
	timeout?: number;
	instructions?: string;
	readOnly?: boolean;
	signal?: AbortSignal;
	accept?: () => boolean;
	respond: (response: SubagentRunResponse) => void;
}

export type SubagentRunResponse =
	| { id: string; ok: true; result: SubAgentResult }
	| { id: string; ok: false; error: string };

export async function runNamedAgent(options: {
	agent: AgentConfig;
	task: string;
	cwd: string;
	ctx: ExtensionContext;
	timeout?: number;
	instructions?: string;
	signal?: AbortSignal;
	onMessage?: (result: SubAgentResult) => void;
}): Promise<SubAgentResult> {
	const { model, attempted } = resolveModel(options.agent.model, options.ctx.model, options.ctx.modelRegistry);
	if (!model) throw new Error(`No model resolved for agent "${options.agent.name}" (tried: ${attempted.join(", ") || "none"})`);

	const modelRegistry = options.ctx.modelRegistry;
	const contract = options.instructions?.slice(0, 16 * 1024);

	return runSubAgent({
		cwd: options.cwd,
		systemPrompt: contract ? `${options.agent.systemPrompt}\n\n## Task Contract\n${contract}` : options.agent.systemPrompt,
		task: options.task,
		tools: with_provider_patch_tool(
			(options.agent.tools ?? [...DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS]).filter(
				(tool) => tool !== "subagent",
			),
			model_provider_of(model),
		),
		model,
		modelRegistry,
		parentSignal: options.signal,
		timeoutMs: options.timeout,
		agentName: options.agent.name,
		thinkingLevel: options.agent.thinking,
		onMessage: options.onMessage,
	});
}
