import { describe, expect, test } from "bun:test";
import {
	__transport_test_only_end_after_exit,
	spawn_bridge,
} from "../src/cloud-direct/transport.ts";
import { CURSOR_RUN_RPC_PATH } from "../src/cloud-direct/metadata.ts";

describe("Cursor h2 bridge transport", () => {
	test("bridge.end is idempotent after the child exits", async () => {
		const bridge = spawn_bridge({
			access_token: "invalid-token-for-test",
			rpc_path: CURSOR_RUN_RPC_PATH,
		});

		await new Promise<void>((resolve) => {
			bridge.on_close(() => resolve());
			try {
				bridge.proc.kill();
			} catch {
				// ignore
			}
		});

		expect(() => __transport_test_only_end_after_exit(bridge)).not.toThrow();
	});
});
