/**
 * SSOT for Pi command-context actions captured from bindCommandContext.
 * Sticky capture on globalThis survives jiti module duplication and unbind races.
 * session_start refresh re-binds switchSession from the live ExtensionRunner.
 */
import {
	ExtensionRunner,
	type ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";

export type NewSessionFn = NonNullable<ExtensionCommandContextActions["newSession"]>;

export type SwitchSessionFn = (
	sessionPath: string,
	options?: { withSession?: (ctx: unknown) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

const GLOBAL_KEY = Symbol.for("pi-ember-ui:command-context-capture");
const WRAPPER_KEY = Symbol.for("pi-ember-ui:command-context-capture-wrapper");

interface GlobalCaptureState {
	newSession?: NewSessionFn;
	switchSession?: SwitchSessionFn;
	activeRunner?: ExtensionRunner;
	bindPatched: boolean;
	emitPatched: boolean;
}

function global_state(): GlobalCaptureState {
	const g = globalThis as Record<symbol, GlobalCaptureState>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = { bindPatched: false, emitPatched: false };
	}
	return g[GLOBAL_KEY];
}

function set_switch_session_fn(fn: SwitchSessionFn): void {
	global_state().switchSession = fn;
}

function set_new_session_fn(fn: NewSessionFn): void {
	global_state().newSession = fn;
}

export function get_new_session_fn(): NewSessionFn | undefined {
	return global_state().newSession;
}

export function get_switch_session_fn(): SwitchSessionFn | undefined {
	return global_state().switchSession;
}

/** Test-only reset — not used in production. */
export function reset_command_context_capture_for_tests(): void {
	const state = global_state();
	state.newSession = undefined;
	state.switchSession = undefined;
	state.activeRunner = undefined;
}

function refresh_from_runner(runner: ExtensionRunner): void {
	const state = global_state();
	state.activeRunner = runner;
	try {
		const cmd = runner.createCommandContext();
		if (typeof cmd.switchSession === "function") {
			set_switch_session_fn((path, options) => cmd.switchSession(path, options));
		}
		if (typeof cmd.newSession === "function") {
			set_new_session_fn((options) => cmd.newSession(options));
		}
	} catch {
		// Runner not active yet — keep sticky handlers from the last bindCommandContext.
	}
}

function patch_bind_command_context(runnerProto: Record<PropertyKey, unknown>): void {
	const state = global_state();
	if (state.bindPatched && (runnerProto.bindCommandContext as { [WRAPPER_KEY]?: boolean })?.[WRAPPER_KEY]) {
		return;
	}

	const originalBindCommandContext = runnerProto.bindCommandContext;
	if (typeof originalBindCommandContext !== "function") return;

	const wrapped = function bindCommandContextCapture(
		this: ExtensionRunner,
		actions?: ExtensionCommandContextActions,
	) {
		if (actions?.newSession) {
			set_new_session_fn(actions.newSession.bind(actions));
		}
		if (actions?.switchSession) {
			set_switch_session_fn(actions.switchSession.bind(actions));
		}
		state.activeRunner = this;
		return (originalBindCommandContext as typeof ExtensionRunner.prototype.bindCommandContext).call(
			this,
			actions,
		);
	};
	(wrapped as { [WRAPPER_KEY]?: boolean })[WRAPPER_KEY] = true;
	runnerProto.bindCommandContext = wrapped;
	state.bindPatched = true;
}

function patch_emit_session_refresh(runnerProto: Record<PropertyKey, unknown>): void {
	const state = global_state();
	if (state.emitPatched) return;

	const originalEmit = runnerProto.emit;
	if (typeof originalEmit !== "function") return;

	runnerProto.emit = async function emitSessionRefreshCapture(
		this: ExtensionRunner,
		event: { type?: string },
		...rest: unknown[]
	) {
		if (event?.type === "session_start") {
			refresh_from_runner(this);
		}
		return (originalEmit as (...args: unknown[]) => unknown).call(this, event, ...rest);
	};
	state.emitPatched = true;
}

export function install_command_context_capture(): void {
	const runnerProto = ExtensionRunner.prototype as unknown as Record<PropertyKey, unknown>;
	patch_bind_command_context(runnerProto);
	patch_emit_session_refresh(runnerProto);
}

/** Test seam: refresh capture from a live ExtensionRunner without emitting events. */
export function refresh_switch_session_capture_from_runner(runner: ExtensionRunner): void {
	refresh_from_runner(runner);
}

/** Resolve switchSession at call time from the live runner when available. */
export function resolve_switch_session_fn(): SwitchSessionFn | undefined {
	const state = global_state();
	if (state.activeRunner) {
		try {
			const cmd = state.activeRunner.createCommandContext();
			if (typeof cmd.switchSession === "function") {
				return (path, options) => cmd.switchSession(path, options);
			}
		} catch {
			// fall through to sticky capture
		}
	}
	return state.switchSession;
}
