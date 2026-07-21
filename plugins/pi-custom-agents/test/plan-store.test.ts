import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	list_plan_files,
	prune_plan_files,
	read_plan_file,
	write_plan_file,
	PLAN_FILE_MAX,
	get_plans_dir,
} from "../plan-store.ts";

const TEST_PI_HOME = path.join(os.tmpdir(), `pi-ember-stack-plan-store-test-${Date.now()}`);

describe("plan-store", () => {
	beforeEach(() => {
		process.env.PI_HOME = TEST_PI_HOME;
		fs.mkdirSync(get_plans_dir(), { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(TEST_PI_HOME, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
		delete process.env.PI_HOME;
	});

	test("write_plan_file returns a path and persists text", () => {
		const meta = write_plan_file("Module 1: test");
		expect(meta.path).toContain("/plans/plan-");
		expect(fs.existsSync(meta.path)).toBe(true);
		expect(read_plan_file(meta.path)).toContain("Module 1: test");
	});

	test("prune_plan_files deletes oldest files when over max", async () => {
		const files: string[] = [];
		for (let i = 0; i < PLAN_FILE_MAX + 3; i++) {
			// Ensure distinct mtimes.
			await new Promise((r) => setTimeout(r, 10));
			const meta = write_plan_file(`Plan ${i}`);
			files.push(meta.path);
		}
		prune_plan_files(PLAN_FILE_MAX);
		const remaining = list_plan_files();
		expect(remaining.length).toBe(PLAN_FILE_MAX);
		// Oldest three should be gone.
		for (const old of files.slice(0, 3)) {
			expect(fs.existsSync(old)).toBe(false);
		}
		// Newest max should remain.
		for (const kept of files.slice(-PLAN_FILE_MAX)) {
			expect(fs.existsSync(kept)).toBe(true);
		}
	});

	test("list_plan_files orders by mtime ascending", async () => {
		const meta1 = write_plan_file("first");
		await new Promise((r) => setTimeout(r, 20));
		const meta2 = write_plan_file("second");
		const listed = list_plan_files();
		expect(listed.length).toBe(2);
		expect(listed[0].path).toBe(meta1.path);
		expect(listed[1].path).toBe(meta2.path);
	});
});
