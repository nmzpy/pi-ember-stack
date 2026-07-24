import { describe, expect, mock, test } from "bun:test";

/**
 * Regression test for the stable per-tool-call gradient subscription.
 *
 * The subagent extension stores one SubagentTickRecord per toolCallId.
 * The callback identity never changes — tick data (args/results/theme) is
 * updated in place. This prevents the JavaScript Set live-iteration hazard.
 */

interface SubagentTickRecord {
	readonly callback: () => void;
	readonly toolCallId: string;
	repaint: () => void;
}

const tickRecords = new Map<string, SubagentTickRecord>();
const subscribers = new Set<() => void>();

function getOrCreateTickRecord(toolCallId: string): SubagentTickRecord {
	let record = tickRecords.get(toolCallId);
	if (!record) {
		const rec: SubagentTickRecord = {
			callback: (): void => {
				rec.repaint();
			},
			toolCallId,
			repaint: mock(() => {}),
		};
		record = rec;
		tickRecords.set(toolCallId, record);
	}
	return record;
}

function updateTickRecord(toolCallId: string, repaint: () => void): SubagentTickRecord {
	const record = getOrCreateTickRecord(toolCallId);
	record.repaint = repaint;
	return record;
}

function subscribeTick(toolCallId: string, repaint: () => void): void {
	updateTickRecord(toolCallId, repaint);
	const record = getOrCreateTickRecord(toolCallId);
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
	test("callback identity is stable across data updates", () => {
		clearAllTickRecords();
		const id = "test-call-1";
		const repaint1 = mock(() => {});
		const repaint2 = mock(() => {});

		subscribeTick(id, repaint1);
		const record = tickRecords.get(id)!;
		const originalCallback = record.callback;

		updateTickRecord(id, repaint2);
		expect(record.callback).toBe(originalCallback);
		expect(subscribers.has(originalCallback)).toBe(true);

		dispatchTick();
		expect(repaint1).not.toHaveBeenCalled();
		expect(repaint2).toHaveBeenCalledTimes(1);

		clearAllTickRecords();
	});

	test("newest repaint target is called on tick", () => {
		clearAllTickRecords();
		const id = "test-call-2";
		const rep1 = mock(() => {});
		const rep2 = mock(() => {});
		const rep3 = mock(() => {});

		subscribeTick(id, rep1);
		updateTickRecord(id, rep2);
		updateTickRecord(id, rep3);

		dispatchTick();
		expect(rep1).not.toHaveBeenCalled();
		expect(rep2).not.toHaveBeenCalled();
		expect(rep3).toHaveBeenCalledTimes(1);

		clearAllTickRecords();
	});

	test("unsubscribe is idempotent", () => {
		clearAllTickRecords();
		const id = "test-call-3";
		subscribeTick(id, mock(() => {}));

		unsubscribeTick(id);
		unsubscribeTick(id);
		expect(tickRecords.has(id)).toBe(false);
		expect(subscribers.size).toBe(0);

		clearAllTickRecords();
	});

	test("simulated tick with mid-dispatch update remains bounded", () => {
		clearAllTickRecords();
		const id = "test-call-4";
		let callCount = 0;
		const rep1 = mock(() => {
			callCount++;
			updateTickRecord(id, rep2);
		});
		const rep2 = mock(() => {
			callCount++;
		});

		subscribeTick(id, rep1);
		dispatchTick();

		expect(callCount).toBe(1);
		expect(rep1).toHaveBeenCalledTimes(1);
		expect(rep2).not.toHaveBeenCalled();

		dispatchTick();
		expect(rep2).toHaveBeenCalledTimes(1);
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
		const repA = mock(() => {});
		const repB = mock(() => {});

		subscribeTick("call-a", repA);
		subscribeTick("call-b", repB);

		dispatchTick();
		expect(repA).toHaveBeenCalledTimes(1);
		expect(repB).toHaveBeenCalledTimes(1);

		unsubscribeTick("call-a");
		dispatchTick();
		expect(repA).toHaveBeenCalledTimes(1);
		expect(repB).toHaveBeenCalledTimes(2);

		clearAllTickRecords();
	});
});
