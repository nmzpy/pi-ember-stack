/**
 * Fleet — long-lived background conversations in the current pi process.
 *
 * A fleet session is a real Pi session (its own session file in the project's
 * session dir, so it shows up in `/resume` and can be opened with the normal
 * switch path) whose agent runs in the background while you keep working in the
 * TUI. You can watch several of them run, hop into one, or send it another
 * message later.
 *
 * Ownership rule: at most ONE runtime owns a session file at a time. The fleet
 * owns a session while it is running/attached to the supervisor; attaching
 * (`/fleet switch`) first aborts and disposes the fleet's runtime, then hands
 * the file to Pi's `switchSession`. Never let the TUI and a fleet handle write
 * the same session file.
 *
 * This module is pure coordination: the runtime is created by an injected
 * `FleetSessionFactory` (production implementation: `session-factory.ts`), which
 * keeps the registry unit-testable and the SDK surface in one place.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type FleetState = "idle" | "starting" | "running" | "error";

export type FleetSessionInfo = {
	name: string;
	session_file: string;
	state: FleetState;
	model: string;
	created_at: number;
	last_event_at: number;
	turns: number;
	cost: number;
	tokens: number;
	/** Short description of the latest activity (thinking / tool / text). */
	activity: string;
	error?: string;
};

/** Normalized stream facts a factory reports back to the fleet. */
export type FleetEvent =
	| { type: "activity"; text: string }
	| { type: "usage"; turns?: number; cost?: number; tokens?: number }
	| { type: "error"; message: string }
	| { type: "settled" };

/** Live runtime for one fleet conversation. */
export type FleetSessionHandle = {
	prompt: (text: string) => Promise<void>;
	abort: () => Promise<void>;
	dispose: () => void;
};

/**
 * Opens (or creates) the conversation's session file and returns its live
 * handle. `session_file` is undefined for a conversation that has never run:
 * Pi defers session-file creation until the first assistant message, so a
 * brand-new fleet session reserves its path and materializes it on first send.
 */
export type FleetSessionFactory = (options: {
	name: string;
	cwd: string;
	session_file?: string | undefined;
	on_event: (event: FleetEvent) => void;
}) => Promise<{ handle: FleetSessionHandle; session_file: string }>;

type FleetEntry = {
	info: FleetSessionInfo;
	handle?: FleetSessionHandle;
};

type PersistedFleet = {
	version: 1;
	sessions: Array<{ name: string; sessionFile: string; createdAt: number; model: string }>;
};

const FLEET_VERSION = 1;

const fleet = new Map<string, FleetEntry>();
const listeners = new Set<() => void>();
let session_factory: FleetSessionFactory | undefined;
let fleet_cwd = process.cwd();
let persistence_enabled = true;

// ---------------------------------------------------------------------------
// Persistence (PI_HOME/fleet.json — the fleet outlives a TUI session switch)
// ---------------------------------------------------------------------------

function fleet_file_path(): string {
	const home = process.env.PI_HOME?.trim() || getAgentDir();
	return path.join(home, "fleet.json");
}

function read_fleet_file(): PersistedFleet | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(fleet_file_path(), "utf-8")) as PersistedFleet;
		if (parsed?.version !== FLEET_VERSION || !Array.isArray(parsed.sessions)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function write_fleet_file(): void {
	if (!persistence_enabled) return;
	try {
		const payload: PersistedFleet = {
			version: FLEET_VERSION,
			sessions: [...fleet.values()].map((entry) => ({
				name: entry.info.name,
				sessionFile: entry.info.session_file,
				createdAt: entry.info.created_at,
				model: entry.info.model,
			})),
		};
		const file = fleet_file_path();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
	} catch {
		// The fleet file is a convenience, never a correctness dependency.
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function notify_fleet_change(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			/* a broken listener must never break the fleet */
		}
	}
}

export function configure_fleet_session_factory(factory: FleetSessionFactory | undefined): void {
	session_factory = factory;
}

/** Point the fleet at a working directory (session_start) and revive its file. */
export function load_fleet(cwd: string, options?: { persistent?: boolean }): FleetSessionInfo[] {
	fleet_cwd = cwd;
	persistence_enabled = options?.persistent !== false;
	const persisted = read_fleet_file();
	if (persisted) {
		for (const session of persisted.sessions) {
			if (fleet.has(session.name)) continue;
			fleet.set(session.name, {
				info: {
					name: session.name,
					session_file: session.sessionFile,
					state: "idle",
					model: session.model,
					created_at: session.createdAt,
					last_event_at: session.createdAt,
					turns: 0,
					cost: 0,
					tokens: 0,
					activity: "",
				},
			});
		}
		notify_fleet_change();
	}
	return fleet_list();
}

/**
 * Drop the registry. Running handles are NOT disposed by default: the fleet is
 * meant to survive a TUI session switch (`/resume`, `/new`), so background work
 * keeps going and the next `load_fleet` rebinds the list.
 */
export function reset_fleet(options?: { dispose?: boolean }): void {
	if (options?.dispose) {
		for (const entry of fleet.values()) {
			entry.handle?.dispose();
		}
	}
	fleet.clear();
	notify_fleet_change();
}

/** Remove the persisted fleet list (tests, explicit reset). */
export function clear_fleet_persistence(): void {
	fleet.clear();
	write_fleet_file();
	notify_fleet_change();
}

export function fleet_list(): FleetSessionInfo[] {
	const state_rank: Record<FleetState, number> = { running: 0, starting: 1, error: 2, idle: 3 };
	return [...fleet.values()]
		.map((entry) => entry.info)
		.sort((a, b) => {
			const rank = state_rank[a.state] - state_rank[b.state];
			if (rank !== 0) return rank;
			return b.last_event_at - a.last_event_at;
		});
}

export function fleet_find(name: string): FleetSessionInfo | undefined {
	const key = name.trim().toLowerCase();
	if (!key) return undefined;
	for (const entry of fleet.values()) {
		if (entry.info.name.toLowerCase() === key) return entry.info;
	}
	return undefined;
}

export function on_fleet_change(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** One-line status row used by `/fleet` and notifications (SSOT for the format). */
export function format_fleet_row(info: FleetSessionInfo): string {
	const marks: Record<FleetState, string> = {
		idle: "idle",
		starting: "starting",
		running: "running",
		error: "error",
	};
	const parts = [info.name, marks[info.state]];
	if (info.model) parts.push(info.model);
	if (info.turns > 0) parts.push(`${info.turns} turns`);
	if (info.cost > 0) parts.push(`$${info.cost.toFixed(3)}`);
	if (info.activity) parts.push(info.activity);
	if (info.error) parts.push(info.error);
	return parts.join(" · ");
}

function fleet_name_key(name: string): string {
	return name.trim();
}

/**
 * Register a new fleet conversation. The runtime (and its session file) is
 * created on the first message, matching Pi's own deferred session-file
 * semantics — an empty conversation has nothing to resume yet.
 */
export function create_fleet_session(name: string, options?: { model?: string }): FleetSessionInfo {
	const key = fleet_name_key(name);
	if (!key) throw new Error("Fleet session needs a name.");
	if (fleet.has(key)) throw new Error(`Fleet session already exists: ${key}`);

	const info: FleetSessionInfo = {
		name: key,
		session_file: "",
		state: "idle",
		model: options?.model ?? "",
		created_at: Date.now(),
		last_event_at: Date.now(),
		turns: 0,
		cost: 0,
		tokens: 0,
		activity: "",
	};
	fleet.set(key, { info });
	write_fleet_file();
	notify_fleet_change();
	return info;
}

/** Register an existing session file as a fleet conversation (import). */
export function adopt_fleet_session(name: string, session_file: string): FleetSessionInfo {
	const key = fleet_name_key(name);
	if (!key) throw new Error("Fleet session needs a name.");
	if (fleet.has(key)) throw new Error(`Fleet session already exists: ${key}`);
	if (!fs.existsSync(session_file)) throw new Error(`Session file not found: ${session_file}`);
	const info: FleetSessionInfo = {
		name: key,
		session_file,
		state: "idle",
		model: "",
		created_at: Date.now(),
		last_event_at: Date.now(),
		turns: 0,
		cost: 0,
		tokens: 0,
		activity: "",
	};
	fleet.set(key, { info });
	write_fleet_file();
	notify_fleet_change();
	return info;
}

function apply_fleet_event(entry: FleetEntry, event: FleetEvent): void {
	const info = entry.info;
	info.last_event_at = Date.now();
	switch (event.type) {
		case "activity":
			info.activity = event.text;
			break;
		case "usage":
			if (typeof event.turns === "number") info.turns = event.turns;
			if (typeof event.cost === "number") info.cost = event.cost;
			if (typeof event.tokens === "number") info.tokens = event.tokens;
			break;
		case "error":
			info.error = event.message;
			info.state = "error";
			info.activity = "";
			break;
		case "settled":
			if (info.state !== "error") info.state = "idle";
			info.activity = "";
			break;
	}
	notify_fleet_change();
}

async function ensure_fleet_handle(entry: FleetEntry): Promise<FleetSessionHandle> {
	if (entry.handle) return entry.handle;
	if (!session_factory) throw new Error("Fleet runtime is not available in this pi session.");
	const created = await session_factory({
		name: entry.info.name,
		cwd: fleet_cwd,
		session_file: entry.info.session_file || undefined,
		on_event: (event) => apply_fleet_event(entry, event),
	});
	entry.handle = created.handle;
	if (created.session_file && created.session_file !== entry.info.session_file) {
		entry.info.session_file = created.session_file;
		write_fleet_file();
	}
	return created.handle;
}

/**
 * Send one message to a fleet conversation. Returns as soon as the run is
 * started — the conversation keeps streaming in the background.
 */
export async function send_fleet_message(name: string, message: string): Promise<FleetSessionInfo> {
	const entry = fleet.get(fleet_name_key(name));
	if (!entry) throw new Error(`Unknown fleet session: ${name}`);
	const text = message.trim();
	if (!text) throw new Error("Fleet message is empty.");
	if (entry.info.state === "running" || entry.info.state === "starting") {
		throw new Error(`Fleet session ${entry.info.name} is already running.`);
	}
	entry.info.state = "starting";
	entry.info.error = undefined;
	entry.info.activity = "sending…";
	notify_fleet_change();

	const handle = await ensure_fleet_handle(entry);
	entry.info.state = "running";
	notify_fleet_change();

	void handle
		.prompt(text)
		.then(() => {
			if (entry.info.state === "running") entry.info.state = "idle";
			notify_fleet_change();
		})
		.catch((error: unknown) => {
			apply_fleet_event(entry, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		});
	return entry.info;
}

/** Abort the current run (the conversation stays registered and resumable). */
export async function stop_fleet_session(name: string): Promise<FleetSessionInfo> {
	const entry = fleet.get(fleet_name_key(name));
	if (!entry) throw new Error(`Unknown fleet session: ${name}`);
	await entry.handle?.abort();
	if (entry.info.state === "running" || entry.info.state === "starting") entry.info.state = "idle";
	entry.info.activity = "stopped";
	notify_fleet_change();
	return entry.info;
}

/** Forget a conversation: dispose its runtime and drop it from the fleet. */
export function forget_fleet_session(name: string): FleetSessionInfo {
	const entry = fleet.get(fleet_name_key(name));
	if (!entry) throw new Error(`Unknown fleet session: ${name}`);
	entry.handle?.dispose();
	fleet.delete(entry.info.name);
	write_fleet_file();
	notify_fleet_change();
	return entry.info;
}

/**
 * Release a conversation to the TUI so it can be opened with `switchSession`.
 * The fleet's runtime must be gone first (aborted and disposed) — two writers on
 * one session file would corrupt the transcript.
 */
export async function release_fleet_session(name: string): Promise<FleetSessionInfo> {
	const entry = fleet.get(fleet_name_key(name));
	if (!entry) throw new Error(`Unknown fleet session: ${name}`);
	if (!entry.info.session_file || !fs.existsSync(entry.info.session_file)) {
		// Pi writes the session file on the first assistant message: a conversation
		// that never ran has nothing on disk to switch to.
		throw new Error(
			`${entry.info.name} has no session file yet — send it a message (/fleet send ${entry.info.name} …) before opening it.`,
		);
	}
	if (entry.handle) {
		try {
			await entry.handle.abort();
		} catch {
			/* an already-finished run needs no abort */
		}
		entry.handle.dispose();
		entry.handle = undefined;
	}
	entry.info.state = "idle";
	notify_fleet_change();
	return entry.info;
}

/** Stable short id for a session file (status rows, logs). */
export function fleet_session_id(session_file: string): string {
	return createHash("sha1").update(session_file).digest("hex").slice(0, 8);
}
