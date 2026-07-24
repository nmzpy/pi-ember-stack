/**
 * pi-ember-applypatch — Codex-style apply_patch tool for Pi.
 *
 * Registers `apply_patch` with compact grouped TUI rendering via the shared
 * CompactRenderer (Explored-style tree rows). Active only for openai-codex
 * models — other providers use `edit` (see pi-custom-agents/edit-tools.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";
import { getSharedRenderer } from "../pi-compact-tools/index.ts";
import { apply_ops, type ApplySummary, type OpResult } from "./apply.ts";
import type { ApplyPatchDetails } from "./display.ts";
export type { ApplyPatchDetails } from "./display.ts";
export {
	compact_patch_failure_reason,
	format_patch_error_row,
	format_result_row,
} from "./display.ts";
import { parse_patch } from "./parse.ts";
import {
	TOOL_DESCRIPTION,
	TOOL_LABEL,
	TOOL_NAME,
	TOOL_PROMPT_GUIDELINES,
	TOOL_PROMPT_SNIPPET,
} from "./prompt.ts";

export const ApplyPatchParamsSchema = Type.Object({
	input: Type.String({
		description: "Full patch including *** Begin Patch and *** End Patch",
	}),
});

export type ApplyPatchParams = Static<typeof ApplyPatchParamsSchema>;

type ToolRenderContext = {
	args: unknown;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, unknown>;
	expanded?: boolean;
	isError?: boolean;
};

type ToolRenderResultOptions = {
	isPartial: boolean;
	expanded?: boolean;
};

type ThemeLike = {
	fg(tag: string, text: string): string;
	bold(text: string): string;
};

export default function piEmberApplypatch(pi: ExtensionAPI): void {
	const renderer = getSharedRenderer();

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
		parameters: ApplyPatchParamsSchema,
		renderShell: "self",

		async execute(_tool_call_id, params, signal, _on_update, ctx) {
			const input = String(params?.input ?? "");
			const parsed = parse_patch(input);

			if (!parsed.ok) {
				const details: ApplyPatchDetails = {
					ok: false,
					results: [],
					parseError: parsed.error,
					fileCount: 0,
				};
				const payload = { ok: false, results: [] as OpResult[], error: parsed.error };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(payload) }],
					isError: true,
					details,
				};
			}

			const summary: ApplySummary = await apply_ops(ctx.cwd, parsed.ops, signal);
			const details: ApplyPatchDetails = {
				ok: summary.ok,
				results: summary.results,
				fileCount: summary.results.length,
			};
			const all_failed =
				summary.results.length > 0 && summary.results.every((r) => r.status === "error");
			const payload = { ok: summary.ok, results: summary.results };

			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload) }],
				// Parse already handled. isError only when every op failed.
				// Partial success keeps ok:false in JSON without isError so the model can recover.
				...(all_failed ? { isError: true } : {}),
				details,
			};
		},

		renderCall(args: ApplyPatchParams, theme: ThemeLike, context: ToolRenderContext) {
			return renderer.renderCall(TOOL_NAME, args, theme, context);
		},

		renderResult(
			result: any,
			options: ToolRenderResultOptions,
			theme: ThemeLike,
			context: ToolRenderContext & { isError: boolean },
		) {
			return renderer.renderResult(
				TOOL_NAME,
				context.args,
				result,
				options,
				theme,
				context,
			);
		},
	});
}
