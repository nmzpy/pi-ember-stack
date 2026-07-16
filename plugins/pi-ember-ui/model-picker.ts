import type { Model } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	ExtensionRunner,
	SessionManager,
	type ExtensionAPI,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	fuzzyFilter,
	getKeybindings,
	SelectList,
	type AutocompleteItem,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { finalize_editor_input_after, sync_slash_command_active } from "./layout.ts";

/** Same layout Pi uses for slash-command autocomplete rows. */
const SLASH_COMMAND_SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Max visible rows in editor entry pickers (slash commands, /model, /resume, etc.).
 * Pi defaults to 5 via `autocompleteMaxVisible`; 7 reads less cramped.
 * SSOT for all SelectLists created through the createAutocompleteList patch.
 */
export const AUTOCOMPLETE_MAX_VISIBLE = 7;

const MODEL_PREFIX = "/model";
const RESUME_PREFIX = "/resume";
const SESSION_CACHE_TTL_MS = 5_000;
const FIRST_MESSAGE_PREVIEW_LEN = 48;

type ModelPickResult = { provider: string; id: string } | undefined;

type PendingModelPick = {
	resolve: (result: ModelPickResult) => void;
};

type SwitchSessionFn = (
	sessionPath: string,
	options?: { withSession?: (ctx: any) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

let model_picker_ctx: any;
let model_picker_pi: ExtensionAPI | undefined;
let live_editor: any;
let pending_pick: PendingModelPick | null = null;
const EMBER_PATCH_MARKER = Symbol.for("pi-ember-ui:model-picker-patched");
/** Captured from ExtensionRunner.bindCommandContext — same role as pi.setModel for /model. */
let switch_session_fn: SwitchSessionFn | undefined;

/** Cached session list for /resume argument completions (refreshed on open + TTL). */
let session_cache: SessionInfo[] | null = null;
let session_cache_at = 0;
let session_cache_loading: Promise<SessionInfo[]> | null = null;

/** Mirrors pi-coding-agent `findExactModelReferenceMatch` for /model submit handling. */
export function find_exact_model_reference<T extends { provider: string; id: string }>(
	modelReference: string,
	availableModels: T[],
): T | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) return undefined;
	const normalizedReference = trimmedReference.toLowerCase();
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;
	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}
	const idMatches = availableModels.filter(
		(model) => model.id.toLowerCase() === normalizedReference,
	);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

export function cancel_pending_model_pick(): void {
	if (!pending_pick) return;
	pending_pick.resolve(undefined);
	pending_pick = null;
}

function editor_is_showing_autocomplete(editor: any): boolean {
	return editor.isShowingAutocomplete?.() === true;
}

function request_editor_render(editor: any, force = false): void {
	editor?.tui?.requestRender?.(force);
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

/** Open Pi's built-in /model argument autocomplete inside the editor chat pill. */
export function open_model_autocomplete(editor: any, initialSearch = ""): void {
	open_slash_autocomplete(editor, MODEL_PREFIX, initialSearch);
}

/** Open /resume session argument autocomplete (chat-pill, same UX as /model). */
export function open_resume_autocomplete(editor: any, initialSearch = ""): void {
	void refresh_session_cache({ force: true });
	open_slash_autocomplete(editor, RESUME_PREFIX, initialSearch);
}

async function apply_model_from_command(
	pi: ExtensionAPI,
	ctx: any,
	searchTerm: string,
): Promise<void> {
	const models = ctx.modelRegistry.getAvailable();
	const model = find_exact_model_reference(searchTerm, models);
	if (!model) return;
	try {
		await pi.setModel(model as Model<any>);
		ctx.ui.notify(`Model: ${model.id} • ${model.provider}`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Failed to set model: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

function resolve_pending_pick(searchTerm: string): ModelPickResult {
	if (!model_picker_ctx || !searchTerm) return undefined;
	const models = model_picker_ctx.modelRegistry.getAvailable();
	const model = find_exact_model_reference(searchTerm, models);
	return model ? { provider: model.provider, id: model.id } : undefined;
}

function clear_editor_without_submit(editor: any): void {
	editor.cancelAutocomplete?.();
	editor.setText?.("");
	finalize_editor_input_after(editor);
}

function is_model_command_text(text: string): boolean {
	return text === MODEL_PREFIX || text.startsWith(`${MODEL_PREFIX} `);
}

function is_resume_command_text(text: string): boolean {
	return text === RESUME_PREFIX || text.startsWith(`${RESUME_PREFIX} `);
}

/**
 * Shared /model routing: in-editor slash autocomplete instead of Pi's
 * ModelSelectorComponent overlay.
 */
function handle_model_command_text(editor: any, text: string): boolean {
	if (!is_model_command_text(text)) return false;

	const searchTerm = text.slice(MODEL_PREFIX.length).trim();
	if (text === MODEL_PREFIX || !searchTerm) {
		open_model_autocomplete(editor);
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

	open_model_autocomplete(editor, searchTerm);
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

async function apply_resume_from_term(searchTerm: string): Promise<void> {
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
	if (!switch_session_fn) {
		ctx.ui.notify("Resume is unavailable in this session.", "error");
		return;
	}
	try {
		const result = await switch_session_fn(match.path);
		if (result?.cancelled) {
			ctx.ui.notify("Resume cancelled", "info");
		}
	} catch (err) {
		ctx.ui.notify(`Failed to resume: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
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

/** Outermost editor wrap — call from pi-custom-agents editor factory after other wraps. */
export function wrap_model_picker_editor(editor: any, pi: ExtensionAPI, ctx: any): void {
	live_editor = editor;
	model_picker_ctx = ctx;
	model_picker_pi = pi;
	const original_handle_input = editor.handleInput.bind(editor);
	editor.handleInput = (data: string): void => {
		if (intercept_slash_override_command(data, editor)) {
			finalize_editor_input_after(editor);
			return;
		}
		const was_showing = editor_is_showing_autocomplete(editor);
		const kb = getKeybindings();
		const is_confirm = kb.matches(data, "tui.select.confirm");
		original_handle_input(data);
		if (was_showing && is_confirm && !editor_is_showing_autocomplete(editor)) {
			const text = editor.getText?.()?.trim() ?? "";
			if (text && handle_slash_override_text(editor, text)) {
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

	// Capture switchSession the same way InteractiveMode binds it — no extension
	// command named "resume" (that conflicts with the built-in slash command).
	const originalBindCommandContext = runnerProto.bindCommandContext;
	if (typeof originalBindCommandContext === "function") {
		runnerProto.bindCommandContext = function bindCommandContextResumeCapture(
			this: ExtensionRunner,
			actions?: { switchSession?: SwitchSessionFn },
		) {
			switch_session_fn =
				actions && typeof actions.switchSession === "function"
					? actions.switchSession.bind(actions)
					: undefined;
			return originalBindCommandContext.call(this, actions);
		};
	}

	const editorProto = Editor.prototype as any;
	if (typeof editorProto.createAutocompleteList === "function") {
		editorProto.createAutocompleteList = function createAutocompleteListPatched(
			this: Editor,
			prefix: string,
			items: any[],
		) {
			const slashMode =
				prefix.startsWith("/") || this.getText?.().trimStart().startsWith("/") === true;
			const layout = slashMode ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
			return new SelectList(
				items,
				AUTOCOMPLETE_MAX_VISIBLE,
				(this as any).theme.selectList,
				layout,
			);
		};
	}

	const originalSubmitValue = editorProto.submitValue;
	if (typeof originalSubmitValue === "function") {
		editorProto.submitValue = function submitValueSlashOverridePatched(this: Editor): void {
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
			open_model_autocomplete(this);
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
	model_picker_ctx = undefined;
	model_picker_pi = undefined;
	live_editor = undefined;
	// switch_session_fn is owned by bindCommandContext (set on bind, cleared on
	// unbind) — do not null it here or a shutdown→rebind race drops the handler.
	session_cache = null;
	session_cache_at = 0;
	session_cache_loading = null;
}

/**
 * Open the in-editor /model picker and wait for the user to confirm a model.
 * Uses the same slash-popup flow as typing /model in the chatbox.
 */
export function pick_model_in_editor(
	ctx: any,
	pi: ExtensionAPI,
	initialSearch = "",
): Promise<ModelPickResult> {
	if (!ctx.hasUI || ctx.mode !== "tui") return Promise.resolve(undefined);
	if (!live_editor) {
		ctx.ui.setEditorText?.(initialSearch ? `${MODEL_PREFIX} ${initialSearch}` : `${MODEL_PREFIX} `);
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		pending_pick = { resolve };
		open_model_autocomplete(live_editor, initialSearch);
	});
}
