/**
 * Collapse same-provider baked effort variants into families for the
 * Switch Model overlay. Pure helpers — no TUI.
 */

import {
	type EffortSliderPoint,
	EFFORT_SLIDER_POINTS,
	build_fast_line_model_ids,
	effort_from_fast_line_id,
	extract_model_class_token,
	extract_variant_token,
	has_standalone_model_class,
	is_effort_slider_point,
	is_fast_line_model_id,
	is_thinking_fast_variant,
	strip_effort_preserve_fast_class_name,
	strip_fast_line_id_to_base,
	strip_for_family_grouping,
	variant_to_effort_point,
} from "./model-variants.ts";

/** Minimal model shape from Pi's registry / ProviderModelConfig. */
export interface FamilyModel {
	provider: string;
	id: string;
	name?: string;
	/** Optional Pi thinkingLevelMap: level → provider wire value (null = unsupported). */
	thinkingLevelMap?: Record<string, string | null | undefined>;
	reasoning?: boolean;
}

export type ModelFamilyKind = "sibling" | "thinking" | "none";

export interface ModelFamily {
	/** Stable key: `${provider}::${familyKey}` (or unique suffix for leftovers). */
	key: string;
	provider: string;
	/** Stripped id used for grouping within a provider. */
	familyKey: string;
	/** Display label without effort suffix. */
	displayName: string;
	kind: ModelFamilyKind;
	/** Base / representative model (always set). */
	baseModel: FamilyModel;
	/** Effort → sibling catalog entry (sibling kind only). */
	variants: Partial<Record<EffortSliderPoint, FamilyModel>>;
	/** Slider points this family supports (≥2 to show the Effort row). */
	efforts: EffortSliderPoint[];
}

export interface FamilySelection {
	model: FamilyModel;
	thinkingLevel?: EffortSliderPoint;
	/** When true, call `pi.setThinkingLevel` after `setModel` (thinkingLevelMap families). */
	syncThinkingLevelToPi?: boolean;
}

function normalize_family_key(idOrName: string): string {
	return strip_for_family_grouping(idOrName)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Label used for family keys and display — preserves model class (e.g. Fast). */
function grouping_label_for(
	model: FamilyModel,
	fastLineIds: ReadonlySet<string>,
): string {
	const name = model.name?.trim();
	const id = model.id.trim();

	if (is_fast_line_model_id(id, fastLineIds)) {
		if (name) return strip_effort_preserve_fast_class_name(name);
		return strip_for_family_grouping(strip_fast_line_id_to_base(id), "fast");
	}

	const idClass = extract_model_class_token(id);
	if (name && extract_variant_token(name) !== undefined) {
		return strip_for_family_grouping(name, idClass);
	}
	if (extract_variant_token(id) !== undefined) {
		return strip_for_family_grouping(id, idClass);
	}
	if (name) {
		return strip_for_family_grouping(name, idClass);
	}
	return strip_for_family_grouping(id);
}

/** Prefer name-derived key when a thinking/effort variant is present so labels group. */
function family_key_for(model: FamilyModel, fastLineIds: ReadonlySet<string>): string {
	return normalize_family_key(grouping_label_for(model, fastLineIds));
}

function display_name_for(model: FamilyModel, fastLineIds: ReadonlySet<string>): string {
	const label = grouping_label_for(model, fastLineIds);
	return label || model.id;
}

function effort_from_model(
	model: FamilyModel,
	fastLineIds: ReadonlySet<string>,
): EffortSliderPoint | undefined {
	if (is_fast_line_model_id(model.id, fastLineIds)) {
		return effort_from_fast_line_id(model.id);
	}
	const fromId = variant_to_effort_point(extract_variant_token(model.id));
	if (fromId) return fromId;
	if (model.name) {
		return variant_to_effort_point(extract_variant_token(model.name));
	}
	return undefined;
}

/** Prefer Thinking Fast over plain Thinking when both map to the same effort. */
function prefer_sibling(existing: FamilyModel, candidate: FamilyModel): FamilyModel {
	const existingFast =
		is_thinking_fast_variant(existing.name ?? "") ||
		is_thinking_fast_variant(existing.id);
	const candidateFast =
		is_thinking_fast_variant(candidate.name ?? "") ||
		is_thinking_fast_variant(candidate.id);
	if (candidateFast && !existingFast) return candidate;
	return existing;
}

/** Levels from thinkingLevelMap that are Effort slider points with a non-null mapping. */
export function efforts_from_thinking_level_map(
	map: Record<string, string | null | undefined> | undefined,
): EffortSliderPoint[] {
	if (!map) return [];
	const out: EffortSliderPoint[] = [];
	for (const point of EFFORT_SLIDER_POINTS) {
		if (Object.hasOwn(map, point) && map[point] != null) {
			out.push(point);
		}
	}
	return out;
}

/**
 * Optional override: available thinking levels from Pi session API.
 * Used only when the model has no usable thinkingLevelMap entries.
 */
export function efforts_from_available_levels(
	levels: readonly string[] | undefined,
): EffortSliderPoint[] {
	if (!levels || levels.length === 0) return [];
	const set = new Set(levels.map((l) => l.toLowerCase()));
	return EFFORT_SLIDER_POINTS.filter((p) => set.has(p));
}

function make_none_family(
	model: FamilyModel,
	key: string,
	familyKey: string,
	fastLineIds: ReadonlySet<string>,
): ModelFamily {
	return {
		key,
		provider: model.provider,
		familyKey,
		displayName: display_name_for(model, fastLineIds),
		kind: "none",
		baseModel: model,
		variants: {},
		efforts: [],
	};
}

/**
 * Build collapsed families from a flat catalog.
 *
 * - ≥2 siblings with distinct effort suffixes → kind "sibling"
 * - Single model with ≥2 effort points via thinkingLevelMap → "thinking"
 * - Else → "none" (no Effort slider)
 *
 * `availableThinkingLevels` is applied only to a single-model bucket that has
 * `reasoning: true` and no thinkingLevelMap (session API fallback).
 */
export function build_model_families(
	models: readonly FamilyModel[],
	options?: { availableThinkingLevels?: readonly string[] },
): ModelFamily[] {
	const fastLineIds = build_fast_line_model_ids(models);
	const buckets = new Map<string, FamilyModel[]>();
	for (const model of models) {
		const familyKey = family_key_for(model, fastLineIds);
		const bucketKey = `${model.provider.toLowerCase()}::${familyKey}`;
		const list = buckets.get(bucketKey);
		if (list) list.push(model);
		else buckets.set(bucketKey, [model]);
	}

	const families: ModelFamily[] = [];
	for (const [bucketKey, group] of buckets) {
		const familyKey = bucketKey.slice(bucketKey.indexOf("::") + 2);

		const variants: Partial<Record<EffortSliderPoint, FamilyModel>> = {};
		for (const model of group) {
			const effort = effort_from_model(model, fastLineIds);
			if (!effort) continue;
			const existing = variants[effort];
			variants[effort] = existing ? prefer_sibling(existing, model) : model;
		}
		const distinctEfforts = EFFORT_SLIDER_POINTS.filter((p) => variants[p] != null);

		// Collapse when ≥2 catalog rows share a base and we resolved ≥2 efforts,
		// OR when ≥2 rows share a base and at least one carries a thinking/effort
		// suffix (so "No Thinking" + "Low/Medium/High Thinking*" still fold).
		const hasVariantSuffix = group.some(
			(m) =>
				extract_variant_token(m.id) !== undefined ||
				(m.name ? extract_variant_token(m.name) !== undefined : false) ||
				is_fast_line_model_id(m.id, fastLineIds),
		);
		if (group.length >= 2 && distinctEfforts.length >= 2 && hasVariantSuffix) {
			const baseModel =
				group.find((m) => effort_from_model(m, fastLineIds) === undefined) ??
				variants.medium ??
				variants[distinctEfforts[0]] ??
				group[0];
			families.push({
				key: bucketKey,
				provider: group[0].provider,
				familyKey,
				displayName: display_name_for(baseModel, fastLineIds),
				kind: "sibling",
				baseModel,
				variants,
				efforts: distinctEfforts,
			});
			continue;
		}

		if (group.length === 1) {
			const model = group[0];
			const mapEfforts = efforts_from_thinking_level_map(model.thinkingLevelMap);
			const thinkingEfforts =
				mapEfforts.length >= 2
					? mapEfforts
					: model.reasoning && !has_standalone_model_class(model)
						? efforts_from_available_levels(options?.availableThinkingLevels)
						: [];

			if (thinkingEfforts.length >= 2) {
				families.push({
					key: bucketKey,
					provider: model.provider,
					familyKey,
					displayName: display_name_for(model, fastLineIds),
					kind: "thinking",
					baseModel: model,
					variants: {},
					efforts: thinkingEfforts,
				});
			} else {
				families.push(make_none_family(model, bucketKey, familyKey, fastLineIds));
			}
			continue;
		}

		// Multiple catalog rows that did not form an effort sibling family —
		// keep each as its own row so nothing disappears from the picker.
		for (const model of group) {
			const mk = family_key_for(model, fastLineIds);
			const key = `${model.provider.toLowerCase()}::${mk}::${model.id.toLowerCase()}`;
			families.push(make_none_family(model, key, mk, fastLineIds));
		}
	}

	families.sort((a, b) => {
		const p = a.provider.localeCompare(b.provider);
		if (p !== 0) return p;
		return a.displayName.localeCompare(b.displayName);
	});
	return families;
}

/** Pick nearest available effort when `preferred` is missing. */
export function nearest_effort(
	efforts: readonly EffortSliderPoint[],
	preferred: EffortSliderPoint | undefined,
): EffortSliderPoint | undefined {
	if (efforts.length === 0) return undefined;
	if (preferred && efforts.includes(preferred)) return preferred;
	if (efforts.includes("medium")) return "medium";
	return efforts[0];
}

/**
 * Resolve family + effort into a concrete model (and optional thinking level).
 */
export function resolve_family_selection(
	family: ModelFamily,
	effort: EffortSliderPoint | undefined,
): FamilySelection {
	const selected = nearest_effort(family.efforts, effort);

	if (family.kind === "sibling") {
		const model =
			(selected ? family.variants[selected] : undefined) ?? family.baseModel;
		return selected ? { model, thinkingLevel: selected } : { model };
	}

	if (family.kind === "thinking" && selected) {
		return {
			model: family.baseModel,
			thinkingLevel: selected,
			syncThinkingLevelToPi: true,
		};
	}

	return { model: family.baseModel };
}

/** Whether this family contains the live session model. */
export function family_contains_model(
	family: ModelFamily,
	provider: string | undefined,
	modelId: string | undefined,
): boolean {
	if (!provider || !modelId) return false;
	const p = provider.toLowerCase();
	const id = modelId.toLowerCase();
	if (
		family.baseModel.provider.toLowerCase() === p &&
		family.baseModel.id.toLowerCase() === id
	) {
		return true;
	}
	for (const model of Object.values(family.variants)) {
		if (!model) continue;
		if (model.provider.toLowerCase() === p && model.id.toLowerCase() === id) {
			return true;
		}
	}
	return false;
}

/** Initial effort for a family given the current model / thinking level. */
export function initial_effort_for_family(
	family: ModelFamily,
	current?: { provider?: string; id?: string; name?: string; thinkingLevel?: string },
): EffortSliderPoint | undefined {
	if (family.efforts.length === 0) return undefined;

	if (current && family_contains_model(family, current.provider, current.id)) {
		if (family.kind === "sibling") {
			const p = current.provider?.toLowerCase();
			const id = current.id?.toLowerCase();
			for (const point of family.efforts) {
				const variant = family.variants[point];
				if (
					variant &&
					variant.provider.toLowerCase() === p &&
					variant.id.toLowerCase() === id
				) {
					return point;
				}
			}
			if (
				family.baseModel.provider.toLowerCase() === p &&
				family.baseModel.id.toLowerCase() === id
			) {
				return nearest_effort(family.efforts, undefined);
			}
		}
		if (family.kind === "thinking" && current.thinkingLevel) {
			const level = current.thinkingLevel.toLowerCase();
			if (is_effort_slider_point(level)) {
				return nearest_effort(family.efforts, level);
			}
		}
	}

	return nearest_effort(family.efforts, "medium");
}
