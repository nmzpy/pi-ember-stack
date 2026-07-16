import { describe, expect, mock, test } from "bun:test";

/**
 * Regression test for the stable per-tool-call gradient subscription.
 *
 * The subagent extension stores one SubagentTickRecord per toolCallId.
 * The callback identity never changes — only the invalidate target is
 * rebound. This prevents the JavaScript Set live-iteration hazard where
 * a rebind during dispatch causes recursive/infinite invalidation.
 *
 * This test simulates the subscription lifecycle without loading the
 * full extension (which requires a Pi ExtensionAPI). It verifies:
 *   - Callback identity is stable across rebinds.
 *   - The newest invalidate target is called on tick.
 *   - Unsubscribe is idempotent.
 *   - A simulated tick dispatch remains bounded even if the callback
 *     rebinds its own target mid-dispatch.
 */

interface SubagentTickRecord {
	readonly callback: () => void;
	invalidateTarget: (() => void) | undefined;
}

const tickRecords = new Map<string, SubagentTickRecord>();
const subscribers = new Set<() => void>();

function getOrCreateTickRecord(toolCallId: string): SubagentTickRecord {
	let record = tickRecords.get(toolCallId);
	if (!record) {
		const rec: SubagentTickRecord = {
			callback: (): void => {
				rec.invalidateTarget?.();
			},
			invalidateTarget: undefined,
		};
		record = rec;
		tickRecords.set(toolCallId, record);
	}
	return record;
}

function rebindTickTarget(toolCallId: string, invalidate: (() => void) | undefined): void {
	const record = getOrCreateTickRecord(toolCallId);
	record.invalidateTarget = invalidate;
}

function subscribeTick(toolCallId: string, invalidate: (() => void) | undefined): void {
	const record = getOrCreateTickRecord(toolCallId);
	record.invalidateTarget = invalidate;
	subscribers.add(record.callback);
}

function unsubscribeTick(toolCallId: string): void {
	const record = tickRecords.get(toolCallId);
	if (!record) return;
	subscribers.delete(record.callback);
	tickRecords.delete(toolCallId);
}

function clearAllTickRecords(): void {
	for (const record of tickRecords.values()) {
		subscribers.delete(record.callback);
	}
	tickRecords.clear();
}

function dispatchTick(): void {
	const snapshot = [...subscribers];
	for (const cb of snapshot) {
		if (!subscribers.has(cb)) continue;
		cb();
	}
}

describe("stable subagent tick subscription", () => {
	test("callback identity is stable across rebinds", () => {
		clearAllTickRecords();
		const id = "test-call-1";
		const invalidate1 = mock(() => {});
		const invalidate2 = mock(() => {});

		subscribeTick(id, invalidate1);
		const record = tickRecords.get(id)!;
		const originalCallback = record.callback;

		rebindTickTarget(id, invalidate2);
		expect(record.callback).toBe(originalCallback);
		expect(subscribers.has(originalCallback)).toBe(true);
		expect(record.invalidateTarget).toBe(invalidate2);

		dispatchTick();
		expect(invalidate1).not.toHaveBeenCalled();
		expect(invalidate2).toHaveBeenCalledTimes(1);

		clearAllTickRecords();
	});

	test("newest invalidate target is called on tick", () => {
		clearAllTickRecords();
		const id = "test-call-2";
		const inv1 = mock(() => {});
		const inv2 = mock(() => {});
		const inv3 = mock(() => {});

		subscribeTick(id, inv1);
		rebindTickTarget(id, inv2);
		rebindTickTarget(id, inv3);

		dispatchTick();
		expect(inv1).not.toHaveBeenCalled();
		expect(inv2).not.toHaveBeenCalled();
		expect(inv3).toHaveBeenCalledTimes(1);

		clearAllTickRecords();
	});

	test("unsubscribe is idempotent", () => {
		clearAllTickRecords();
		const id = "test-call-3";
		subscribeTick(id, mock(() => {}));

		unsubscribeTick(id);
		unsubscribeTick(id); // second call is a no-op
		expect(tickRecords.has(id)).toBe(false);
		expect(subscribers.size).toBe(0);

		clearAllTickRecords();
	});

	test("simulated tick with mid-dispatch rebind remains bounded", () => {
		clearAllTickRecords();
		const id = "test-call-4";
		let callCount = 0;
		const inv1 = mock(() => {
			callCount++;
			// Simulate a rebind during dispatch (as renderCall might do)
			rebindTickTarget(id, inv2);
		});
		const inv2 = mock(() => {
			callCount++;
		});

		subscribeTick(id, inv1);
		dispatchTick();

		// inv1 called once, inv2 not called in this dispatch (snapshot)
		expect(callCount).toBe(1);
		expect(inv1).toHaveBeenCalledTimes(1);
		expect(inv2).not.toHaveBeenCalled();

		// Next tick calls inv2 (the rebound target)
		dispatchTick();
		expect(inv2).toHaveBeenCalledTimes(1);
		expect(callCount).toBe(2);

		// Total calls = 2, not infinite
		expect(callCount).toBe(2);

		clearAllTickRecords();
	});

	test("clearAll removes all records and subscribers", () => {
		clearAllTickRecords();
		subscribeTick("a", mock(() => {}));
		subscribeTick("b", mock(() => {}));
		expect(tickRecords.size).toBe(2);
		expect(subscribers.size).toBe(2);

		clearAllTickRecords();
		expect(tickRecords.size).toBe(0);
		expect(subscribers.size).toBe(0);
	});

	test("multiple tool call ids have independent subscriptions", () => {
		clearAllTickRecords();
		const invA = mock(() => {});
		const invB = mock(() => {});

		subscribeTick("call-a", invA);
		subscribeTick("call-b", invB);

		dispatchTick();
		expect(invA).toHaveBeenCalledTimes(1);
		expect(invB).toHaveBeenCalledTimes(1);

		unsubscribeTick("call-a");
		dispatchTick();
		expect(invA).toHaveBeenCalledTimes(1); // not called again
		expect(invB).toHaveBeenCalledTimes(2); // called again

		clearAllTickRecords();
	});
});
