import {
	subscribe_gradient_tick,
	unsubscribe_gradient_tick,
} from "./gradient.ts";

type ThinkingStatusHost = {
	invalidate?: () => void;
};

let widget_host: ThinkingStatusHost | undefined;
let in_message_host: ThinkingStatusHost | undefined;
let thinking_status_tick_cb: (() => void) | undefined;
let should_paint_fn: () => boolean = () => false;

/** Wire the live should-paint predicate from pi-ember-ui/index.ts (avoids circular imports). */
export function bind_thinking_status_tick_should_paint(fn: () => boolean): void {
	should_paint_fn = fn;
}

function dispatch_thinking_status_tick(): void {
	if (!should_paint_fn()) return;
	widget_host?.invalidate?.();
	in_message_host?.invalidate?.();
}

function ensure_thinking_status_tick(): void {
	if (thinking_status_tick_cb) return;
	thinking_status_tick_cb = dispatch_thinking_status_tick;
	subscribe_gradient_tick(thinking_status_tick_cb);
}

function drop_thinking_status_tick(): void {
	if (!thinking_status_tick_cb) return;
	unsubscribe_gradient_tick(thinking_status_tick_cb);
	thinking_status_tick_cb = undefined;
}

/** Subscribe/unsubscribe the 20 FPS clock — owned by sync_thinking_gradient_clock only. */
export function sync_thinking_status_tick(should_run: boolean): void {
	if (should_run) ensure_thinking_status_tick();
	else drop_thinking_status_tick();
}

/** Store the above-editor Thinking widget host — does not subscribe the clock. */
export function bind_thinking_widget_host(host: ThinkingStatusHost | undefined): void {
	widget_host = host;
}

/** Store the in-message Thinking host — does not subscribe the clock. */
export function bind_thinking_in_message_host(host: ThinkingStatusHost | undefined): void {
	in_message_host = host;
}

/** Clear all thinking-status tick wiring on session shutdown. */
export function unbind_thinking_status_hosts(): void {
	widget_host = undefined;
	in_message_host = undefined;
	drop_thinking_status_tick();
}
