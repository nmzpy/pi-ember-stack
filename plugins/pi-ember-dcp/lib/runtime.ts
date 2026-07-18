/**
 * Mutable session runtime bag for pi-ember-dcp.
 *
 * Handlers close over this object (not individual config/logger/prompts
 * values) so session_start can rebind cwd-derived config without re-registering
 * tools/events. Session-replacement safe.
 */
import type { DcpConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { PromptStore } from "./prompts/index.ts";
import type { SessionState } from "./state.ts";

export interface DcpRuntime {
	cwd: string;
	config: DcpConfig;
	logger: Logger;
	prompts: PromptStore;
	state: SessionState;
}
