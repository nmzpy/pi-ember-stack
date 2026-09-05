import { FileFinder } from "@ff-labs/fff-node";
import { buildQuery, resolveExternalTarget, type ExternalAllowlist } from "./query.ts";

export type FileFinderFactory = (
	options: Parameters<typeof FileFinder.create>[0],
) => ReturnType<typeof FileFinder.create>;

export type FinderManagerConfig = {
	frecencyDbPath: string | undefined;
	historyDbPath: string | undefined;
	enableFsRootScanning: boolean;
	enableExternalAllow: boolean;
	externalAllowlist: ExternalAllowlist;
	/**
	 * Injectable FileFinder factory (defaults to the real native FileFinder).
	 * Used by tests to observe readiness without a real native scan. SSOT for
	 * finder construction — both the workspace and external finders go through it.
	 */
	createFileFinder?: FileFinderFactory;
};

export function createFinderManager(config: FinderManagerConfig) {
	let finder: FileFinder | null = null;
	let finderCwd: string | null = null;
	// Single shared readiness promise for the workspace finder. When set, every
	// caller awaits it — so a tool that runs while the scan is still in flight
	// waits for the index to be ready instead of searching an incomplete index.
	let finderReady: Promise<FileFinder> | null = null;
	let activeCwd = process.cwd();

	let externalFinder: FileFinder | null = null;
	let externalFinderDir: string | null = null;
	let externalFinderReady: Promise<FileFinder> | null = null;

	function ensureFinder(cwd: string): Promise<FileFinder> {
		// Same-cwd finder: await its in-flight scan, or return it once ready.
		if (finder && !finder.isDestroyed && finderCwd === cwd) {
			if (finderReady) return finderReady;
			return Promise.resolve(finder);
		}
		// A different-cwd creation is in flight (rare) — share its readiness.
		if (finderReady) return finderReady;

		const createFinder = config.createFileFinder ?? FileFinder.create;
		const p = (async () => {
			if (finder && !finder.isDestroyed) {
				finder.destroy();
				finder = null;
				finderCwd = null;
			}

			const result = createFinder({
				basePath: cwd,
				frecencyDbPath: config.frecencyDbPath,
				historyDbPath: config.historyDbPath,
				aiMode: true,
				enableHomeDirScanning: true,
				enableFsRootScanning: config.enableFsRootScanning,
			});

			if (!result.ok) throw new Error(`Failed to create FFF file finder: ${result.error}`);

			const created = result.value;
			finder = created;
			finderCwd = cwd;
			await created.waitForScan(15000);
			return created;
		})();
		// Return the finally-derived promise so a rejection is never left
		// unhandled; the cleanup only clears the slot it owns.
		const ready = p.finally(() => {
			if (finderReady === ready) finderReady = null;
		});
		finderReady = ready;
		return ready;
	}

	function destroyFinder() {
		finderReady = null;
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
			finderCwd = null;
		}
	}

	function ensureExternalFinder(dir: string): Promise<FileFinder> {
		if (externalFinder && !externalFinder.isDestroyed && externalFinderDir === dir) {
			if (externalFinderReady) return externalFinderReady;
			return Promise.resolve(externalFinder);
		}
		if (externalFinderReady) return externalFinderReady;

		const createFinder = config.createFileFinder ?? FileFinder.create;
		const p = (async () => {
			if (externalFinder && !externalFinder.isDestroyed) {
				externalFinder.destroy();
				externalFinder = null;
				externalFinderDir = null;
			}

			const result = createFinder({
				basePath: dir,
				aiMode: true,
				enableHomeDirScanning: false,
				enableFsRootScanning: false,
			});

			if (!result.ok) throw new Error(`Failed to create external FFF file finder: ${result.error}`);

			const created = result.value;
			externalFinder = created;
			externalFinderDir = dir;
			await created.waitForScan(15000);
			return created;
		})();
		const ready = p.finally(() => {
			if (externalFinderReady === ready) externalFinderReady = null;
		});
		externalFinderReady = ready;
		return ready;
	}

	function destroyExternalFinder() {
		externalFinderReady = null;
		if (externalFinder && !externalFinder.isDestroyed) {
			externalFinder.destroy();
			externalFinder = null;
			externalFinderDir = null;
		}
	}

	async function resolveFinderAndQuery(
		pathParam: string | undefined,
		pattern: string,
		exclude: string | string[] | undefined,
	): Promise<{ finder: FileFinder; query: string }> {
		if (config.enableExternalAllow && config.externalAllowlist.entries.length > 0) {
			const target = resolveExternalTarget(pathParam, config.externalAllowlist);
			if (target) {
				const f = await ensureExternalFinder(target.entry.dir);
				const query = buildQuery(
					target.relativePath || undefined,
					pattern,
					exclude,
					target.entry.dir,
					config.externalAllowlist,
				);
				return { finder: f, query };
			}
		}
		const f = await ensureFinder(activeCwd);
		const query = buildQuery(pathParam, pattern, exclude, activeCwd, config.externalAllowlist);
		return { finder: f, query };
	}

	function externalDirForFinder(f: FileFinder): string | undefined {
		return f === externalFinder ? (externalFinderDir ?? undefined) : undefined;
	}

	return {
		getActiveCwd: () => activeCwd,
		setActiveCwd: (cwd: string) => {
			activeCwd = cwd;
		},
		getFinder: () => finder,
		ensureFinder,
		destroyFinder,
		ensureExternalFinder,
		destroyExternalFinder,
		resolveFinderAndQuery,
		externalDirForFinder,
	};
}

export type FinderManager = ReturnType<typeof createFinderManager>;
