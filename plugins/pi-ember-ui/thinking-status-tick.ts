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
let render_request: (() => void) | undefined;

function dispatch_thinking_status_tick(): void {
	widget_host?.invalidate?.();
	in_message_host?.invalidate?.();
	render_request?.();
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

/** Bind Pi's public render request so gradient ticks repaint Thinking hosts. */
export function set_thinking_status_render_request(cb: (() => void) | undefined): void {
	render_request = cb;
}

/** Keep the 20 FPS clock subscribed while any Thinking host is visible. */
export function sync_thinking_status_tick(should_run: boolean): void {
	if (should_run) ensure_thinking_status_tick();
	else if (!widget_host && !in_message_host) drop_thinking_status_tick();
}

/** Wire the above-editor Thinking widget to the shared 20 FPS gradient clock. */
export function bind_thinking_widget_host(host: ThinkingStatusHost | undefined): void {
	widget_host = host;
	if (host) ensure_thinking_status_tick();
	else if (!in_message_host) drop_thinking_status_tick();
}

/** Wire the in-message Thinking host to the shared gradient clock. */
export function bind_thinking_in_message_host(host: ThinkingStatusHost | undefined): void {
	in_message_host = host;
	if (host) ensure_thinking_status_tick();
	else if (!widget_host) drop_thinking_status_tick();
}

/** Clear all thinking-status tick wiring on session shutdown. */
export function unbind_thinking_status_hosts(): void {
	widget_host = undefined;
	in_message_host = undefined;
	drop_thinking_status_tick();
}
