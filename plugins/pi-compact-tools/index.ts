import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { registerQuestionnaireTool } from "./questionnaire-tool.ts";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function registerCollapsedEditTool(extensionApi: any): void {
	const editDefinition = createEditTool(SOURCE_ROOT);
	extensionApi.registerTool({
		name: "edit",
		label: "edit",
		description: editDefinition.description,
		parameters: editDefinition.parameters,
		renderShell: "self",

		async execute(
			toolCallId: string,
			params: any,
			signal: AbortSignal,
			onUpdate: any,
			ctx: any,
		) {
			return createEditTool(ctx.cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);
		},

		renderCall(args: any, theme: any): any {
			const filePath = String(args?.path ?? args?.file_path ?? "");
			return new Text(
				theme.fg("toolTitle", theme.bold("edit ")) +
					theme.fg("accent", filePath),
				0,
				0,
			);
		},

		renderResult(result: any, { isPartial }: any, theme: any): any {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);

			const content = result.content?.find((item: any) => item.type === "text");
			if (content?.text?.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
			let additions = 0;
			let removals = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			return new Text(
				theme.fg("success", `+${additions}`) +
					theme.fg("dim", " / ") +
					theme.fg("error", `-${removals}`),
				0,
				0,
			);
		},
	});
}

export default function piCompactToolsPlugin(pi: any): void {
	registerQuestionnaireTool(pi);
	registerCollapsedEditTool(pi);
}
