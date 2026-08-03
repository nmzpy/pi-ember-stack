import type { Api, Model } from "@earendil-works/pi-ai";
import { has_baked_effort_variant } from "../pi-ember-ui/model-variants.ts";

/** Per-mode model binding persisted in `pi-ember-stack.json`. */
export type ModelIdentity = {
	readonly provider: string;
	readonly modelId: string;
	/** Effort / thinking level when the model uses `setThinkingLevel` (not baked variants). */
	readonly thinkingLevel?: string;
};

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function normalize_thinking_level(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const level = raw.trim().toLowerCase();
	return THINKING_LEVELS.has(level) ? level : undefined;
}

export function get_pi_thinking_level(pi: {
	getThinkingLevel?: () => string;
}): string | undefined {
	const level = pi.getThinkingLevel?.();
	return normalize_thinking_level(level);
}

type IdentityModelShape = {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
};

/**
 * Canonical per-mode binding: exact catalog id always; thinkingLevel only when
 * effort is not baked into the catalog row (family collapse / dedup SSOT).
 */
export function canonical_model_identity(
	model: IdentityModelShape | undefined,
	thinkingLevel?: string,
): ModelIdentity | undefined {
	if (!model) return undefined;
	const identity: ModelIdentity = { provider: model.provider, modelId: model.id };
	if (has_baked_effort_variant(model)) return identity;
	const level = normalize_thinking_level(thinkingLevel);
	return level ? { ...identity, thinkingLevel: level } : identity;
}

export function model_identity_of(
	model: Model<Api> | undefined,
	thinkingLevel?: string,
): ModelIdentity | undefined {
	if (!model) return undefined;
	return canonical_model_identity(
		{ provider: model.provider, id: model.id, name: model.name },
		thinkingLevel,
	);
}

export function canonicalize_persisted_identity(identity: ModelIdentity): ModelIdentity {
	return (
		canonical_model_identity(
			{ provider: identity.provider, id: identity.modelId },
			identity.thinkingLevel,
		) ?? identity
	);
}

export function identities_equal(a?: ModelIdentity, b?: ModelIdentity): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	const ca = canonicalize_persisted_identity(a);
	const cb = canonicalize_persisted_identity(b);
	if (ca.provider !== cb.provider || ca.modelId !== cb.modelId) return false;
	return (ca.thinkingLevel ?? undefined) === (cb.thinkingLevel ?? undefined);
}

export function normalize_mode_models(raw: unknown): Partial<Record<string, ModelIdentity>> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	const result: Partial<Record<string, ModelIdentity>> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof (value as Record<string, unknown>).provider === "string" &&
			typeof (value as Record<string, unknown>).modelId === "string"
		) {
			const record = value as Record<string, unknown>;
			const thinkingLevel = normalize_thinking_level(record.thinkingLevel);
			result[key] = canonicalize_persisted_identity({
				provider: record.provider as string,
				modelId: record.modelId as string,
				...(thinkingLevel ? { thinkingLevel } : {}),
			});
		}
	}
	return result;
}

export function get_mode_model(
	modeModels: Partial<Record<string, ModelIdentity>>,
	modeId: string,
): ModelIdentity | undefined {
	return modeModels[modeId];
}

export function bind_mode_model(
	modeModels: Partial<Record<string, ModelIdentity>>,
	modeId: string,
	identity: ModelIdentity,
): Partial<Record<string, ModelIdentity>> {
	return { ...modeModels, [modeId]: canonicalize_persisted_identity(identity) };
}

/** Whether effort is encoded in the bound catalog id (skip setThinkingLevel on restore). */
export function bound_identity_uses_baked_effort(bound: ModelIdentity): boolean {
	return has_baked_effort_variant({ id: bound.modelId });
}

/** Event name for explicit per-mode model binds (after picker applies model + effort). */
export const PI_AGENTS_BIND_MODE_MODEL_EVENT = "pi-agents:bind-mode-model";

/** Canonical identity after Switch Model / `/model` apply (picker SSOT). */
export function model_identity_from_user_selection(
	model: IdentityModelShape,
	options?: { thinkingLevel?: string; syncThinkingLevelToPi?: boolean },
): ModelIdentity | undefined {
	return canonical_model_identity(
		model,
		options?.syncThinkingLevelToPi ? options.thinkingLevel : undefined,
	);
}

/** Whether live model + thinking level already match a persisted binding. */
export function bound_model_matches_live(
	bound: ModelIdentity,
	current: Model<Api> | undefined,
	currentThinkingLevel?: string,
): boolean {
	const live = model_identity_of(current, currentThinkingLevel);
	return identities_equal(bound, live);
}
