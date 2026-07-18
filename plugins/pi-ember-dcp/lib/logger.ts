/**
 * Tiny debug logger. Writes to ~/.pi-dcp/dcp.log when enabled in config.
 * Always cheap to call with debug=false (early return, no formatting).
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".pi-dcp");
const LOG_FILE = path.join(LOG_DIR, "dcp.log");

export class Logger {
	private readonly debug: boolean;

	constructor(debug: boolean) {
		this.debug = debug;
	}

	info(msg: string, meta?: Record<string, unknown>): void {
		this.write("INFO", msg, meta);
	}

	warn(msg: string, meta?: Record<string, unknown>): void {
		this.write("WARN", msg, meta);
	}

	error(msg: string, meta?: Record<string, unknown>): void {
		// Errors always log, even with debug=false — they are rare and important.
		this.write_forced("ERROR", msg, meta);
	}

	private write(level: string, msg: string, meta?: Record<string, unknown>): void {
		if (!this.debug) return;
		this.write_forced(level, msg, meta);
	}

	private write_forced(level: string, msg: string, meta?: Record<string, unknown>): void {
		try {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			const stamp = new Date().toISOString();
			const tail = meta ? ` ${JSON.stringify(meta)}` : "";
			fs.appendFileSync(LOG_FILE, `[${stamp}] ${level} ${msg}${tail}\n`);
		} catch {
			// Swallow logging failures — we never want logging to break the agent.
		}
	}
}
