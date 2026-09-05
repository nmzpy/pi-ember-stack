// Runs under Bun: `bun test plugins/registry/test/registry-load.test.ts`.
// (registry-loader.ts is a pure module with no plugin imports, so it loads
// without the pi-ember-hashedit `node:sqlite` requirement.)
import { describe, expect, test } from "bun:test";
import { runEnabledPlugins, type StackPlugin } from "../../registry-loader.ts";

const PROVIDER_IDS = ["devin-auth", "pi-crof-auth", "pi-cursor-auth", "pi-novita-auth"];

// A canonical plugin list mirroring the real PLUGINS ordering: providers are
// contiguous (devin-auth, pi-crof-auth, pi-cursor-auth, pi-novita-auth) and
// sandwiched between non-provider plugins.
const plugins: StackPlugin[] = [
	{ id: "pi-compact-tools", description: "compact", extension: async () => {} },
	{ id: "pi-ember-applypatch", description: "applypatch", extension: async () => {} },
	{ id: "devin-auth", description: "devin", extension: async () => {} },
	{ id: "pi-crof-auth", description: "crof", extension: async () => {} },
	{ id: "pi-cursor-auth", description: "cursor", extension: async () => {} },
	{ id: "pi-novita-auth", description: "novita", extension: async () => {} },
	{ id: "pi-ember-images", description: "images", extension: async () => {} },
	{ id: "pi-custom-agents", description: "custom-agents", extension: async () => {} },
	{ id: "pi-ember-ui", description: "ui", extension: async () => {} },
];

const allEnabled = new Set(plugins.map((plugin) => plugin.id));

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runEnabledPlugins registry loading", () => {
	test("runs every enabled plugin in canonical order", async () => {
		const order: string[] = [];
		await runEnabledPlugins(plugins, allEnabled, async (plugin) => {
			order.push(plugin.id);
		});
		expect(order).toEqual([
			"pi-compact-tools",
			"pi-ember-applypatch",
			"devin-auth",
			"pi-crof-auth",
			"pi-cursor-auth",
			"pi-novita-auth",
			"pi-ember-images",
			"pi-custom-agents",
			"pi-ember-ui",
		]);
	});

	test("skips disabled plugins", async () => {
		const order: string[] = [];
		const enabled = new Set(["pi-compact-tools", "pi-custom-agents"]);
		await runEnabledPlugins(plugins, enabled, async (plugin) => {
			order.push(plugin.id);
		});
		expect(order).toEqual(["pi-compact-tools", "pi-custom-agents"]);
	});

	test("provider plugins run concurrently so their network waits overlap (Promise.all)", async () => {
		const events: string[] = [];
		await runEnabledPlugins(plugins, allEnabled, async (plugin) => {
			events.push(`start:${plugin.id}`);
			await sleep(10);
			events.push(`end:${plugin.id}`);
		});
		// With Promise.all every provider factory starts synchronously before the
		// first 10ms timer fires, so the last provider start precedes the first
		// provider end. Sequential execution would interleave start/end per
		// plugin and fail this assertion.
		const lastStart = Math.max(...PROVIDER_IDS.map((id) => events.indexOf(`start:${id}`)));
		const firstEnd = Math.min(...PROVIDER_IDS.map((id) => events.indexOf(`end:${id}`)));
		expect(lastStart).toBeLessThan(firstEnd);
		// And every provider is started exactly once.
		for (const id of PROVIDER_IDS) {
			expect(events.filter((event) => event === `start:${id}`)).toHaveLength(1);
			expect(events.filter((event) => event === `end:${id}`)).toHaveLength(1);
		}
	});

	test("non-provider plugins still run sequentially (no overlap)", async () => {
		const events: string[] = [];
		const nonProviders = plugins.filter((plugin) => !PROVIDER_IDS.includes(plugin.id));
		await runEnabledPlugins(plugins, allEnabled, async (plugin) => {
			if (!PROVIDER_IDS.includes(plugin.id)) {
				events.push(`start:${plugin.id}`);
				await sleep(2);
				events.push(`end:${plugin.id}`);
			}
		});
		// Each non-provider plugin's end must precede the next non-provider start.
		for (let i = 0; i < nonProviders.length - 1; i++) {
			const curEnd = events.indexOf(`end:${nonProviders[i].id}`);
			const nextStart = events.indexOf(`start:${nonProviders[i + 1].id}`);
			expect(curEnd).toBeLessThan(nextStart);
		}
	});

	test("provider batch rejects on the first error (fail-fast, not swallowed)", async () => {
		const boom = new Error("catalog prime failed");
		await expect(
			runEnabledPlugins(plugins, allEnabled, async (plugin) => {
				if (plugin.id === "pi-crof-auth") throw boom;
				await sleep(5);
			}),
		).rejects.toThrow("catalog prime failed");
	});

	test("non-provider errors propagate (fail-fast)", async () => {
		const boom = new Error("images failed");
		await expect(
			runEnabledPlugins(plugins, allEnabled, async (plugin) => {
				if (plugin.id === "pi-ember-images") throw boom;
			}),
		).rejects.toThrow("images failed");
	});
});