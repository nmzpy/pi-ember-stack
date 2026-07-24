/**
 * DCP configuration.
 *
 * Lookup order (later wins, shallow-merged top-level + deep-merged nested objects):
 *   1. ~/.pi-dcp/config.json (global default)
 *   2. <cwd>/.pi/dcp.json    (project override)
 *
 * Both files are optional. On first run a starter is written to (1).
 * Malformed JSON is a hard error (fail-fast) so bad overrides are never silent.
 *
 * Adapted from @davecodes/pi-dcp@0.2.0 (AGPL-3.0-or-later).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Permission = "allow" | "ask" | "deny";

export interface DcpConfig {
	enabled: boolean;
	debug: boolean;
	/** "off" | "minimal" | "detailed" — controls /dcp context-style notifications. */
	pruneNotification: "off" | "minimal" | "detailed";
	/**
	 * Protect the most recent N turns from ALL pruning (dedup, purgeErrors,
	 * stored compressions). "Turn" here is bounded by user messages — the last
	 * `turns` user-to-user spans are immune.
	 */
	turnProtection: {
		enabled: boolean;
		turns: number;
	};
	experimental: {
		/**
		 * Enable user-editable prompt overrides under
		 * ~/.pi-dcp/prompts/overrides/. When false (default), the override
		 * directory exists but its contents are ignored. Restart pi after
		 * toggling this.
		 */
		customPrompts: boolean;
	};
	manualMode: {
		/** When true, the compress tool refuses autonomous invocation. */
		enabled: boolean;
		/**
		 * When manualMode.enabled is true, should auto strategies (dedup,
		 * purgeErrors) still run? Default: true — manual mode normally just
		 * silences the LLM, not the housekeeping.
		 */
		automaticStrategies: boolean;
	};
	compress: {
		/**
		 * Compression mode controlling the compress tool's parameter surface.
		 * - "message": tool takes `toolCallIds[]` and compresses individual results.
		 * - "range":   tool takes `startToolCallId` + `endToolCallId` and compresses
		 *             every eligible result in that contiguous span.
		 */
		mode: "range" | "message";
		/** Soft floor of context tokens before the LLM is nudged to compress. */
		minContextLimit: number | string;
		/** Soft ceiling — at/above this we push stronger nudges. */
		maxContextLimit: number | string;
		/**
		 * Per-model override map for `minContextLimit`. Key is `"<provider>/<id>"`
		 * matching `ctx.model.provider`/`ctx.model.id`.
		 */
		modelMinLimits?: Record<string, number | string>;
		/** Per-model override for `maxContextLimit`. Wins over the global. */
		modelMaxLimits?: Record<string, number | string>;
		/** Permission for the `compress` tool. "deny" means do not register it at all. */
		permission: Permission;
		/** Tools whose outputs are never pruned and are appended to compression summaries. */
		protectedTools: string[];
		/** Soft nudge will fire at most once every N turns. */
		nudgeEveryTurns: number;
		/**
		 * Additional throttle: soft nudge fires only every Nth context fetch.
		 * Default: 1 (no extra throttling beyond nudgeEveryTurns).
		 */
		nudgeFrequency: number;
		/**
		 * Start forcing a soft nudge after this many assistant/tool messages have
		 * happened since the last user message. 0 disables this trigger.
		 */
		iterationNudgeThreshold: number;
		/**
		 * Controls the wording strength of the soft nudge.
		 * "soft"   = gentle reminder
		 * "strong" = aggressive language
		 */
		nudgeForce: "soft" | "strong";
	};
	strategies: {
		deduplication: {
			enabled: boolean;
			/** Tools that must never be deduplicated (e.g. write, edit). */
			protectedTools: string[];
		};
		purgeErrors: {
			enabled: boolean;
			/** Number of turns before errored tool call inputs are pruned. */
			turns: number;
			protectedTools: string[];
		};
	};
}

/** Tools that are ALWAYS protected regardless of user config. */
export const ALWAYS_PROTECTED_TOOLS = new Set([
	"compress",
	"write",
	"edit",
	"apply_patch",
	"todo",
	"task",
	"skill",
]);

/**
 * Default config. Tuned for real-world long sessions. Per-model min/max
 * limits below are upstream defaults from pi-dcp 0.2.0 — users override in
 * ~/.pi-dcp/config.json. Prefer model/provider resolution at runtime via
 * resolve_model_limit when available.
 */
export const DEFAULT_CONFIG: DcpConfig = Object.freeze({
	enabled: true,
	debug: false,
	pruneNotification: "minimal",
	experimental: {
		customPrompts: false,
	},
	turnProtection: {
		enabled: true,
		turns: 10,
	},
	manualMode: {
		enabled: false,
		automaticStrategies: true,
	},
	compress: {
		mode: "range",
		minContextLimit: 30_000,
		maxContextLimit: 70_000,
		modelMinLimits: {
			// Upstream default model floors (pi-dcp 0.2.0). Runtime resolution
			// still prefers live ctx.model provider/id when present.
			"anthropic/claude-haiku-4-5": 30_000,
			"anthropic/claude-sonnet-4-5": 50_000,
			"anthropic/claude-sonnet-4-6": 50_000,
			"anthropic/claude-opus-4-1": 35_000,
			"anthropic/claude-opus-4-5": 35_000,
			"anthropic/claude-opus-4-6": 35_000,
			"anthropic/claude-opus-4-7": 35_000,
			"openai/gpt-5.4-mini-fast": 25_000,
			"openai/gpt-5.4-mini": 30_000,
			"openai/gpt-5.5": 45_000,
		},
		modelMaxLimits: {
			"anthropic/claude-haiku-4-5": 70_000,
			"anthropic/claude-sonnet-4-5": 120_000,
			"anthropic/claude-sonnet-4-6": 120_000,
			"anthropic/claude-opus-4-1": 85_000,
			"anthropic/claude-opus-4-5": 85_000,
			"anthropic/claude-opus-4-6": 85_000,
			"anthropic/claude-opus-4-7": 85_000,
			"openai/gpt-5.4-mini-fast": 50_000,
			"openai/gpt-5.4-mini": 70_000,
			"openai/gpt-5.5": 100_000,
		},
		permission: "deny",
		protectedTools: [],
		nudgeEveryTurns: 5,
		nudgeFrequency: 3,
		iterationNudgeThreshold: 8,
		nudgeForce: "strong",
	},
	strategies: {
		deduplication: {
			enabled: true,
			protectedTools: [],
		},
		purgeErrors: {
			enabled: true,
			turns: 2,
			protectedTools: [],
		},
	},
}) as DcpConfig;

/**
 * User-state directory. Independent of where pi installs the extension code.
 * Config, prompts, sessions, and logs always live here.
 */
export const PI_DCP_USER_DIR = path.join(os.homedir(), ".pi-dcp");
const GLOBAL_CONFIG_PATH = path.join(PI_DCP_USER_DIR, "config.json");

function read_json_object(file: string): Partial<DcpConfig> | null {
	if (!fs.existsSync(file)) return null;
	const text = fs.readFileSync(file, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`pi-ember-dcp: malformed JSON in ${file}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`pi-ember-dcp: config root must be a JSON object: ${file}`);
	}
	return parsed as Partial<DcpConfig>;
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deep_merge<T>(base: T, override: Partial<T> | null | undefined): T {
	if (!override) return base;
	if (Array.isArray(base)) {
		return [...(base as unknown[])] as T;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		const base_value = (base as Record<string, unknown>)[key];
		if (is_plain_object(value) && is_plain_object(base_value)) {
			out[key] = deep_merge(base_value, value);
		} else if (value !== undefined) {
			out[key] = value;
		}
	}
	return out as T;
}

/**
 * Write a starter config to ~/.pi-dcp/config.json if one doesn't already
 * exist. Also handles a one-time migration from the legacy install-path
 * config so users who manually cloned the repo before user-state moved
 * don't lose their tuning.
 */
function ensure_starter_config(): void {
	if (fs.existsSync(GLOBAL_CONFIG_PATH)) return;
	fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });

	const legacy_path = path.join(
		os.homedir(),
		".pi",
		"agent",
		"extensions",
		"pi-dcp",
		"config.json",
	);
	if (fs.existsSync(legacy_path) && legacy_path !== GLOBAL_CONFIG_PATH) {
		try {
			fs.copyFileSync(legacy_path, GLOBAL_CONFIG_PATH);
			return;
		} catch {
			// Fall through to writing defaults.
		}
	}

	fs.writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
}

/**
 * Load DCP config for the given workspace cwd.
 * Throws on malformed JSON (fail-fast). Missing files are fine.
 */
export function load_config(cwd: string): DcpConfig {
	ensure_starter_config();
	const global_override = read_json_object(GLOBAL_CONFIG_PATH);
	const project_path = path.join(cwd, ".pi", "dcp.json");
	const project_override = read_json_object(project_path);
	return deep_merge(deep_merge(DEFAULT_CONFIG, global_override), project_override);
}

/**
 * Pick the effective limit for the active model. If `overrides` has a matching
 * `"<provider>/<id>"` entry we use that; otherwise we fall back to the global
 * `global_setting`. The chosen value is then resolved by `resolve_context_limit`.
 */
export function resolve_model_limit(
	global_setting: number | string,
	overrides: Record<string, number | string> | undefined,
	model: { provider?: string; id?: string } | undefined,
	context_window: number | undefined,
): number {
	if (overrides && model?.provider && model?.id) {
		const key = `${model.provider}/${model.id}`;
		if (key in overrides) {
			return resolve_context_limit(overrides[key], context_window);
		}
	}
	return resolve_context_limit(global_setting, context_window);
}

/**
 * Resolve a min/max context-limit setting against the model's context window.
 * Accepts:
 *   - a non-negative number          → used as-is (tokens)
 *   - a percentage string "X%"       → floor(X/100 * contextWindow)
 *   - a bare numeric string "12345"  → parsed as a number
 *
 * Falls back to the model's contextWindow (or 100k as a last resort) when the
 * value is junk.
 */
export function resolve_context_limit(
	setting: number | string,
	context_window: number | undefined,
): number {
	if (typeof setting === "number" && Number.isFinite(setting) && setting >= 0) {
		return setting;
	}
	if (typeof setting === "string") {
		const match = setting.match(/^\s*(\d+(?:\.\d+)?)\s*%\s*$/);
		if (match && context_window && context_window > 0) {
			return Math.floor((Number(match[1]) / 100) * context_window);
		}
		const as_number = Number(setting);
		if (Number.isFinite(as_number) && as_number >= 0) return as_number;
	}
	return context_window && context_window > 0 ? context_window : 100_000;
}
