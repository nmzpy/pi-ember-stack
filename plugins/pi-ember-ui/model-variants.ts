/**
 * Model effort / thinking-variant tokens — SSOT for footer detection,
 * family collapse, and the Switch Model Effort slider.
 */

/** Effort points shown on the Switch Model slider (UI axis only). */
export const EFFORT_SLIDER_POINTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortSliderPoint = (typeof EFFORT_SLIDER_POINTS)[number];

/**
 * Tokens that may be baked into a model id or display name.
 * Includes slider points plus `minimal` / `max` / `no` for detection.
 */
export const THINKING_VARIANT_TOKENS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"no",
] as const;

export type ThinkingVariantToken = (typeof THINKING_VARIANT_TOKENS)[number];

/** Screenshot-style captions under the Effort slider. */
export const EFFORT_DESCRIPTIONS: Record<EffortSliderPoint, string> = {
	low: "Faster responses with lighter reasoning.",
	medium: "Balanced speed and reasoning quality for most tasks.",
	high: "Deeper reasoning for harder problems.",
	xhigh: "Maximum reasoning depth when quality matters most.",
	max: "Highest effort tier for the most demanding work.",
};

const VARIANT_TOKEN_SET = new Set<string>(THINKING_VARIANT_TOKENS);
const EFFORT_SLIDER_SET = new Set<string>(EFFORT_SLIDER_POINTS);

/**
 * Devin / Cognition-style suffixes (level REQUIRED before Thinking):
 *   "High Thinking Fast", "Medium Thinking", "No Thinking"
 *   id: high-thinking-fast, medium-thinking, no-thinking
 * Bare "*-thinking" (Cursor reasoning ids) is intentionally NOT matched.
 */
const THINKING_SUFFIX_RE =
	/(?:^|[-_.\s]+)(no|minimal|low|medium|high|xhigh|max)[-_\s]+thinking(?:[-_\s]+fast)?$/i;

/**
 * Speed-tier suffixes without "Thinking" in the label:
 *   "GPT-5.2-Codex Low Fast", "GPT-5.2-Codex Medium Fast"
 *   id: gpt-5-2-codex-low-fast, gpt-5-2-codex-medium-fast
 */
const LEVEL_FAST_SUFFIX_RE =
	/(?:^|[-_.\s]+)(no|minimal|low|medium|high|xhigh|max)[-_\s]+fast$/i;

/**
 * Standalone product-line suffixes (not effort variants).
 * "Grok 4.5 Fast" is a different model class than "Grok 4.5"; each may have
 * its own effort siblings. Not provider-specific — matched structurally on ids/names.
 */
export const MODEL_CLASS_TOKENS = ["fast", "thinking"] as const;

export type ModelClassToken = (typeof MODEL_CLASS_TOKENS)[number];

const MODEL_CLASS_TOKEN_SET = new Set<string>(MODEL_CLASS_TOKENS);

function model_class_suffix_re(token: string): RegExp {
	return new RegExp(`(?:^|[-_.\\s])${token}$`, "i");
}

const EFFORT_TOKEN_CAPTURE = "(no|minimal|low|medium|high|xhigh|max)";

/** Cursor-style ids: `cursor-grok-4.5-high-fast` paired with `cursor-grok-4.5-high`. */
const FAST_LINE_ID_RE = new RegExp(`^(.*)-${EFFORT_TOKEN_CAPTURE}-fast$`, "i");

/**
 * Ids whose trailing `-{effort}-fast` is a separate Fast model line (not a Devin
 * speed tier) because the same effort exists without `-fast`.
 */
export function build_fast_line_model_ids(
	models: readonly { id: string }[],
): ReadonlySet<string> {
	const idSet = new Set(models.map((m) => m.id.trim().toLowerCase()));
	const fastLine = new Set<string>();
	for (const rawId of idSet) {
		const match = FAST_LINE_ID_RE.exec(rawId);
		if (!match) continue;
		const plain = `${match[1]}-${match[2]}`.toLowerCase();
		if (idSet.has(plain)) fastLine.add(rawId);
	}
	return fastLine;
}

export function is_fast_line_model_id(
	id: string,
	fastLineIds: ReadonlySet<string>,
): boolean {
	return fastLineIds.has(id.trim().toLowerCase());
}

/** Effort token from a Fast-line id (`cursor-grok-4.5-medium-fast` → medium). */
export function effort_from_fast_line_id(id: string): EffortSliderPoint | undefined {
	const match = FAST_LINE_ID_RE.exec(id.trim());
	if (!match) return undefined;
	return variant_to_effort_point(match[2]);
}

/** Drop the trailing `-{effort}-fast` segment from a Fast-line id. */
export function strip_fast_line_id_to_base(id: string): string {
	const match = FAST_LINE_ID_RE.exec(id.trim());
	if (!match) return id.trim();
	return match[1];
}

/**
 * "Cursor Grok 4.5 Medium Fast" → "Cursor Grok 4.5 Fast" (effort stripped, class kept).
 */
export function strip_effort_preserve_fast_class_name(name: string): string {
	const trimmed = name.trim();
	const levelFast = LEVEL_FAST_SUFFIX_RE.exec(trimmed);
	if (levelFast) {
		const level = levelFast[1];
		const re = new RegExp(`${level}[-_\\s]+fast$`, "i");
		if (re.test(trimmed)) {
			return trimmed.replace(re, "Fast").trim();
		}
	}
	return strip_for_family_grouping(trimmed, "fast");
}

/** Standalone trailing model class (e.g. "Fast" in "Grok 4.5 Fast"), not "Low Fast". */
export function extract_model_class_token(idOrName: string): ModelClassToken | undefined {
	const trimmed = idOrName.trim();
	if (!trimmed) return undefined;
	if (THINKING_SUFFIX_RE.test(trimmed)) return undefined;
	if (LEVEL_FAST_SUFFIX_RE.test(trimmed)) return undefined;
	if (/thinking[-_\s]+fast$/i.test(trimmed)) return undefined;
	for (const token of MODEL_CLASS_TOKENS) {
		if (model_class_suffix_re(token).test(trimmed)) return token;
	}
	// Class before a trailing effort suffix: "Grok 4.5 Fast High" / grok-4.5-fast-high
	for (const token of MODEL_CLASS_TOKENS) {
		const before_effort = new RegExp(
			`(?:^|[-_.\\s])${token}[-_.\\s]+(?:minimal|low|medium|high|xhigh|max)$`,
			"i",
		);
		if (before_effort.test(trimmed)) return token;
	}
	return undefined;
}

/** Whether this catalog row is a standalone model-class line (Fast / Thinking), not effort-only. */
export function has_standalone_model_class(model: {
	id: string;
	name?: string;
}): boolean {
	if (extract_model_class_token(model.id)) return true;
	if (model.name && extract_model_class_token(model.name)) return true;
	return false;
}

function format_model_class_label(token: string): string {
	return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/** Reattach model class when the catalog name omits it but the id carries it. */
export function append_model_class_if_missing(base: string, modelClass: string | undefined): string {
	if (!modelClass || !MODEL_CLASS_TOKEN_SET.has(modelClass)) return base;
	if (extract_model_class_token(base)) return base;
	return `${base.trim()} ${format_model_class_label(modelClass)}`;
}

/** Strip effort variants for grouping while preserving standalone model class suffixes. */
export function strip_for_family_grouping(idOrName: string, classHint?: string): string {
	const base = strip_variant_token(idOrName);
	const detectedClass = extract_model_class_token(idOrName) ?? classHint;
	return append_model_class_if_missing(base, detectedClass);
}

/** Normalize id/name separators to spaces for token scanning. */
function normalize_tokens(value: string): string[] {
	const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
	return normalized.split(/\s+/).filter(Boolean);
}

/** Whether `modelName` already contains a standalone thinking variant token. */
export function model_name_has_thinking_variant(modelName: string): boolean {
	const trimmed = modelName.trim();
	if (THINKING_SUFFIX_RE.test(trimmed)) return true;
	if (LEVEL_FAST_SUFFIX_RE.test(trimmed)) return true;
	const tokens = new Set(normalize_tokens(modelName));
	for (const token of THINKING_VARIANT_TOKENS) {
		if (token === "no") continue; // alone "no" is too noisy; require Thinking suffix
		if (tokens.has(token)) return true;
	}
	return false;
}

/** First baked thinking-variant token in a display name/id, or undefined. */
export function get_baked_thinking_variant(modelName: string): string | undefined {
	const fromThinking = extract_variant_token(modelName);
	if (fromThinking && fromThinking !== "no") return fromThinking;
	const tokens = new Set(normalize_tokens(modelName));
	for (const token of THINKING_VARIANT_TOKENS) {
		if (token === "no") continue;
		if (tokens.has(token)) return token;
	}
	return undefined;
}

/**
 * Extract an effort/thinking variant from an id or name.
 * Handles Devin "High Thinking Fast" / "No Thinking", "Medium Fast" speed tiers,
 * and trailing -high suffixes.
 */
export function extract_variant_token(idOrName: string): ThinkingVariantToken | undefined {
	const trimmed = idOrName.trim();
	if (!trimmed) return undefined;

	const thinking = THINKING_SUFFIX_RE.exec(trimmed);
	if (thinking) {
		const level = thinking[1].toLowerCase();
		if (VARIANT_TOKEN_SET.has(level)) return level as ThinkingVariantToken;
	}

	const levelFast = LEVEL_FAST_SUFFIX_RE.exec(trimmed);
	if (levelFast) {
		const level = levelFast[1].toLowerCase();
		if (VARIANT_TOKEN_SET.has(level)) return level as ThinkingVariantToken;
	}

	// Trailing suffix after -, _, ., or whitespace: foo-high, foo_medium, "Foo High"
	const suffix = /(?:^|[-_.\s])(minimal|low|medium|high|xhigh|max)$/i.exec(trimmed);
	if (suffix) {
		const token = suffix[1].toLowerCase() as ThinkingVariantToken;
		if (VARIANT_TOKEN_SET.has(token)) return token;
	}

	// Parenthetical: "GPT-OSS 120B (Medium)"
	const paren = /\(\s*(minimal|low|medium|high|xhigh|max)\s*\)$/i.exec(trimmed);
	if (paren) {
		const token = paren[1].toLowerCase() as ThinkingVariantToken;
		if (VARIANT_TOKEN_SET.has(token)) return token;
	}

	return undefined;
}

/**
 * Strip effort/thinking variant suffixes from an id or name for family grouping.
 * "GPT-5.2 High Thinking Fast" → "GPT-5.2"
 * "GPT-5.2-Codex Medium Fast" → "GPT-5.2-Codex"
 * "claude-opus-4-7-medium" → "claude-opus-4-7"
 */
export function strip_variant_token(idOrName: string): string {
	const trimmed = idOrName.trim();
	if (!trimmed) return trimmed;

	const withoutThinking = trimmed.replace(THINKING_SUFFIX_RE, "");
	if (withoutThinking !== trimmed && withoutThinking.trim().length > 0) {
		return withoutThinking.trim().replace(/[-_.\s]+$/g, "").trim();
	}

	const withoutLevelFast = trimmed.replace(LEVEL_FAST_SUFFIX_RE, "");
	if (withoutLevelFast !== trimmed && withoutLevelFast.trim().length > 0) {
		return withoutLevelFast.trim().replace(/[-_.\s]+$/g, "").trim();
	}

	const withoutParen = trimmed.replace(/\s*\(\s*(minimal|low|medium|high|xhigh|max)\s*\)$/i, "");
	if (withoutParen !== trimmed) return withoutParen.trim();

	const withoutSuffix = trimmed.replace(/[-_.\s]+(minimal|low|medium|high|xhigh|max)$/i, "");
	if (withoutSuffix !== trimmed && withoutSuffix.length > 0) return withoutSuffix.trim();

	return trimmed;
}

/** True when this model id/name is a "Fast" speed variant (Thinking Fast or Level Fast). */
export function is_thinking_fast_variant(idOrName: string): boolean {
	const t = idOrName.trim();
	return /thinking[-_\s]+fast$/i.test(t) || LEVEL_FAST_SUFFIX_RE.test(t);
}

/** Map a detection token onto an Effort slider point when possible. */
export function variant_to_effort_point(
	token: string | undefined,
): EffortSliderPoint | undefined {
	if (!token) return undefined;
	const lower = token.toLowerCase();
	if (lower === "no") return undefined; // "No Thinking" — not a slider tick
	if (EFFORT_SLIDER_SET.has(lower)) return lower as EffortSliderPoint;
	return undefined;
}

/** True when `point` is one of the Effort slider ticks. */
export function is_effort_slider_point(value: string): value is EffortSliderPoint {
	return EFFORT_SLIDER_SET.has(value);
}

/** Title-case effort label for inline display (`high` → `High`, `xhigh` → `xHigh`). */
export function format_effort_display_label(point: EffortSliderPoint): string {
	if (point === "xhigh") return "xHigh";
	if (point === "max") return "Max";
	return point.charAt(0).toUpperCase() + point.slice(1);
}

/**
 * Effort level for footer display: Pi thinking level when set, otherwise
 * effort baked into the active catalog model id/name (sibling catalogs).
 */
export function resolve_model_effort_level(
	model: { id?: string; name?: string } | undefined,
	thinkingLevel = "off",
): EffortSliderPoint | "off" {
	const normalized = (thinkingLevel ?? "off").toLowerCase();
	if (normalized !== "off" && is_effort_slider_point(normalized)) {
		return normalized;
	}
	if (!model) return "off";

	const baked = get_baked_thinking_variant(model.name ?? "");
	if (baked && is_effort_slider_point(baked)) return baked;

	const fromFastLine = model.id ? effort_from_fast_line_id(model.id) : undefined;
	if (fromFastLine) return fromFastLine;

	const fromId = variant_to_effort_point(extract_variant_token(model.id ?? ""));
	if (fromId) return fromId;

	return "off";
}

/** Caption for an effort point (fallback empty). */
export function effort_description(point: EffortSliderPoint): string {
	return EFFORT_DESCRIPTIONS[point] ?? "";
}
