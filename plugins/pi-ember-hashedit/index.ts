import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { set_hashedit_owns_editing } from "../pi-custom-agents/edit-tools.ts";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { readConfig, toggleAutoRead } from "./src/config.ts";
import { AUTO_READ_MAX } from "./src/constants.ts";
import { loadFileKindAndText } from "./src/file-kind.ts";
import { readNormFile } from "./src/file-reader.ts";
import { resolveTarget } from "./src/fs-write.ts";
import { loadHashStore, pruneMissing } from "./src/hash-store.ts";
import { initHasher, MAX_HASH_LINES } from "./src/hashline/index.ts";
import { toCwd } from "./src/paths.ts";
import { fmtReadPreview, regRead } from "./src/read.ts";
import { regReplace } from "./src/replace.ts";
import { extractWarnings } from "./src/replace-render.ts";
import type { RMetrics } from "./src/replace-response.ts";
import { clearUndo, regReplaceUndo } from "./src/replace-undo.ts";
import { clearServed, recordServedSafe } from "./src/served.ts";
import { valAccess } from "./src/validation.ts";

export default function (pi: ExtensionAPI): void {
	// SSOT handoff: pi-custom-agents' mode tool-set builders consult this flag
	// (jiti-safe Symbol.for in edit-tools.ts) and expose `replace` instead of
	// `edit` for every parent-mode setActiveTools call — session restore,
	// /model switches, and mode switches alike. Subagent child sessions keep
	// native edit because they never load this plugin.
	set_hashedit_owns_editing(true);

	regRead(pi);

	regReplace(pi);
	regReplaceUndo(pi);

	let autoRead = true;

	pi.on("session_start", async (_event, ctx) => {
		await initHasher();
		try {
			const store = await loadHashStore();
			await pruneMissing(store);
		} catch (err) {
			console.error("Failed to load or prune hash store:", err);
		}
		const config = await readConfig();
		autoRead = config.autoRead;
		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify(`Hashline Edit mode active`, "info");
		}
	});

	pi.registerCommand("toggle-auto-read", {
		description:
			"Toggle automatic hashline anchors after write and post-edit diffs after replace and undo_last_replace operations",
		handler: async (_args, ctx) => {
			autoRead = await toggleAutoRead();
			const state = autoRead ? "enabled" : "disabled";
			ctx.ui.notify(
				`Auto-read anchors (write) and post-edit diffs (replace/undo): ${state}`,
				"info",
			);
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		if (event.toolName === "write") {
			const writtenPath = (event.input as Record<string, unknown>)?.path;
			if (typeof writtenPath === "string") {
				try {
					const target = await resolveTarget(toCwd(writtenPath, ctx.cwd));
					await clearUndo(target);
					const store = await loadHashStore();
					clearServed(store, target);
				} catch (error) {
					console.error("Failed to clear undo after write:", error);
				}
			}
			if (!autoRead) return;
			if (typeof writtenPath !== "string") return;
			try {
				const resolvedPath = await resolveTarget(toCwd(writtenPath, ctx.cwd));
				await valAccess(resolvedPath, writtenPath);
				const file = await loadFileKindAndText(resolvedPath, {
					maxLines: MAX_HASH_LINES,
					displayPath: writtenPath,
				});
				if (file.kind !== "text") return;
				const { normalized, fileHashes, absolutePath } = await readNormFile(writtenPath, ctx.cwd, {
					maxLines: MAX_HASH_LINES,
					preloadedFile: file,
				});
				const preview = await fmtReadPreview(
					normalized,
					{},
					fileHashes,
					absolutePath,
					DEFAULT_MAX_BYTES,
					AUTO_READ_MAX,
				);
				await recordServedSafe(absolutePath, preview.servedHashes, "auto-read");
				return {
					content: [
						...(event.content ?? []),
						{ type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
					],
				};
			} catch (error) {
				console.error("Auto-read after write failed:", error);
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						...(event.content ?? []),
						{ type: "text", text: `\n\n--- Auto-read failed: ${message} ---` },
					],
				};
			}
		}

		if (event.toolName !== "replace" && event.toolName !== "undo_last_replace") return;
		if (!autoRead) return;

		const metrics = (event.details as { metrics?: RMetrics } | undefined)?.metrics;
		if (metrics?.classification === "noop") return;

		const diff = (event.details as { diff?: string } | undefined)?.diff;
		if (!diff) return;

		const rendered = (event.content ?? [])
			.filter(
				(entry): entry is { type: "text"; text: string } =>
					entry.type === "text" && typeof entry.text === "string",
			)
			.map((entry) => entry.text)
			.join("\n");
		const warnings = extractWarnings(rendered);
		return {
			content: [
				{
					type: "text",
					text: warnings ? `${diff}\n\n${warnings}` : diff,
				},
			],
		};
	});
}
