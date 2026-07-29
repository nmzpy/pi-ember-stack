import type { Model } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	ExtensionRunner,
	type SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	Editor,
	fuzzyFilter,
	getKeybindings,
	SelectList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	finalize_editor_input_after,
	reset_slash_command_tracking,
	sync_slash_command_active,
} from "./layout.ts";
import { refresh_footer, set_footer_thinking_level } from "./footer.ts";
import {
	PI_AGENTS_BIND_MODE_MODEL_EVENT,
	model_identity_from_user_selection,
} from "../pi-custom-agents/mode-models.ts";
import {
	bind_picker_editor,
	close_model_picker,
	consumes_picker_key,
	extract_model_command_search,
	handle_model_picker_input,
	is_model_picker_active,
	normalize_picker_filter,
	on_model_picker_filter_changed,
	open_model_picker_in_editor,
	should_route_model_slash_to_picker,
} from "./model-selector.ts";
import type { EffortSliderPoint } from "./model-variants.ts";
import { format_model_effort_suffix } from "./model-variants.ts";
import { buildSelectListTheme, resolve_select_list_theme } from "./select-list-theme.ts";
import {
	get_switch_session_fn,
	install_command_context_capture,
	resolve_switch_session_fn,
} from "./command-context-capture.ts";
import { find_exact_model_reference } from "./model-reference.ts";

export { find_exact_model_reference } from "./model-reference.ts";
export {
	extract_model_command_search,
	should_route_model_slash_to_picker,
} from "./model-selector.ts";

/** Same layout Pi uses for slash-command autocomplete rows. */
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/** Resume layout: allow conversation titles to use up to half the terminal
 *  width (mirrors the subagent `TOOL_ROW_WIDTH_FRACTION` = 0.5 compact-row
 *  threshold) so long titles wrap after the middle of the screen, not a
 *  narrow quarter. The description still gets the right-hand side.
 */
const RESUME_SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: Number.POSITIVE_INFINITY,
	truncatePrimary: (context: { text: string; maxWidth: number; columnWidth: number }) =>
		truncateToWidth(context.text, Math.min(context.maxWidth, Math.floor(context.columnWidth * 0.5))),
};

/**
 * Max visible rows in editor entry pickers (slash commands, /resume, etc.).
 * Pi defaults to 5 via `autocompleteMaxVisible`; 7 reads less cramped.
 * SSOT for all SelectLists created through the createAutocompleteList patch.
 */
export const AUTOCOMPLETE_MAX_VISIBLE = 7;

const MODEL_PREFIX = "/model";
const RESUME_PREFIX = "/resume";
const SESSION_CACHE_TTL_MS = 5_000;
const FIRST_MESSAGE_PREVIEW_LEN = 48;

export type ModelPickResult =
	| {
			provider: string;
			id: string;
			thinkingLevel?: EffortSliderPoint;
			syncThinkingLevelToPi?: boolean;
	  }
	| undefined;

type PendingModelPick = {
	resolve: (result: ModelPickResult) => void;
};

let model_picker_ctx: any;
let model_picker_pi: ExtensionAPI | undefined;
let live_editor: any;
let pending_pick: PendingModelPick | null = null;
/** True while the in-editor Switch Model list is open. */
let model_selector_busy = false;
const EMBER_PATCH_MARKER = Symbol.for("pi-ember-ui:model-picker-patched");
/** Per-editor native submit — instance patch may differ from Editor.prototype. */
const NATIVE_SUBMIT_KEY = Symbol.for("pi-ember-ui:native-submit");
/** Pre-patch Editor.submitValue fallback when instance key is missing. */
let native_editor_submit_value: ((this: Editor) => void) | undefined;

/** Cached session list for /resume argument completions (refreshed on open + TTL). */
let session_cache: SessionInfo[] | null = null;
let session_cache_at = 0;
let session_cache_loading: Promise<SessionInfo[]> | null = null;

export function cancel_pending_model_pick(): void {
	if (!pending_pick) return;
	pending_pick.resolve(undefined);
	pending_pick = null;
}

function editor_is_showing_autocomplete(editor: any): boolean {
	return editor.isShowingAutocomplete?.() === true;
}

function request_editor_render(editor: any): void {
	editor?.tui?.requestRender?.();
}

/** Request slash-command argument completions (e.g. /model provider/id). */
function trigger_slash_argument_autocomplete(editor: any): void {
	// Never simulate Tab via handleInput(keyName): custom bindings like ctrl+space
	// are not real terminal sequences and get inserted as literal editor text.
	const request = editor.requestAutocomplete;
	if (typeof request === "function") {
		request.call(editor, { force: false, explicitTab: true });
	}
}

/** Open a slash command + optional arg search inside the editor chat pill. */
function open_slash_autocomplete(editor: any, command: string, initialSearch = ""): void {
	live_editor = editor;
	const text = initialSearch ? `${command} ${initialSearch}` : `${command} `;
	editor.setText?.(text);
	sync_slash_command_active(editor);
	trigger_slash_argument_autocomplete(editor);
	request_editor_render(editor);
}

/** Open /resume session argument autocomplete (chat-pill). */
export function open_resume_autocomplete(editor: any, initialSearch = ""): void {
	void refresh_session_cache({ force: true });
	open_slash_autocomplete(editor, RESUME_PREFIX, initialSearch);
}

async function apply_model_selection(
	pi: ExtensionAPI,
	ctx: any,
	selection: {
		provider: string;
		id: string;
		thinkingLevel?: EffortSliderPoint;
		syncThinkingLevelToPi?: boolean;
	},
): Promise<boolean> {
	const models = ctx.modelRegistry.getAvailable();
	const model = find_exact_model_reference(`${selection.provider}/${selection.id}`, models);
	if (!model) {
		ctx.ui.notify(`Model not found: ${selection.provider}/${selection.id}`, "error");
		return false;
	}
	try {
		await pi.setModel(model as Model<any>);
		if (selection.thinkingLevel) {
			set_footer_thinking_level(selection.thinkingLevel);
			if (selection.syncThinkingLevelToPi) {
				const setLevel = (pi as { setThinkingLevel?: (level: string) => Promise<void> | void })
					.setThinkingLevel;
				if (typeof setLevel === "function") {
					await setLevel.call(pi, selection.thinkingLevel);
				}
			}
		} else {
			const piLevel = (pi as { getThinkingLevel?: () => string }).getThinkingLevel?.() ?? "off";
			set_footer_thinking_level(piLevel);
		}
		refresh_footer(ctx);
		const identity = model_identity_from_user_selection(
			{ provider: model.provider, id: model.id, name: model.name },
			{
				thinkingLevel: selection.thinkingLevel,
				syncThinkingLevelToPi: selection.syncThinkingLevelToPi,
			},
		);
		if (identity) {
			pi.events.emit(PI_AGENTS_BIND_MODE_MODEL_EVENT, {
				provider: identity.provider,
				modelId: identity.modelId,
				name: model.name,
				thinkingLevel: identity.thinkingLevel,
				syncThinkingLevelToPi: selection.syncThinkingLevelToPi,
			});
		}
		const effortHint = format_model_effort_suffix(
			{ id: model.id, name: model.name },
			selection.thinkingLevel,
		);
		ctx.ui.notify(`Model: ${model.id}${effortHint} • ${model.provider}`, "info");
		return true;
	} catch (err) {
		ctx.ui.notify(
			`Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return false;
	}
}

async function apply_model_from_command(
	pi: ExtensionAPI,
	ctx: any,
	searchTerm: string,
): Promise<void> {
	const models = ctx.modelRegistry.getAvailable();
	const model = find_exact_model_reference(searchTerm, models);
	if (!model) return;
	await apply_model_selection(pi, ctx, { provider: model.provider, id: model.id });
}

function resolve_pending_pick(searchTerm: string): ModelPickResult {
	if (!model_picker_ctx || !searchTerm) return undefined;
	const models = model_picker_ctx.modelRegistry.getAvailable();
	const model = find_exact_model_reference(searchTerm, models);
	return model ? { provider: model.provider, id: model.id } : undefined;
}

export type PickModelInEditorOptions = {
	initialSearch?: string;
	currentModel?: {
		provider: string;
		id: string;
		name?: string;
		thinkingLevel?: string;
	};
};

/** Open the in-editor Switch Model list (chatbox stays; models grow below). */
function open_model_selector_ui(editor: any, options: string | PickModelInEditorOptions = ""): void {
	if (!model_picker_ctx || !model_picker_pi) return;
	const ctx = model_picker_ctx;
	const pi = model_picker_pi;
	const normalized =
		typeof options === "string" ? { initialSearch: options } : (options ?? {});
	live_editor = editor;
	model_selector_busy = true;

	open_model_picker_in_editor(editor, ctx, pi, {
		initialSearch: normalized.initialSearch ?? "",
		currentModel: normalized.currentModel,
		onConfirm: async (selected) => {
			model_selector_busy = false;
			finalize_editor_input_after(live_editor);
			if (pending_pick) {
				const pick = pending_pick;
				pending_pick = null;
				pick.resolve({
					provider: selected.provider,
					id: selected.id,
					thinkingLevel: selected.thinkingLevel,
					syncThinkingLevelToPi: selected.syncThinkingLevelToPi,
				});
				return;
			}
			await apply_model_selection(pi, ctx, selected);
		},
		onCancel: () => {
			model_selector_busy = false;
			finalize_editor_input_after(live_editor);
			if (pending_pick) {
				pending_pick.resolve(undefined);
				pending_pick = null;
			}
		},
	});
}

/**
 * Open the in-editor model picker on the next microtask so slash autocomplete
 * can collapse first. Editor text is cleared so the user can type a filter freely.
 */
/**
 * Route `/model` typing into the single in-editor family picker and keep Pi's
 * argument autocomplete suppressed.
 */
function route_model_slash_input(editor: any): void {
	const trimmed = editor.getText?.()?.trim() ?? "";
	if (is_model_picker_active()) {
		bind_picker_editor(editor);
		const normalized = normalize_picker_filter(trimmed);
		if (trimmed !== normalized) {
			editor.setText?.(normalized);
		}
		on_model_picker_filter_changed(editor);
		return;
	}
	if (!should_open_model_picker_while_typing(trimmed)) return;
	editor.cancelAutocomplete?.();
	open_model_picker_from_slash(editor, normalize_picker_filter(trimmed));
}

function clear_editor_without_submit(editor: any): void {
	editor.cancelAutocomplete?.();
	editor.setText?.("");
	finalize_editor_input_after(editor);
}

function is_model_command_text(text: string): boolean {
	return extract_model_command_search(text) !== null;
}

function should_open_model_picker_while_typing(text: string): boolean {
	return should_route_model_slash_to_picker(text);
}

/** Open the in-editor picker immediately (no microtask — avoids arrow-key races). */
function open_model_picker_from_slash(editor: any, initialSearch = ""): void {
	if (is_model_picker_active()) return;
	live_editor = editor;
	editor?.cancelAutocomplete?.();
	reset_slash_command_tracking();
	if (!model_picker_ctx || !model_picker_pi) {
		model_picker_ctx?.ui?.notify?.("Model picker is not ready yet.", "error");
		return;
	}
	let seed = normalize_picker_filter(initialSearch);
	const text = editor?.getText?.()?.trim() ?? "";
	const from_slash = extract_model_command_search(text);
	if (from_slash !== null) {
		seed = from_slash;
	}
	open_model_selector_ui(editor, seed);
}

/**
 * @deprecated Alias — opens synchronously; kept for call-site clarity.
 */
function prepare_and_schedule_model_selector(editor: any, initialSearch = ""): void {
	open_model_picker_from_slash(editor, initialSearch);
}

function is_resume_command_text(text: string): boolean {
	return text === RESUME_PREFIX || text.startsWith(`${RESUME_PREFIX} `);
}

/**
 * Shared /model routing: always use the in-editor family picker (SSOT). Exact
 * `provider/id` still applies immediately on submit. Never fall through to Pi's
 * ModelSelectorComponent overlay or argument autocomplete list.
 */
function handle_model_command_text(editor: any, text: string): boolean {
	if (!is_model_command_text(text)) return false;

	// Enter while the in-editor model list is open must not reopen it.
	if (model_selector_busy || is_model_picker_active()) {
		return true;
	}

	const trimmed = text.trim();
	const searchTerm = extract_model_command_search(trimmed) ?? "";
	if (trimmed === MODEL_PREFIX || !searchTerm) {
		prepare_and_schedule_model_selector(editor);
		return true;
	}

	if (pending_pick) {
		const picked = resolve_pending_pick(searchTerm);
		pending_pick.resolve(picked);
		pending_pick = null;
		clear_editor_without_submit(editor);
		return true;
	}

	if (model_picker_ctx && model_picker_pi) {
		const models = model_picker_ctx.modelRegistry.getAvailable();
		const model = find_exact_model_reference(searchTerm, models);
		if (model) {
			editor.setText?.("");
			void apply_model_from_command(model_picker_pi, model_picker_ctx, searchTerm);
			return true;
		}
	}

	prepare_and_schedule_model_selector(editor, searchTerm);
	return true;
}

/**
 * Shared /resume routing: in-editor slash autocomplete instead of Pi's
 * SessionSelectorComponent overlay. Mirrors /model — never registerCommand("resume")
 * (that conflicts with the built-in and triggers the extension-issues warning).
 */
function handle_resume_command_text(editor: any, text: string): boolean {
	if (!is_resume_command_text(text)) return false;
	const searchTerm = text.slice(RESUME_PREFIX.length).trim();
	if (text === RESUME_PREFIX || !searchTerm) {
		open_resume_autocomplete(editor);
		return true;
	}
	// Exact path (from autocomplete) or unique fuzzy ref — switch like setModel.
	editor.setText?.("");
	void apply_resume_from_term(searchTerm);
	return true;
}

export async function apply_resume_from_term(searchTerm: string): Promise<void> {
	const ctx = model_picker_ctx;
	if (!ctx) return;
	const sessions = await load_sessions_for_ctx(ctx);
	const match = find_session_reference(searchTerm, sessions);
	if (!match) {
		ctx.ui.notify(`Session not found: ${searchTerm}`, "error");
		if (live_editor) open_resume_autocomplete(live_editor, searchTerm);
		else ctx.ui.setEditorText?.(`${RESUME_PREFIX} ${searchTerm}`);
		return;
	}
	const switch_session = resolve_switch_session_fn() ?? get_switch_session_fn();
	if (!switch_session) {
		if (fallback_to_native_resume(match.path)) return;
		ctx.ui.notify(
			"Could not switch sessions — Pi resume handler not ready. Retry in a moment, or restart Pi.",
			"error",
		);
		return;
	}
	try {
		const result = await switch_session(match.path);
		if (result?.cancelled) {
			ctx.ui.notify("Resume cancelled", "info");
		}
	} catch (err) {
		ctx.ui.notify(`Failed to resume: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

/** Delegate to Pi's built-in /resume when switchSession capture is temporarily missing. */
function fallback_to_native_resume(session_path: string): boolean {
	const editor = live_editor;
	const native_submit = get_editor_native_submit(editor);
	if (!editor || typeof native_submit !== "function") return false;
	editor.setText?.(`${RESUME_PREFIX} ${session_path}`);
	native_submit.call(editor);
	return true;
}

function get_editor_native_submit(editor: unknown): ((this: Editor) => void) | undefined {
	if (editor && typeof editor === "object") {
		const per_instance = (editor as Record<symbol, unknown>)[NATIVE_SUBMIT_KEY];
		if (typeof per_instance === "function") {
			return per_instance as (this: Editor) => void;
		}
	}
	return native_editor_submit_value;
}

/** Test seam: exercise native /resume fallback without switchSession capture. */
export function fallback_to_native_resume_for_tests(session_path: string): boolean {
	return fallback_to_native_resume(session_path);
}

/** Test seam: set native submit handler for fallback tests. */
export function set_native_editor_submit_value_for_tests(
	fn: ((this: Editor) => void) | undefined,
): void {
	native_editor_submit_value = fn;
}

/** Test seam: bind live editor for /resume fallback tests. */
export function bind_live_editor_for_tests(editor: unknown): void {
	live_editor = editor;
}

/** Test seam: bind ctx for /resume tests. */
export function bind_model_picker_ctx_for_tests(ctx: unknown): void {
	model_picker_ctx = ctx;
}

/** Route shared slash overrides before Pi's overlay selectors. */
function handle_slash_override_text(editor: any, text: string): boolean {
	if (handle_model_command_text(editor, text)) return true;
	if (handle_resume_command_text(editor, text)) return true;
	return false;
}

function intercept_slash_override_command(data: string, editor: any): boolean {
	const kb = getKeybindings();
	if (!kb.matches(data, "tui.select.confirm") && !kb.matches(data, "tui.input.submit")) {
		return false;
	}
	if (editor_is_showing_autocomplete(editor)) return false;
	const getText = editor.getText?.bind(editor) ?? editor.getExpandedText?.bind(editor);
	if (!getText) return false;
	return handle_slash_override_text(editor, getText().trim());
}

/**
 * After a slash autocomplete confirm, decide whether the remaining editor text
 * should be committed immediately. Pi only auto-submits command-name picks
 * (prefix starts with "/"); argument picks leave "/cmd value" in the editor.
 * Skip unfinished path completions (trailing "/" or quoted "/") so directory
 * expansion continues. Bare slash commands are not auto-committed; a slash
 * command must have a non-whitespace argument (or be /model / /resume selected
 * with Tab, handled separately in the wrapper).
 */
export function should_auto_submit_slash_text(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return false;
	// Bare "/" or whitespace-only after slash is not a command yet.
	if (!/^\/\S/.test(trimmed)) return false;
	// Directory-style completions end with "/" or quoted "/" and should keep expanding.
	if (trimmed.endsWith("/") || trimmed.endsWith('/"')) return false;
	// Require a non-whitespace argument (command + whitespace + non-whitespace).
	return /^\S+\s+\S/.test(trimmed);
}

/** Outermost editor wrap — call from pi-custom-agents editor factory after other wraps. */
export function wrap_model_picker_editor(editor: any, pi: ExtensionAPI, ctx: any): void {
	live_editor = editor;
	model_picker_ctx = ctx;
	model_picker_pi = pi;

	// Instance-level submitValue patch — jiti can load a second Editor copy so
	// Editor.prototype patches from plugin load may miss this live instance.
	const original_submit_value = editor.submitValue?.bind(editor);
	if (typeof original_submit_value === "function") {
		editor[NATIVE_SUBMIT_KEY] = original_submit_value;
		editor.submitValue = (): void => {
			if (is_model_picker_active()) return;
			const trimmed = (editor.getText?.() ?? "").trim();
			if (handle_slash_override_text(editor, trimmed)) return;
			original_submit_value();
		};
	}

	const original_request_autocomplete = editor.requestAutocomplete?.bind(editor);
	if (typeof original_request_autocomplete === "function") {
		editor.requestAutocomplete = (opts?: { force?: boolean; explicitTab?: boolean }) => {
			const trimmed = editor.getText?.()?.trim() ?? "";
			if (is_model_picker_active() || is_model_command_text(trimmed)) {
				editor.cancelAutocomplete?.();
				route_model_slash_input(editor);
				return;
			}
			return original_request_autocomplete(opts);
		};
	}

	const original_handle_input = editor.handleInput.bind(editor);
	editor.handleInput = (data: string): void => {
		if (is_model_picker_active()) {
			bind_picker_editor(editor);
			const filterBefore = editor.getText?.() ?? "";
			if (handle_model_picker_input(data, editor)) {
				finalize_editor_input_after(editor);
				return;
			}
			if (consumes_picker_key(data)) {
				finalize_editor_input_after(editor);
				return;
			}
			original_handle_input(data);
			const filterAfter = editor.getText?.() ?? "";
			if (filterAfter !== filterBefore) {
				on_model_picker_filter_changed(editor);
			}
			finalize_editor_input_after(editor);
			return;
		}
		if (intercept_slash_override_command(data, editor)) {
			finalize_editor_input_after(editor);
			return;
		}
		const was_showing = editor_is_showing_autocomplete(editor);
		const kb = getKeybindings();
		const is_confirm = kb.matches(data, "tui.select.confirm");
		const is_submit = kb.matches(data, "tui.input.submit");
		const is_tab = kb.matches(data, "tui.input.tab");
		const trimmed_before = editor.getText?.()?.trim() ?? "";
		if (is_model_command_text(trimmed_before)) {
			editor.cancelAutocomplete?.();
		}
		original_handle_input(data);
		route_model_slash_input(editor);
		// Pi only falls through to submit for command-name completions with
		// Enter (prefix starts with "/"). Tab always applies the completion and
		// returns, leaving "/cmd value" in the editor. Commit any remaining
		// complete slash command so Tab and Enter both run — not just insert.
		// Native command-name submits with Enter already clear the editor, so
		// the argument-only guard makes this a no-op for them. submitValue
		// routes /model and /resume through our patch.
		if (was_showing && !editor_is_showing_autocomplete(editor)) {
			const text = editor.getText?.()?.trim() ?? "";
			// Enter/Tab on bare /model or /resume must open the picker / resume UI.
			// should_auto_submit_slash_text requires an argument, so handle these
			// explicitly (Pi may have already submitted — then text is empty).
			if (
				(is_tab || is_confirm || is_submit) &&
				(text === MODEL_PREFIX || text === RESUME_PREFIX)
			) {
				editor.submitValue?.();
				finalize_editor_input_after(editor);
				return;
			}
			if (
				(is_confirm || is_submit || is_tab) &&
				should_auto_submit_slash_text(text) &&
				typeof editor.submitValue === "function"
			) {
				editor.submitValue();
				finalize_editor_input_after(editor);
				return;
			}
		}
		finalize_editor_input_after(editor);
	};
}

function format_session_age(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function session_label(session: SessionInfo): string {
	const named = session.name?.trim();
	if (named) return named;
	const first = session.firstMessage?.replace(/\s+/g, " ").trim() ?? "";
	if (first) {
		return first.length > FIRST_MESSAGE_PREVIEW_LEN
			? `${first.slice(0, FIRST_MESSAGE_PREVIEW_LEN - 1)}…`
			: first;
	}
	return session.id;
}

function session_search_text(session: SessionInfo): string {
	return [
		session.path,
		session.id,
		session.name ?? "",
		session.firstMessage ?? "",
		session.cwd ?? "",
		session.allMessagesText ?? "",
	].join(" ");
}

function session_to_autocomplete_item(session: SessionInfo): AutocompleteItem {
	const age = format_session_age(session.modified);
	const msgs = session.messageCount;
	return {
		value: session.path,
		label: session_label(session),
		description: `${age} · ${msgs} msg${msgs === 1 ? "" : "s"}`,
	};
}

async function load_sessions_for_ctx(ctx: any): Promise<SessionInfo[]> {
	const sm = ctx?.sessionManager;
	const cwd = typeof sm?.getCwd === "function" ? sm.getCwd() : (ctx?.cwd as string | undefined);
	if (!cwd) return [];
	const sessionDir = typeof sm?.getSessionDir === "function" ? sm.getSessionDir() : undefined;
	try {
		return await SessionManager.list(cwd, sessionDir);
	} catch {
		return [];
	}
}

async function refresh_session_cache(options?: { force?: boolean }): Promise<SessionInfo[]> {
	const now = Date.now();
	if (!options?.force && session_cache && now - session_cache_at < SESSION_CACHE_TTL_MS) {
		return session_cache;
	}
	if (session_cache_loading) return session_cache_loading;
	if (!model_picker_ctx) return session_cache ?? [];

	session_cache_loading = (async () => {
		const sessions = await load_sessions_for_ctx(model_picker_ctx);
		session_cache = sessions;
		session_cache_at = Date.now();
		session_cache_loading = null;
		return sessions;
	})();
	return session_cache_loading;
}

/** Resolve a /resume argument to a session path (path, id, or unique name/fuzzy). */
export function find_session_reference(
	reference: string,
	sessions: SessionInfo[],
): SessionInfo | undefined {
	const trimmed = reference.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.toLowerCase();

	const pathMatches = sessions.filter(
		(s) => s.path === trimmed || s.path.toLowerCase() === normalized,
	);
	if (pathMatches.length === 1) return pathMatches[0];
	if (pathMatches.length > 1) return undefined;

	const idMatches = sessions.filter((s) => s.id.toLowerCase() === normalized);
	if (idMatches.length === 1) return idMatches[0];
	if (idMatches.length > 1) return undefined;

	const nameMatches = sessions.filter((s) => (s.name?.trim().toLowerCase() ?? "") === normalized);
	if (nameMatches.length === 1) return nameMatches[0];
	if (nameMatches.length > 1) return undefined;

	const fuzzy = fuzzyFilter(sessions, trimmed, session_search_text);
	return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

async function get_resume_argument_completions(
	argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
	const sessions = await refresh_session_cache();
	if (sessions.length === 0) return null;
	const prefix = argumentPrefix.trim();
	const filtered = prefix ? fuzzyFilter(sessions, prefix, session_search_text) : sessions;
	if (filtered.length === 0) return null;
	// Prefer newest sessions first when unfiltered.
	const ordered = prefix
		? filtered
		: [...filtered].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return ordered.map(session_to_autocomplete_item);
}

/**
 * Stack /resume argument completions on Pi's autocomplete provider.
 * Built-in `/resume` has no getArgumentCompletions; we inject them the same way
 * /model uses built-in completions — without registering a conflicting command.
 */
export function create_resume_autocomplete_provider(
	current: AutocompleteProvider,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const beforeCursor = line.slice(0, cursorCol);
			if (beforeCursor.startsWith(`${RESUME_PREFIX} `)) {
				const prefix = beforeCursor.slice(RESUME_PREFIX.length + 1);
				const items = await get_resume_argument_completions(prefix);
				if (!items || items.length === 0) return null;
				return { items, prefix };
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function install_model_picker_prototype_patches(): void {
	const runnerProto = ExtensionRunner.prototype as any;
	if (runnerProto[EMBER_PATCH_MARKER]) return;
	runnerProto[EMBER_PATCH_MARKER] = true;

	install_command_context_capture();

	const editorProto = Editor.prototype as any;
	if (typeof editorProto.createAutocompleteList === "function") {
		editorProto.createAutocompleteList = function createAutocompleteListPatched(
			this: Editor,
			prefix: string,
			items: any[],
		) {
			const text = this.getText?.()?.trim() ?? "";
			if (is_model_picker_active() || is_model_command_text(text)) {
				return new SelectList(
					[],
					AUTOCOMPLETE_MAX_VISIBLE,
					buildSelectListTheme(resolve_select_list_theme()),
				);
			}
			const slashMode =
				prefix.startsWith("/") || this.getText?.().trimStart().startsWith("/") === true;
			const isResumeList = this.getText?.()?.trim().startsWith(RESUME_PREFIX) ?? false;
			const layout = isResumeList
				? RESUME_SELECT_LIST_LAYOUT
				: slashMode
					? SLASH_COMMAND_SELECT_LIST_LAYOUT
					: undefined;
			return new SelectList(
				items,
				AUTOCOMPLETE_MAX_VISIBLE,
				buildSelectListTheme(resolve_select_list_theme()),
				layout,
			);
		};
	}

	const originalSubmitValue = editorProto.submitValue;
	if (typeof originalSubmitValue === "function") {
		native_editor_submit_value = originalSubmitValue;
		editorProto.submitValue = function submitValueSlashOverridePatched(this: Editor): void {
			if (is_model_picker_active()) return;
			const trimmed = this.getText().trim();
			if (handle_slash_override_text(this, trimmed)) return;
			originalSubmitValue.call(this);
		};
	}

	if (typeof editorProto.handleTabCompletion === "function") {
		const originalHandleTabCompletion = editorProto.handleTabCompletion;
		editorProto.handleTabCompletion = function handleTabCompletionSlashArgsPatched(
			this: Editor,
		): void {
			const self = this as any;
			if (!self.autocompleteProvider) return;
			const currentLine = self.state.lines[self.state.cursorLine] || "";
			const beforeCursor = currentLine.slice(0, self.state.cursorCol);
			const trimmed = beforeCursor.trimStart();
			if (trimmed.startsWith("/") && trimmed.includes(" ")) {
				self.requestAutocomplete({ force: false, explicitTab: true });
				return;
			}
			originalHandleTabCompletion.call(this);
		};
	}

	const originalCustomHandleInput = CustomEditor.prototype.handleInput;
	CustomEditor.prototype.handleInput = function handleInputSlashOverridePatched(
		this: CustomEditor,
		data: string,
	): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.model.select")) {
			prepare_and_schedule_model_selector(this);
			return;
		}
		if (kb.matches(data, "app.session.resume")) {
			open_resume_autocomplete(this);
			return;
		}
		originalCustomHandleInput.call(this, data);
	};
}

/** Install Editor/CustomEditor/ExtensionRunner prototype patches once at plugin load. */
export function install_model_picker_patches(): void {
	install_model_picker_prototype_patches();
}

let model_picker_input_unsubscribe: (() => void) | undefined;

type PickerTui = {
	addInputListener?: (
		listener: (data: string) => { consume?: boolean; data?: string } | undefined,
	) => () => void;
	focusedComponent?: {
		getText?: () => string;
		setText?: (text: string) => void;
		tui?: { requestRender?: () => void };
	};
};

/**
 * TUI-level arrow/enter capture for the model picker. Pi can replace the live
 * editor instance; this listener persists and runs before focusedComponent.
 */
export function install_model_picker_input_listener(
	get_tui: () => PickerTui | undefined,
): void {
	model_picker_input_unsubscribe?.();
	const tui = get_tui();
	if (!tui?.addInputListener) return;

	model_picker_input_unsubscribe = tui.addInputListener((data) => {
		if (!is_model_picker_active()) return undefined;
		const focused = tui.focusedComponent;
		if (!focused?.getText) return undefined;

		live_editor = focused;
		bind_picker_editor(focused);

		if (handle_model_picker_input(data, focused)) {
			finalize_editor_input_after(focused);
			return { consume: true };
		}
		if (consumes_picker_key(data)) {
			finalize_editor_input_after(focused);
			return { consume: true };
		}
		return undefined;
	});
}

export function uninstall_model_picker_input_listener(): void {
	model_picker_input_unsubscribe?.();
	model_picker_input_unsubscribe = undefined;
}

/** Bind per-session ctx used by /model and /resume routing and pending picks. */
export function bind_model_picker_session(ctx: any, pi: ExtensionAPI): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	model_picker_ctx = ctx;
	model_picker_pi = pi;
	session_cache = null;
	session_cache_at = 0;
	session_cache_loading = null;
	// Inject /resume session completions into the chat-pill autocomplete stack.
	ctx.ui.addAutocompleteProvider?.(create_resume_autocomplete_provider);
}

export function reset_model_picker_session(): void {
	cancel_pending_model_pick();
	close_model_picker(live_editor);
	uninstall_model_picker_input_listener();
	model_selector_busy = false;
	model_picker_ctx = undefined;
	model_picker_pi = undefined;
	live_editor = undefined;
	// switchSession is sticky in command-context-capture — survives shutdown/rebind races.
	session_cache = null;
	session_cache_at = 0;
	session_cache_loading = null;
}

/**
 * Open the Switch Model chatbox UI and wait for the user to confirm a model.
 * Same editor-replacement UI as `/model` / `app.model.select`.
 */
export async function pick_model_in_editor(
	ctx: any,
	pi: ExtensionAPI,
	options: string | PickModelInEditorOptions = "",
): Promise<ModelPickResult> {
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
	if (!live_editor) {
		ctx.ui.notify("Model picker requires the editor.", "warning");
		return undefined;
	}
	model_picker_ctx = ctx;
	model_picker_pi = pi;
	const normalized =
		typeof options === "string" ? { initialSearch: options } : (options ?? {});
	return new Promise((resolve) => {
		pending_pick = { resolve };
		open_model_selector_ui(live_editor, normalized);
	});
}
