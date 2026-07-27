import { describe, expect, test } from "bun:test";
import { dispatch_gradient_tick, gradient_clock_is_idle, shutdown_gradient_clock } from "../gradient.ts";
import {
	bind_thinking_status_tick_should_paint,
	bind_thinking_widget_host,
	sync_thinking_status_tick,
	unbind_thinking_status_hosts,
} from "../thinking-status-tick.ts";

describe("thinking status tick lifecycle", () => {
	test("bind widget host does not subscribe the gradient clock", () => {
		shutdown_gradient_clock();
		bind_thinking_status_tick_should_paint(() => false);
		bind_thinking_widget_host({ invalidate: () => {} });
		try {
			expect(gradient_clock_is_idle()).toBe(true);
			dispatch_gradient_tick();
			expect(gradient_clock_is_idle()).toBe(true);
		} finally {
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});

	test("sync false drops tick even when widget host is bound", () => {
		shutdown_gradient_clock();
		let invalidate_calls = 0;
		bind_thinking_status_tick_should_paint(() => false);
		bind_thinking_widget_host({
			invalidate: () => {
				invalidate_calls++;
			},
		});
		sync_thinking_status_tick(true);
		sync_thinking_status_tick(false);
		try {
			expect(gradient_clock_is_idle()).toBe(true);
			dispatch_gradient_tick();
			expect(invalidate_calls).toBe(0);
		} finally {
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});

	test("tick invalidates only when should_paint is true", () => {
		shutdown_gradient_clock();
		let invalidate_calls = 0;
		let should_paint = false;
		bind_thinking_status_tick_should_paint(() => should_paint);
		bind_thinking_widget_host({
			invalidate: () => {
				invalidate_calls++;
			},
		});
		sync_thinking_status_tick(true);
		try {
			dispatch_gradient_tick();
			expect(invalidate_calls).toBe(0);
			should_paint = true;
			dispatch_gradient_tick();
			expect(invalidate_calls).toBe(1);
		} finally {
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});
});
