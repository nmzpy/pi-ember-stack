import {
	BashExecutionComponent,
	InteractiveMode,
	type UserBashEvent,
	type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { is_model_picker_active } from "./model-selector.ts";
import { isUserBashRunning } from "./mode-colors.ts";
import { request_render } from "./render-intent.ts";

/** Structural surface of the live BashExecutionComponent row used by the
 *  instant-bash patch. `updateDisplay` is private on the class, so method
 *  calls route through this interface. */
export type BashComponentHost = {
	updateDisplay(): void;
	appendOutput(chunk: string): void;
	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: { truncated: boolean; content: string },
		fullOutputPath?: string,
	): void;
};

/** Runtime surface of the interactive-mode members the bash queue patch
 *  reads/writes. Members are private on Pi's `InteractiveMode`; this
 *  structural type keeps the patch free of `any`. */
export type BashQueueInteractiveHost = {
	ui: TUI;
	session: {
		extensionRunner: {
			emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined>;
		};
		isStreaming: boolean;
		executeBash(
			command: string,
			onChunk?: (chunk: string) => void,
			options?: { excludeFromContext?: boolean; operations?: unknown },
		): Promise<{
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			fullOutputPath?: string;
		}>;
		recordBashResult(
			command: string,
			result: unknown,
			options?: { excludeFromContext?: boolean },
		): void;
	};
	sessionManager: { getCwd(): string };
	chatContainer: { addChild(child: BashExecutionComponent): void };
	pendingMessagesContainer: { addChild(child: BashExecutionComponent): void };
	pendingBashComponents?: unknown[];
	bashComponent?: BashComponentHost;
	onInputCallback?: (text: string) => void;
	pendingUserInputs?: string[];
	showError?(message: string): void;
};

/** Editor surface read/written while queuing a message during user bash. */
export type BashQueueEditor = {
	getText?: () => string;
	setText?: (text: string) => void;
	addToHistory?: (text: string) => void;
	tui?: { requestRender?: () => void };
};

/** Live TUI surface for the bash-queue input listener. */
export type BashQueueTui = {
	addInputListener?: (listener: (data: string) => { consume?: boolean } | undefined) => () => void;
	focusedComponent?: BashQueueEditor;
	hasOverlay?: () => boolean;
};

/** After-bash message queue stored on `globalThis` via `Symbol.for` so jiti
 *  module duplication (writer in one copy, reader in another) can never split
 *  the queue — same pattern as `isUserBashRunning`. */
const BASH_QUEUE_KEY = Symbol.for("pi-ember-ui:bash-queued-messages");

type GlobalWithQueue = typeof globalThis & { [BASH_QUEUE_KEY]?: string[] };

function bash_queue(): string[] {
	const globalState = globalThis as GlobalWithQueue;
	let queue = globalState[BASH_QUEUE_KEY];
	if (!Array.isArray(queue)) {
		queue = [];
		globalState[BASH_QUEUE_KEY] = queue;
	}
	return queue;
}

/** Append a plain user message to the after-bash queue. */
export function push_bash_queued_message(text: string): void {
	bash_queue().push(text);
}

/** Number of messages currently queued for after-bash delivery. */
export function bash_queued_message_count(): number {
	return bash_queue().length;
}

/** Drain (read + clear) the after-bash queue. */
export function drain_bash_queued_messages(): string[] {
	const queue = bash_queue();
	const drained = [...queue];
	queue.length = 0;
	return drained;
}

/** Drop the after-bash queue (test seam and session-shutdown floor). */
export function clear_bash_queued_messages(): void {
	const globalState = globalThis as GlobalWithQueue;
	delete globalState[BASH_QUEUE_KEY];
}

/** A plain user message can be queued while user bash is Running. `!` bash
 *  commands fall through (Pi already warns that a command is running) and
 *  `/` slash commands run immediately (they are UI actions, not chat). */
export function should_queue_bash_message(text: string): boolean {
	if (!isUserBashRunning()) return false;
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("!")) return false;
	if (trimmed.startsWith("/")) return false;
	return true;
}

/** Queue a plain user message for delivery after the running bash command
 *  completes. Mirrors Pi's compaction queue: the editor clears, the text is
 *  recorded in history, and delivery happens in `flush_bash_queue`. */
export function queue_bash_message(
	editor: BashQueueEditor | undefined,
	notify: (message: string) => void,
	text: string,
): void {
	const trimmed = text.trim();
	editor?.addToHistory?.(trimmed);
	editor?.setText?.("");
	push_bash_queued_message(trimmed);
	notify("Queued message for after bash finishes");
}

/** Deliver queued messages after bash completes. Mirrors Pi's normal submit
 *  path: when the agent loop is awaiting input the text resolves
 *  `getUserInput()` via `onInputCallback`; otherwise it lands in
 *  `pendingUserInputs` for the next loop pass. */
export function flush_bash_queue(host: BashQueueInteractiveHost): void {
	const queued = drain_bash_queued_messages();
	if (queued.length === 0) return;
	for (const text of queued) {
		if (host.onInputCallback) host.onInputCallback(text);
		else {
			if (!Array.isArray(host.pendingUserInputs)) host.pendingUserInputs = [];
			host.pendingUserInputs.push(text);
		}
	}
	request_render();
}

const BASH_QUEUE_PATCH_MARKER = Symbol.for("pi-ember-ui:bash-queue-patched");

/** Install the interactive-mode patches that make user `!` bash instant:
 *
 *  `handleBashCommand` is reimplemented so the `BashExecutionComponent` is
 *  created, mounted, and painted (`• Running` gradient, `isUserBashRunning`)
 *  synchronously on submit — before the `user_bash` extension hook resolves.
 *  Pi's original awaits `extensionRunner.emitUserBash()` before creating the
 *  row, so any async `user_bash` handler delays the visible `Running` state.
 *  The row is created first; the hook result (custom operations / full
 *  replacement result) still applies to the same component.
 *
 *  The reimplementation mirrors Pi's `handleBashCommand` exactly (component
 *  creation reordered before the await). It cannot delegate to the original
 *  because the original unconditionally constructs a second component after
 *  the await — the two rows would both render.
 *
 *  On completion (success / error / cancel / replacement result) the
 *  after-bash message queue (see `install_bash_queue_input_listener`) is
 *  flushed through the normal submit path.
 */
export function install_bash_queue_patch(): void {
	const proto = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>;
	if (proto[BASH_QUEUE_PATCH_MARKER]) return;
	proto[BASH_QUEUE_PATCH_MARKER] = true;

	proto.handleBashCommand = async function emberHandleBashCommand(
		this: BashQueueInteractiveHost,
		command: string,
		excludeFromContext = false,
	): Promise<void> {
		const extensionRunner = this.session.extensionRunner;
		const cwd = this.sessionManager.getCwd();
		// Kick the extension hook without awaiting it — the bash row must be
		// mounted on the frame after submit, not after every user_bash handler.
		const eventResultPromise = Promise.resolve().then(() =>
			extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext, cwd }),
		);
		const isDeferred = this.session.isStreaming;
		const component = new BashExecutionComponent(command, this.ui, excludeFromContext);
		const host = component as unknown as BashComponentHost;
		// Force the running-state paint synchronously: sets isUserBashRunning,
		// swaps the header to the gradient `• Running <command>`, stops the
		// stock loader, and subscribes the shared 20 FPS gradient tick.
		host.updateDisplay();
		this.bashComponent = host;
		if (isDeferred) {
			this.pendingMessagesContainer.addChild(component);
			this.pendingBashComponents?.push(component);
		} else {
			this.chatContainer.addChild(component);
		}
		request_render();

		const eventResult = await eventResultPromise;
		if (eventResult?.result) {
			const result = eventResult.result;
			if (result.output) host.appendOutput(result.output);
			host.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? { truncated: true, content: result.output } : undefined,
				result.fullOutputPath,
			);
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			request_render();
			flush_bash_queue(this);
			return;
		}
		try {
			const result = await this.session.executeBash(
				command,
				(chunk: string) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						request_render();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);
			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? { truncated: true, content: result.output } : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError?.(
				`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		this.bashComponent = undefined;
		request_render();
		flush_bash_queue(this);
	};
}

/** Install the TUI input listener that queues plain messages submitted while
 *  user bash is Running: submit on a plain (non-`!`, non-`/`) editor body is
 *  consumed and queued for after-bash delivery instead of being sent to the
 *  agent mid-run. Returns the unsubscribe function. */
export function install_bash_queue_input_listener(
	get_tui: () => BashQueueTui | undefined,
	notify: (message: string) => void,
): () => void {
	const tui = get_tui();
	if (!tui?.addInputListener) return () => {};
	return tui.addInputListener((data: string) => {
		if (!isUserBashRunning()) return undefined;
		if (tui.hasOverlay?.()) return undefined;
		// The model picker replaces the editor component (not an overlay), so
		// its Enter would otherwise queue the model filter text as a message.
		if (is_model_picker_active()) return undefined;
		const keybindings = getKeybindings();
		if (!keybindings.matches(data, "tui.input.submit")) return undefined;
		const editor = tui.focusedComponent;
		const text = editor?.getText?.() ?? "";
		if (!should_queue_bash_message(text)) return undefined;
		queue_bash_message(editor, notify, text);
		request_render();
		return { consume: true };
	});
}
