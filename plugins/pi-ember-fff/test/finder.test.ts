import { describe, expect, test } from "bun:test";
import type { FileFinder } from "@ff-labs/fff-node";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createFinderManager,
	type FileFinderFactory,
	type FinderManager,
} from "../finder.ts";
import { startFffSession } from "../index.ts";
import { createMentionItemsLoader } from "../mention.ts";

/**
 * Minimal FileFinder stand-in that lets tests control scan completion without
 * touching the real native ffi-backed finder. Only the surface the manager
 * relies on is implemented (isDestroyed/destroy/waitForScan).
 */
class MockFinder {
	destroyed = false;
	scanDone = false;

	constructor(readonly basePath: string) {}

	get isDestroyed(): boolean {
		return this.destroyed;
	}

	destroy(): void {
		this.destroyed = true;
	}

	async waitForScan(timeoutMs = 5000): Promise<{ ok: boolean; value: boolean }> {
		const deadline = Date.now() + timeoutMs;
		while (!this.scanDone) {
			if (Date.now() >= deadline) return { ok: true, value: false };
			await new Promise((r) => setTimeout(r, 10));
		}
		return { ok: true, value: true };
	}

	completeScan(): void {
		this.scanDone = true;
	}

	// Surface used by mention autocomplete after readiness; return an empty
	// result so the loader resolves to [] instead of throwing.
	mixedSearch(): { ok: false; error: string } {
		return { ok: false, error: "mock has no index" };
	}
}

function makeMockManager(): {
	manager: FinderManager;
	created: MockFinder[];
	createCalls: () => number;
} {
	const created: MockFinder[] = [];
	let createCalls = 0;
	const createFileFinder: FileFinderFactory = ((options: unknown) => {
		createCalls += 1;
		const mock = new MockFinder((options as { basePath: string }).basePath);
		created.push(mock);
		return { ok: true, value: mock as unknown as FileFinder };
	}) as FileFinderFactory;
	const manager = createFinderManager({
		frecencyDbPath: undefined,
		historyDbPath: undefined,
		enableFsRootScanning: false,
		enableExternalAllow: true,
		externalAllowlist: { entries: [], resolve: () => undefined, covers: () => false },
		createFileFinder,
	});
	return { manager, created, createCalls: () => createCalls };
}

function makeSessionCtx(cwd: string): {
	cwd: string;
	ui: {
		notify: () => void;
		addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
	};
} {
	return {
		cwd,
		ui: { notify: () => {}, addAutocompleteProvider: () => {} },
	};
}

describe("FFF session_start is non-blocking; first tool awaits shared readiness", () => {
	test("session_start kickoff returns while scan is pending; grep/find await the scan", async () => {
		const { manager, created } = makeMockManager();
		const getMentionItems = createMentionItemsLoader(
			manager.ensureFinder,
			manager.getActiveCwd,
		);

		// Simulate session_start: must return synchronously (void) while the
		// background scan is still pending — never blocks startup.
		startFffSession(manager, getMentionItems, makeSessionCtx("/workspace"));

		// The finder was created synchronously and its scan is still pending.
		expect(created).toHaveLength(1);
		expect(created[0].scanDone).toBe(false);

		// First tool execution must NOT resolve until the scan completes.
		let toolResolved = false;
		const toolPromise = manager
			.resolveFinderAndQuery("src", "MyClass", undefined)
			.then((r) => {
				toolResolved = true;
				return r;
			});
		await new Promise((r) => setTimeout(r, 40));
		expect(toolResolved).toBe(false);

		// Scan completes → first tool resolves with the correct finder + query.
		created[0].completeScan();
		const { finder, query } = await toolPromise;
		expect(toolResolved).toBe(true);
		expect(finder).toBe(created[0] as unknown as FileFinder);
		expect(query).toBe("src/ MyClass");

		manager.destroyFinder();
	});

	test("mention autocomplete also shares the same readiness promise", async () => {
		const { manager, created } = makeMockManager();
		const getMentionItems = createMentionItemsLoader(
			manager.ensureFinder,
			manager.getActiveCwd,
		);
		startFffSession(manager, getMentionItems, makeSessionCtx("/workspace"));
		expect(created).toHaveLength(1);

		// Mention lookup (typing `@`) must also wait for the scan.
		let mentionResolved = false;
		const mentionPromise = getMentionItems("main", new AbortController().signal).then(
			() => {
				mentionResolved = true;
			},
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(mentionResolved).toBe(false);

		created[0].completeScan();
		await mentionPromise;
		expect(mentionResolved).toBe(true);

		manager.destroyFinder();
	});

	test("session replacement destroys and recreates the finder (cleanup preserved)", async () => {
		const { manager, created, createCalls } = makeMockManager();
		const getMentionItems = createMentionItemsLoader(
			manager.ensureFinder,
			manager.getActiveCwd,
		);
		const firstCwd = "/workspace-a";
		const secondCwd = "/workspace-b";

		// First session.
		startFffSession(manager, getMentionItems, makeSessionCtx(firstCwd));
		created[0].completeScan();
		await manager.ensureFinder(firstCwd);
		expect(createCalls()).toBe(1);

		// session_shutdown destroys the finder.
		manager.destroyFinder();
		expect(created[0].isDestroyed).toBe(true);

		// Second session (different cwd) creates a fresh finder.
		startFffSession(manager, getMentionItems, makeSessionCtx(secondCwd));
		expect(createCalls()).toBe(2);
		expect(created[1].isDestroyed).toBe(false);
		created[1].completeScan();
		const { finder } = await manager.resolveFinderAndQuery(undefined, "x", undefined);
		expect(finder).toBe(created[1] as unknown as FileFinder);

		manager.destroyFinder();
	});

	test("creation failure rejects (fail-fast) and a retry recreates", async () => {
		let failNext = true;
		let createCalls = 0;
		const created: MockFinder[] = [];
		const createFileFinder: FileFinderFactory = ((options: unknown) => {
			createCalls += 1;
			if (failNext) return { ok: false, error: "boom" };
			const mock = new MockFinder((options as { basePath: string }).basePath);
			created.push(mock);
			return { ok: true, value: mock as unknown as FileFinder };
		}) as FileFinderFactory;
		const manager = createFinderManager({
			frecencyDbPath: undefined,
			historyDbPath: undefined,
			enableFsRootScanning: false,
			enableExternalAllow: true,
			externalAllowlist: { entries: [], resolve: () => undefined, covers: () => false },
			createFileFinder,
		});

		// First attempt fails → the readiness slot is cleared for retry.
		await expect(manager.ensureFinder("/workspace")).rejects.toThrow(
			"Failed to create FFF file finder: boom",
		);

		// A later attempt succeeds with a fresh finder.
		failNext = false;
		const first = manager.ensureFinder("/workspace");
		expect(created).toHaveLength(1);
		created[0].completeScan();
		const f = await first;
		expect(createCalls).toBe(2);
		expect((f as unknown as MockFinder).basePath).toBe("/workspace");

		manager.destroyFinder();
	});
});