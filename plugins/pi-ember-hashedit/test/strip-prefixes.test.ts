// Run with: node --experimental-strip-types --test plugins/pi-ember-hashedit/test/strip-prefixes.test.ts
// (Bun lacks node:sqlite which hash-store imports at module load; the pure
// functions under test never touch sqlite. Node has node:sqlite built in.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripBarePrefixes, type HEdit } from "../src/hashline/resolve.ts";
import { _lineHashesPure, initHasher } from "../src/hashline/hash.ts";

await initHasher();

function makeEdit(content_lines: string[], fromHash: string, toHash: string): HEdit {
	return {
		content_lines,
		hash_bounds: [{ hash: fromHash }, { hash: toHash }],
	};
}

test("exact 3-char prefix matching a real file hash is stripped silently (no warning)", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit([`${firstHash}│alpha`, "delta"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["alpha", "delta"]);
	assert.deepEqual(warnings, []);
});

test("exact 3-char prefix NOT matching a file hash is stripped with a warning", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit(["zzz│alpha", "delta"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["alpha", "delta"]);
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]!.includes("E_BARE_HASH_PREFIX"));
});

test("near-miss 4-char prefix is stripped so a literal │ does not leak", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit(["P9n2│    def test_x():", "    pass"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["    def test_x():", "    pass"]);
	assert.ok(!result.content_lines[0]!.includes("│"));
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0]!.includes("near-miss"));
});

test("near-miss 2-char prefix is stripped", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit(["Ab│alpha"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["alpha"]);
	assert.equal(warnings.length, 1);
});

test("line without a prefix is left untouched", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit(["alpha", "beta"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["alpha", "beta"]);
	assert.deepEqual(warnings, []);
});

test("content that legitimately starts with a 3-char run + │ but is not a file hash warns", () => {
	const content = "alpha\nbeta\ngamma\n";
	const hashes = _lineHashesPure(content);
	const firstHash = hashes[0]!;
	const warnings: string[] = [];
	const edit = makeEdit(["foo│bar"], firstHash, firstHash);
	const result = stripBarePrefixes(edit, hashes, warnings);
	assert.deepEqual(result.content_lines, ["bar"]);
	assert.equal(warnings.length, 1);
});
