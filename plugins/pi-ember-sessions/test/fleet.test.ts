import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clear_fleet_persistence,
	configure_fleet_session_factory,
	create_fleet_session,
	fleet_find,
	fleet_list,
	format_fleet_row,
	type FleetEvent,
	type FleetSessionFactory,
	forget_fleet_session,
	load_fleet,
	on_fleet_change,
	release_fleet_session,
	reset_fleet,
	send_fleet_message,
	stop_fleet_session,
} from "../fleet.ts";

/**
 * The fleet registry coordinates background conversations. Tests drive it with
 * a fake factory, so no SDK/runtime/provider is involved: the contract under
 * test is ownership (one writer per session file), state transitions, and
 * persistence across a TUI session switch.
 */

const previous_home = process.env.PI_HOME;
const home = mkdtempSync(join(tmpdir(), "pi-ember-fleet-home-"));
const workdir = mkdtempSync(join(tmpdir(), "pi-ember-fleet-work-"));

beforeAll(() => {
	process.env.PI_HOME = home;
});

/** Fake runtime: records the events the fleet pushed back and resolves on demand. */
function fake_factory() {
	const created: Array<{
		name: string;
		session_file: string;
		emit: (event: FleetEvent) => void;
		prompts: string[];
		aborted: number;
		disposed: number;
		resolve?: () => void;
	}> = [];
	const factory: FleetSessionFactory = async ({ name, session_file, on_event }) => {
		// Simulate Pi: a new conversation reserves its path, an existing one opens.
		const resolved = session_file ?? join(workdir, `${name.replace(/[^a-z0-9-]/gi, "_")}.jsonl`);
		const record = {
			name,
			session_file: resolved,
			emit: on_event,
			prompts: [] as string[],
			aborted: 0,
			disposed: 0,
			resolve: undefined as (() => void) | undefined,
		};
		created.push(record);
		return {
			session_file: resolved,
			handle: {
				prompt: (text: string) =>
					new Promise<void>((resolve) => {
						record.prompts.push(text);
						record.resolve = resolve;
						// The first assistant message is what writes the file.
						writeFileSync(resolved, `${JSON.stringify({ type: "session", id: name })}\n`, {
							flag: "a",
						});
					}),
				abort: async () => {
					record.aborted += 1;
					record.resolve?.();
				},
				dispose: () => {
					record.disposed += 1;
				},
			},
		};
	};
	return { factory, created };
}

afterEach(() => {
	reset_fleet({ dispose: true });
	clear_fleet_persistence();
	configure_fleet_session_factory(undefined);
});

afterAll(() => {
	if (previous_home === undefined) delete process.env.PI_HOME;
	else process.env.PI_HOME = previous_home;
	rmSync(home, { recursive: true, force: true });
	rmSync(workdir, { recursive: true, force: true });
});

describe("fleet registry", () => {
	test("registers a conversation idle, with no runtime and no file yet", () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		const info = create_fleet_session("api-refactor");
		expect(info.state).toBe("idle");
		expect(info.session_file).toBe("");
		expect(created).toHaveLength(0);
		expect(fleet_find("API-REFACTOR")?.name).toBe("api-refactor");
		expect(fleet_list().map((session) => session.name)).toEqual(["api-refactor"]);
	});

	test("send starts the run in the background and reports activity", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");

		await send_fleet_message("api-refactor", "refactor the client");
		expect(created).toHaveLength(1);
		expect(created[0]?.prompts).toEqual(["refactor the client"]);
		expect(fleet_find("api-refactor")?.state).toBe("running");
		expect(fleet_find("api-refactor")?.session_file.endsWith(".jsonl")).toBe(true);

		created[0]?.emit({ type: "activity", text: "reading src/client.ts" });
		created[0]?.emit({ type: "usage", turns: 2, cost: 0.25, tokens: 1234 });
		const info = fleet_find("api-refactor");
		expect(info?.activity).toBe("reading src/client.ts");
		expect(info?.turns).toBe(2);
		expect(info?.cost).toBeCloseTo(0.25);
		expect(info?.tokens).toBe(1234);

		created[0]?.emit({ type: "settled" });
		expect(fleet_find("api-refactor")?.state).toBe("idle");
	});

	test("a running session cannot take a second message", async () => {
		const { factory } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");
		await send_fleet_message("api-refactor", "first");
		await expect(send_fleet_message("api-refactor", "second")).rejects.toThrow(/already running/);
	});

	test("an error event marks the session and the message survives", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");
		await send_fleet_message("api-refactor", "first");
		created[0]?.emit({ type: "error", message: "provider 529" });
		const info = fleet_find("api-refactor");
		expect(info?.state).toBe("error");
		expect(info?.error).toBe("provider 529");
		expect(format_fleet_row(info!).includes("provider 529")).toBe(true);
	});

	test("stop aborts without forgetting the conversation", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");
		await send_fleet_message("api-refactor", "first");
		const info = await stop_fleet_session("api-refactor");
		expect(created[0]?.aborted).toBe(1);
		expect(info.state).toBe("idle");
		expect(fleet_find("api-refactor")).toBeDefined();
	});

	test("release disposes the runtime before the TUI can open the file", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");
		await send_fleet_message("api-refactor", "first");

		const info = await release_fleet_session("api-refactor");
		expect(created[0]?.aborted).toBe(1);
		expect(created[0]?.disposed).toBe(1);
		expect(info.session_file.length).toBeGreaterThan(0);

		// The next message builds a fresh runtime for the same file.
		await send_fleet_message("api-refactor", "second");
		expect(created).toHaveLength(2);
		expect(created[1]?.session_file).toBe(created[0]?.session_file);
	});

	test("an unattached, never-run conversation cannot be opened", async () => {
		const { factory } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		create_fleet_session("api-refactor");
		await expect(release_fleet_session("api-refactor")).rejects.toThrow(/no session file yet/);
	});

	test("forget drops the session and keeps the file", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		const info = create_fleet_session("api-refactor");
		await send_fleet_message("api-refactor", "first");
		forget_fleet_session("api-refactor");
		expect(fleet_find("api-refactor")).toBeUndefined();
		expect(created[0]?.disposed).toBe(1);
		expect(Bun.file(info.session_file).size).toBeGreaterThan(0);
	});

	test("the fleet survives a TUI session switch and revives from disk", async () => {
		const { factory } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		const created = create_fleet_session("night-shift");

		// Session replacement: the registry resets, the file keeps the list.
		reset_fleet();
		expect(fleet_list()).toEqual([]);

		load_fleet(workdir);
		const revived = fleet_find("night-shift");
		expect(revived?.session_file).toBe(created.session_file);
		expect(revived?.state).toBe("idle");
	});

	test("changes notify subscribers once per state change", async () => {
		const { factory, created } = fake_factory();
		configure_fleet_session_factory(factory);
		load_fleet(workdir);
		let changes = 0;
		const unsubscribe = on_fleet_change(() => {
			changes += 1;
		});
		create_fleet_session("api-refactor");
		expect(changes).toBe(1);
		await send_fleet_message("api-refactor", "first");
		expect(changes).toBeGreaterThan(1);
		created[0]?.emit({ type: "settled" });
		unsubscribe();
		const seen = changes;
		created[0]?.emit({ type: "settled" });
		expect(changes).toBe(seen);
	});
});
