import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import {
	isAgentRunPending,
	setAgentRunPending,
	setPlanAutoContinuing,
	setQuizActive,
} from "../../pi-ember-ui/mode-colors.ts";
import {
	AUTO_COMPACT_CONTEXT_TOKENS,
	auto_compact_reserve_tokens,
	install_auto_compact,
	should_auto_compact,
} from "../auto-compact.ts";

/** Pi's own default reserve (the floor Ember must never go below). */
const PI_RESERVE = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

describe("auto-compaction ceiling", () => {
	test("lands Pi's native threshold on the ceiling for large windows", () => {
		const context_window = 1_000_000;
		const reserve = auto_compact_reserve_tokens(context_window);
		expect(reserve).toBe(700_000);
		// Pi fires when `contextTokens > contextWindow - reserveTokens`.
		expect(context_window - reserve).toBe(AUTO_COMPACT_CONTEXT_TOKENS);
	});

	test("keeps Pi's own default reserve for windows at or below the ceiling", () => {
		expect(auto_compact_reserve_tokens(AUTO_COMPACT_CONTEXT_TOKENS)).toBe(PI_RESERVE);
		expect(auto_compact_reserve_tokens(200_000)).toBe(PI_RESERVE);
		// Boundary: ceiling + default reserve is the first window where a derived
		// reserve beats Pi's default instead of shrinking the output room.
		expect(auto_compact_reserve_tokens(AUTO_COMPACT_CONTEXT_TOKENS + PI_RESERVE)).toBe(PI_RESERVE);
		expect(auto_compact_reserve_tokens(AUTO_COMPACT_CONTEXT_TOKENS + PI_RESERVE + 1)).toBe(
			PI_RESERVE + 1,
		);
	});

	test("an unknown window keeps Pi's own default reserve", () => {
		expect(auto_compact_reserve_tokens(undefined)).toBe(PI_RESERVE);
		expect(auto_compact_reserve_tokens(0)).toBe(PI_RESERVE);
		expect(auto_compact_reserve_tokens(-1)).toBe(PI_RESERVE);
	});

	test("should_auto_compact fires only at or above the ceiling with a known count", () => {
		expect(should_auto_compact(AUTO_COMPACT_CONTEXT_TOKENS)).toBe(true);
		expect(should_auto_compact(AUTO_COMPACT_CONTEXT_TOKENS + 1)).toBe(true);
		expect(should_auto_compact(AUTO_COMPACT_CONTEXT_TOKENS - 1)).toBe(false);
		expect(should_auto_compact(null)).toBe(false);
		expect(should_auto_compact(undefined)).toBe(false);
		expect(should_auto_compact(Number.NaN)).toBe(false);
	});
});

interface CompactCall {
	onComplete?: (result: unknown) => void;
	onError?: (error: Error) => void;
}

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

function make_harness() {
	const handlers = new Map<string, FakeHandler[]>();
	const pi = {
		on: (event: string, handler: FakeHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	install_auto_compact(pi);

	return {
		/** Fire the lifecycle event the way Pi does, then let the deferred check run. */
		async settle(ctx: ExtensionContext): Promise<void> {
			for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
		async shutdown(): Promise<void> {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, undefined);
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
	};
}

function make_ctx(options: {
	tokens: number | null;
	idle?: boolean;
	complete?: boolean;
	hasUI?: boolean;
}) {
	const calls: CompactCall[] = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		isIdle: () => options.idle ?? true,
		getContextUsage: () => ({
			tokens: options.tokens,
			contextWindow: 1_000_000,
			percent: null,
		}),
		compact: (call?: CompactCall) => {
			calls.push(call ?? {});
			if (options.complete ?? true) call?.onComplete?.({});
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

beforeEach(async () => {
	setQuizActive(false);
	setPlanAutoContinuing(false);
	setAgentRunPending(false);
	// Reset the module's in-flight/pending state between tests.
	await make_harness().shutdown();
});

describe("parent session ceiling check", () => {
	test("compacts a settled session that reached the ceiling", async () => {
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 5 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(1);
	});

	test("leaves a session below the ceiling alone", async () => {
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS - 1 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);
	});

	test("an open overlay owns the transcript and defers compaction", async () => {
		setQuizActive(true);
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);

		// Once the overlay closes, the next check compacts.
		setQuizActive(false);
		await harness.settle(ctx);
		expect(calls).toHaveLength(1);
	});

	test("output-limit recovery owns its settle", async () => {
		setPlanAutoContinuing(true);
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);
	});

	test("a pending agent run is never interrupted", async () => {
		setAgentRunPending(true);
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);
	});

	test("a streaming session is never interrupted", async () => {
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1, idle: false });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);
	});

	test("a headless (print/JSON) session has no next turn to compact for", async () => {
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1, hasUI: false });
		await harness.settle(ctx);
		expect(calls).toHaveLength(0);
	});

	test("only one compaction may be in flight", async () => {
		const harness = make_harness();
		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1, complete: false });
		await harness.settle(ctx);
		await harness.settle(ctx);
		expect(calls).toHaveLength(1);
	});

	test("a replaced session (stale ctx) does not throw and re-arms next settle", async () => {
		const harness = make_harness();
		const stale = {
			get hasUI(): boolean {
				throw new Error("Extension context is no longer active");
			},
			isIdle: () => {
				throw new Error("Extension context is no longer active");
			},
			getContextUsage: () => {
				throw new Error("Extension context is no longer active");
			},
			compact: () => {
				throw new Error("Extension context is no longer active");
			},
		} as unknown as ExtensionContext;
		await harness.settle(stale);

		const { ctx, calls } = make_ctx({ tokens: AUTO_COMPACT_CONTEXT_TOKENS + 1 });
		await harness.settle(ctx);
		expect(calls).toHaveLength(1);
	});
});

describe("mode-colors guards used by the ceiling check", () => {
	test("isAgentRunPending reflects the shared flag", () => {
		setAgentRunPending(true);
		expect(isAgentRunPending()).toBe(true);
		setAgentRunPending(false);
		expect(isAgentRunPending()).toBe(false);
	});
});
