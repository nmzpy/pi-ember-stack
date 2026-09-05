import type { Api, Model } from "@earendil-works/pi-ai";
import { has_baked_effort_variant } from "../pi-ember-ui/model-variants.ts";
import { OPENROUTER_PROVIDER_AUTO, live_openrouter_provider } from "../pi-ember-ui/openrouter-routing.ts";

/** Per-mode model binding persisted in `pi-ember-stack.json`. */
export type ModelIdentity = {
	readonly provider: string;
	readonly modelId: string;
	/** Effort / thinking level when the model uses `setThinkingLevel` (not baked variants). */
	readonly thinkingLevel?: string;
	/**
	 * OpenRouter upstream provider slug (e.g. `anthropic`, `amazon-bedrock/us`) when
	 * the user pinned a specific upstream via the model picker's second step. The
	 * sentinel `OPENROUTER_PROVIDER_AUTO` (or omitted) means "let OpenRouter route".
	 * Only meaningful for `provider === "openrouter"` models; ignored otherwise.
	 * Stored here so a mode switch re-applies the same upstream, and re-selecting
	 * the model later defaults to the last-used provider.
	 */
	readonly openRouterProvider?: string;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalize_thinking_level(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const level = raw.trim().toLowerCase();
	return THINKING_LEVELS.has(level) ? level : undefined;
}

export function get_pi_thinking_level(pi: { getThinkingLevel?: () => string }): string | undefined {
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
 * `openRouterProvider` is preserved verbatim when the model is an OpenRouter
 * model and the value is a non-empty string distinct from the Auto sentinel.
 */
export function canonical_model_identity(
	model: IdentityModelShape | undefined,
	thinkingLevel?: string,
	openRouterProvider?: string,
): ModelIdentity | undefined {
	if (!model) return undefined;
	const identity: ModelIdentity = { provider: model.provider, modelId: model.id };
	const trimmedProvider =
		typeof openRouterProvider === "string" ? openRouterProvider.trim() : undefined;
	const openRouterTag =
		model.provider === "openrouter" &&
		trimmedProvider &&
		trimmedProvider !== OPENROUTER_PROVIDER_AUTO
			? trimmedProvider
			: undefined;
	if (has_baked_effort_variant(model)) {
		return openRouterTag ? { ...identity, openRouterProvider: openRouterTag } : identity;
	}
	const level = normalize_thinking_level(thinkingLevel);
	if (level && openRouterTag) {
		return { ...identity, thinkingLevel: level, openRouterProvider: openRouterTag };
	}
	if (level) return { ...identity, thinkingLevel: level };
	if (openRouterTag) return { ...identity, openRouterProvider: openRouterTag };
	return identity;
}

export function model_identity_of(
	model: Model<Api> | undefined,
	thinkingLevel?: string,
	openRouterProvider?: string,
): ModelIdentity | undefined {
	if (!model) return undefined;
	return canonical_model_identity(
		{ provider: model.provider, id: model.id, name: model.name },
		thinkingLevel,
		openRouterProvider,
	);
}

export function canonicalize_persisted_identity(identity: ModelIdentity): ModelIdentity {
	return (
		canonical_model_identity(
			{ provider: identity.provider, id: identity.modelId },
			identity.thinkingLevel,
			identity.openRouterProvider,
		) ?? identity
	);
}

export function identities_equal(a?: ModelIdentity, b?: ModelIdentity): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	const ca = canonicalize_persisted_identity(a);
	const cb = canonicalize_persisted_identity(b);
	if (ca.provider !== cb.provider || ca.modelId !== cb.modelId) return false;
	if ((ca.thinkingLevel ?? undefined) !== (cb.thinkingLevel ?? undefined)) return false;
	return (ca.openRouterProvider ?? undefined) === (cb.openRouterProvider ?? undefined);
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
		const rawOpenRouterProvider =
			typeof record.openRouterProvider === "string" ? record.openRouterProvider.trim() : undefined;
		result[key] = canonicalize_persisted_identity({
			provider: record.provider as string,
			modelId: record.modelId as string,
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(rawOpenRouterProvider ? { openRouterProvider: rawOpenRouterProvider } : {}),
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
	options?: {
		thinkingLevel?: string;
		syncThinkingLevelToPi?: boolean;
		openRouterProvider?: string;
	},
): ModelIdentity | undefined {
	return canonical_model_identity(
		model,
		options?.syncThinkingLevelToPi ? options.thinkingLevel : undefined,
		options?.openRouterProvider,
	);
}

/**
 * Whether live model + thinking level already match a persisted binding.
 * For OpenRouter models the live upstream provider baked into
 * `compat.openRouterRouting.only[0]` is compared against the bound
 * `openRouterProvider` so a mode switch re-applies a different upstream even
 * when the model id is unchanged.
 */
export function bound_model_matches_live(
	bound: ModelIdentity,
	current: Model<Api> | undefined,
	currentThinkingLevel?: string,
): boolean {
	const live = model_identity_of(current, currentThinkingLevel, live_openrouter_provider(current));
	return identities_equal(bound, live);
}
