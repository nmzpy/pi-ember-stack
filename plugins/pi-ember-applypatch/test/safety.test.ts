import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { make_temp_workspace } from "../apply.ts";
import { resolve_under_root } from "../safety.ts";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
});

describe("resolve_under_root", () => {
	test("resolves relative path under root", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		const r = resolve_under_root(root, "src/a.ts");
		expect(r.relative).toBe("src/a.ts");
		expect(r.absolute).toBe(path.resolve(root, "src/a.ts"));
	});

	test("rejects absolute unix path", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		expect(() => resolve_under_root(root, "/etc/passwd")).toThrow(/Absolute/);
	});

	test("rejects absolute windows-style path", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		expect(() => resolve_under_root(root, "C:\\Windows\\System32")).toThrow(/Absolute/);
	});

	test("rejects parent traversal", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		expect(() => resolve_under_root(root, "../outside.txt")).toThrow(/escapes/);
	});

	test("rejects nested traversal", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		expect(() => resolve_under_root(root, "src/../../outside.txt")).toThrow(/escapes/);
	});

	test("rejects empty path", () => {
		const root = make_temp_workspace("applypatch-safety-");
		temps.push(root);
		expect(() => resolve_under_root(root, "   ")).toThrow(/empty/i);
	});
});
