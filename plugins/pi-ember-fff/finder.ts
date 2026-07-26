import { FileFinder } from "@ff-labs/fff-node";
import {
	buildQuery,
	resolveExternalTarget,
	type ExternalAllowlist,
} from "./query.ts";

export type FinderManagerConfig = {
	frecencyDbPath: string | undefined;
	historyDbPath: string | undefined;
	enableFsRootScanning: boolean;
	enableExternalAllow: boolean;
	externalAllowlist: ExternalAllowlist;
};

export function createFinderManager(config: FinderManagerConfig) {
	let finder: FileFinder | null = null;
	let finderCwd: string | null = null;
	let finderPromise: Promise<FileFinder> | null = null;
	let activeCwd = process.cwd();

	let externalFinder: FileFinder | null = null;
	let externalFinderDir: string | null = null;
	let externalFinderPromise: Promise<FileFinder> | null = null;

	function ensureFinder(cwd: string): Promise<FileFinder> {
		if (finder && !finder.isDestroyed && finderCwd === cwd)
			return Promise.resolve(finder);
		if (finderPromise) return finderPromise;

		finderPromise = (async () => {
			if (finder && !finder.isDestroyed) {
				finder.destroy();
				finder = null;
				finderCwd = null;
			}

			const result = FileFinder.create({
				basePath: cwd,
				frecencyDbPath: config.frecencyDbPath,
				historyDbPath: config.historyDbPath,
				aiMode: true,
				enableHomeDirScanning: true,
				enableFsRootScanning: config.enableFsRootScanning,
			});

			if (!result.ok)
				throw new Error(`Failed to create FFF file finder: ${result.error}`);

			finder = result.value;
			finderCwd = cwd;
			await finder.waitForScan(15000);
			return finder;
		})().finally(() => {
			finderPromise = null;
		});

		return finderPromise;
	}

	function destroyFinder() {
		if (finder && !finder.isDestroyed) {
			finder.destroy();
			finder = null;
			finderCwd = null;
		}
	}

	function ensureExternalFinder(dir: string): Promise<FileFinder> {
		if (externalFinder && !externalFinder.isDestroyed && externalFinderDir === dir)
			return Promise.resolve(externalFinder);
		if (externalFinderPromise) return externalFinderPromise;

		externalFinderPromise = (async () => {
			if (externalFinder && !externalFinder.isDestroyed) {
				externalFinder.destroy();
				externalFinder = null;
				externalFinderDir = null;
			}

			const result = FileFinder.create({
				basePath: dir,
				aiMode: true,
				enableHomeDirScanning: false,
				enableFsRootScanning: false,
			});

			if (!result.ok)
				throw new Error(`Failed to create external FFF file finder: ${result.error}`);

			externalFinder = result.value;
			externalFinderDir = dir;
			await externalFinder.waitForScan(15000);
			return externalFinder;
		})().finally(() => {
			externalFinderPromise = null;
		});

		return externalFinderPromise;
	}

	function destroyExternalFinder() {
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
		const query = buildQuery(
			pathParam,
			pattern,
			exclude,
			activeCwd,
			config.externalAllowlist,
		);
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
