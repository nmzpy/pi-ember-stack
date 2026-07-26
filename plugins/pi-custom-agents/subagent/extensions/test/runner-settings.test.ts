import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	build_subagent_settings,
	is_context_overflow_error,
} from "../runner.ts";

const SUBAGENT_EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

describe("subagent session settings", () => {
	test("build_subagent_settings enables compaction and disables retry", () => {
		const settings = build_subagent_settings();
		expect(settings.compaction?.enabled).toBe(true);
		expect(settings.retry?.enabled).toBe(false);
	});

	test("child sessions load shared parent compaction wiring", () => {
		const runnerExtDir = path.resolve(SUBAGENT_EXT_DIR, "..");
		const wiringPath = path.resolve(runnerExtDir, "../../compaction-wiring.ts");
		expect(wiringPath.replace(/\\/g, "/").endsWith("pi-custom-agents/compaction-wiring.ts")).toBe(true);
	});

	test("is_context_overflow_error detects prompt-too-long errors", () => {
		expect(is_context_overflow_error("The prompt is too long for this model")).toBe(true);
		expect(is_context_overflow_error("401 Unauthorized")).toBe(false);
	});
});
