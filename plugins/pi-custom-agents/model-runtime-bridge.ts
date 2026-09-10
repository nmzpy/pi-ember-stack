/**
 * ModelRegistry → canonical ModelRuntime bridge (SSOT).
 *
 * Pi 0.80.10+ exposes `ModelRegistry` to extensions as a synchronous
 * compatibility facade over the canonical `ModelRuntime`, and
 * `createAgentSession` consumes `ModelRuntime` directly. Pi 0.80.6 instead
 * ships a self-contained `ModelRegistry` (authStorage + modelsJsonPath) and
 * `createAgentSession` accepts `modelRegistry` directly. Detect which API is
 * available here so both consumers work against either installed Pi version
 * without copying credentials or rebuilding provider catalogs.
 *
 * Consumers:
 * - the subagent runner (child sessions inherit the parent runtime so every
 *   registered provider, credential source, and custom `models.json` entry is
 *   available);
 * - the Ember compaction wiring (the summarizer must stream through the same
 *   runtime — the global pi-ai `completeSimple`/`streamSimple` dispatcher does
 *   NOT see extension-registered providers, and only the streaming path emits
 *   the deltas the footer TPS meter taps).
 *
 * Never duplicate this detection in another module.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

interface ModelRegistryRuntimeBridge {
	readonly runtime?: unknown;
}

interface ModelRegistryLegacy {
	readonly authStorage?: unknown;
	readonly modelsJsonPath?: string;
}

/** The canonical ModelRuntime's streaming entry point. */
type ModelRuntimeStreamSimple = {
	streamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
};

/** Canonical `ModelRuntime` behind Pi's extension-facing registry facade, or
 *  undefined on legacy Pi where the registry itself is the runtime. */
export function resolve_parent_model_runtime(model_registry: ModelRegistry | undefined): unknown {
	if (!model_registry) return undefined;
	const bridge = model_registry as unknown as ModelRegistryRuntimeBridge;
	if (bridge.runtime) return bridge.runtime;
	// Pi 0.80.6: no runtime field — createAgentSession accepts modelRegistry
	// directly. Return undefined so the caller skips the modelRuntime option.
	return undefined;
}

/** Whether the registry is the legacy self-contained Pi 0.80.6 registry. */
export function is_legacy_model_registry(model_registry: ModelRegistry): boolean {
	const legacy = model_registry as unknown as ModelRegistryLegacy;
	return (
		!(model_registry as unknown as ModelRegistryRuntimeBridge).runtime &&
		Boolean(legacy.authStorage || legacy.modelsJsonPath !== undefined)
	);
}

/**
 * A `StreamFn` over the canonical ModelRuntime (auth resolution, provider
 * composition, base-URL overrides, custom provider transports), or undefined
 * when no runtime facade exists. Callers that accept an optional `streamFn`
 * (`run_stack_compaction`) use it so their LLM call streams through the same
 * runtime as the agent loop instead of the global pi-ai dispatcher.
 */
export function resolve_runtime_stream_simple(
	model_registry: ModelRegistry | undefined,
): StreamFn | undefined {
	const runtime = resolve_parent_model_runtime(model_registry) as
		| ModelRuntimeStreamSimple
		| undefined;
	if (!runtime || typeof runtime.streamSimple !== "function") return undefined;
	return (model, context, options) => runtime.streamSimple(model, context, options);
}
