import { describe, expect, test } from "bun:test";
import { dispatch_gradient_tick, gradient_clock_is_idle, shutdown_gradient_clock } from "../gradient.ts";
import {
	bind_thinking_status_tick_builder,
	bind_thinking_status_tick_host_resolver,
	bind_thinking_status_tick_should_paint,
	bind_thinking_widget_host,
	bind_thinking_in_message_host,
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

	test("external Thinking repaint matches the shared 20 FPS cadence", () => {
		shutdown_gradient_clock();
		const original_now = performance.now;
		let now = 1_000;
		performance.now = () => now;
		let invalidate_calls = 0;
		bind_thinking_status_tick_should_paint(() => true);
		bind_thinking_status_tick_host_resolver(() => "widget");
		bind_thinking_status_tick_builder(() => `Thinking ${now}`);
		bind_thinking_widget_host({ invalidate: () => invalidate_calls++ });
		sync_thinking_status_tick(true);
		try {
			dispatch_gradient_tick();
			now += 50;
			dispatch_gradient_tick();
			now += 50;
			dispatch_gradient_tick();
			// External hosts repaint at the shared 20 FPS cadence (every 50 ms
			// tick), matching the in-group `└ Thinking` lane. The identical-text
			// guard suppresses redundant renders when the phase produced no
			// visible change; here each tick stages distinct text.
			expect(invalidate_calls).toBe(3);
		} finally {
			performance.now = original_now;
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});

	test("external Thinking skips invalidation when staged text is unchanged", () => {
		shutdown_gradient_clock();
		const original_now = performance.now;
		let now = 1_000;
		performance.now = () => now;
		let invalidate_calls = 0;
		bind_thinking_status_tick_should_paint(() => true);
		bind_thinking_status_tick_host_resolver(() => "widget");
		bind_thinking_status_tick_builder(() => `Thinking static`);
		bind_thinking_widget_host({ invalidate: () => invalidate_calls++ });
		sync_thinking_status_tick(true);
		try {
			dispatch_gradient_tick();
			now += 50;
			dispatch_gradient_tick();
			now += 50;
			dispatch_gradient_tick();
			// The identical-text guard suppresses redundant renders when the
			// phase produced no visible change, even at the shared 20 FPS
			// cadence.
			expect(invalidate_calls).toBe(1);
		} finally {
			performance.now = original_now;
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});

	test("tick invalidates only the resolved external host", () => {
		shutdown_gradient_clock();
		let widget_invalidations = 0;
		let message_invalidations = 0;
		bind_thinking_status_tick_should_paint(() => true);
		bind_thinking_status_tick_host_resolver(() => "in_message");
		bind_thinking_widget_host({ invalidate: () => widget_invalidations++ });
		bind_thinking_in_message_host({ invalidate: () => message_invalidations++ });
		sync_thinking_status_tick(true);
		try {
			dispatch_gradient_tick();
			expect(widget_invalidations).toBe(0);
			expect(message_invalidations).toBe(1);
		} finally {
			unbind_thinking_status_hosts();
			shutdown_gradient_clock();
		}
	});
});
