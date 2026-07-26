import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileFinder } from "@ff-labs/fff-node";

export function registerFffCommands(
	pi: ExtensionAPI,
	getFinder: () => FileFinder | null,
): void {
	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and status",
		handler: async (_args, ctx) => {
			const finder = getFinder();
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const health = finder.healthCheck();
			if (!health.ok) {
				ctx.ui.notify(`Health check failed: ${health.error}`, "error");
				return;
			}

			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
			];

			const progress = finder.getScanProgress();
			if (progress.ok) {
				lines.push(
					`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args, ctx) => {
			const finder = getFinder();
			if (!finder || finder.isDestroyed) {
				ctx.ui.notify("FFF not initialized", "warning");
				return;
			}

			const result = finder.scanFiles();
			if (!result.ok) {
				ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify("FFF rescan triggered", "info");
		},
	});
}
