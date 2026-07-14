import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	normalizePathConstraint,
	normalizeExcludes,
	buildQuery,
	buildExternalAllowlist,
	resolveExternalTarget,
	PI_CODING_AGENT_ALIAS,
} from "../query.ts";

describe("normalizePathConstraint", () => {
	test("empty string returns empty", () => {
		expect(normalizePathConstraint("")).toBe("");
	});

	test("dot returns null", () => {
		expect(normalizePathConstraint(".")).toBeNull();
		expect(normalizePathConstraint("./")).toBeNull();
	});

	test("bare directory gets trailing slash", () => {
		expect(normalizePathConstraint("src")).toBe("src/");
	});

	test("glob is preserved", () => {
		expect(normalizePathConstraint("*.ts")).toBe("*.ts");
		expect(normalizePathConstraint("src/**/*.cc")).toBe("src/**/*.cc");
	});

	test("filename with extension is preserved", () => {
		expect(normalizePathConstraint("main.rs")).toBe("main.rs");
	});

	test("recursive dir glob collapses to prefix", () => {
		expect(normalizePathConstraint("src/**")).toBe("src/");
		expect(normalizePathConstraint("src/**/*")).toBe("src/");
	});

	test("leading ./ is stripped", () => {
		expect(normalizePathConstraint("./src")).toBe("src/");
	});
});

describe("normalizeExcludes", () => {
	test("undefined returns empty array", () => {
		expect(normalizeExcludes(undefined)).toEqual([]);
	});

	test("comma-separated string is split", () => {
		expect(normalizeExcludes("test/, *.min.js")).toEqual(["!test/", "!*.min.js"]);
	});

	test("leading ! is tolerated", () => {
		expect(normalizeExcludes("!src/")).toEqual(["!src/"]);
	});

	test("array input works", () => {
		expect(normalizeExcludes(["test/", "vendor/"])).toEqual(["!test/", "!vendor/"]);
	});
});

describe("buildQuery", () => {
	test("assembles path + excludes + pattern", () => {
		const q = buildQuery("src/", "MyClass", "test/");
		expect(q).toContain("src/");
		expect(q).toContain("!test/");
		expect(q).toContain("MyClass");
	});

	test("no path or excludes yields just pattern", () => {
		expect(buildQuery(undefined, "foo")).toBe("foo");
	});
});

// ---------------------------------------------------------------------------
// ExternalAllowlist — auto-detection and resolveExternalTarget
// ---------------------------------------------------------------------------

describe("ExternalAllowlist", () => {
	const allowlist = buildExternalAllowlist();
	const has_entries = allowlist.entries.length > 0;
	const cwd = process.cwd();

	test("buildExternalAllowlist auto-detects the package dir", () => {
		expect(allowlist.entries.length).toBeGreaterThanOrEqual(1);
		expect(allowlist.entries[0].alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(path.isAbsolute(allowlist.entries[0].dir)).toBe(true);
	});

	test("resolveExternalTarget with ./pi-coding-agent alias → bare dir", () => {
		if (!has_entries) return;
		const target = resolveExternalTarget("./pi-coding-agent", allowlist);
		expect(target).toBeDefined();
		expect(target!.entry.alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(target!.relativePath).toBe("");
	});

	test("resolveExternalTarget with pi-coding-agent alias (no ./) → bare dir", () => {
		if (!has_entries) return;
		const target = resolveExternalTarget("pi-coding-agent", allowlist);
		expect(target).toBeDefined();
		expect(target!.entry.alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(target!.relativePath).toBe("");
	});

	test("resolveExternalTarget with ./pi-coding-agent/docs → subpath", () => {
		if (!has_entries) return;
		const target = resolveExternalTarget("./pi-coding-agent/docs", allowlist);
		expect(target).toBeDefined();
		expect(target!.entry.alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(target!.relativePath).toBe("docs");
	});

	test("resolveExternalTarget with ./pi-coding-agent/docs/extensions.md → deep subpath", () => {
		if (!has_entries) return;
		const target = resolveExternalTarget(
			"./pi-coding-agent/docs/extensions.md",
			allowlist,
		);
		expect(target).toBeDefined();
		expect(target!.entry.alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(target!.relativePath).toBe("docs/extensions.md");
	});

	test("resolveExternalTarget with absolute path under allowlisted dir", () => {
		if (!has_entries) return;
		const abs = path.join(allowlist.entries[0].dir, "docs", "extensions.md");
		const target = resolveExternalTarget(abs, allowlist);
		expect(target).toBeDefined();
		expect(target!.entry.alias).toBe(PI_CODING_AGENT_ALIAS);
		expect(target!.relativePath).toBe("docs/extensions.md");
	});

	test("resolveExternalTarget returns undefined for workspace-relative src/", () => {
		expect(resolveExternalTarget("src/", allowlist)).toBeUndefined();
	});

	test("resolveExternalTarget returns undefined for ./src", () => {
		expect(resolveExternalTarget("./src", allowlist)).toBeUndefined();
	});

	test("resolveExternalTarget returns undefined for undefined input", () => {
		expect(resolveExternalTarget(undefined, allowlist)).toBeUndefined();
	});

	test("resolveExternalTarget returns undefined for empty string", () => {
		expect(resolveExternalTarget("", allowlist)).toBeUndefined();
	});

	test("resolveExternalTarget returns undefined for alias-prefix mismatch (pi-coding-agent-foo)", () => {
		expect(resolveExternalTarget("pi-coding-agent-foo", allowlist)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// normalizePathConstraint with allowlist
// ---------------------------------------------------------------------------

describe("normalizePathConstraint with allowlist", () => {
	const allowlist = buildExternalAllowlist();
	const has_entries = allowlist.entries.length > 0;
	const cwd = process.cwd();

	test("allowlisted ./pi-coding-agent → null (bare dir)", () => {
		if (!has_entries) return;
		expect(normalizePathConstraint("./pi-coding-agent", cwd, allowlist)).toBeNull();
	});

	test("allowlisted ./pi-coding-agent/docs → docs/ (trailing slash)", () => {
		if (!has_entries) return;
		expect(normalizePathConstraint("./pi-coding-agent/docs", cwd, allowlist)).toBe("docs/");
	});

	test("allowlisted ./pi-coding-agent/docs/extensions.md → preserved filename", () => {
		if (!has_entries) return;
		expect(
			normalizePathConstraint("./pi-coding-agent/docs/extensions.md", cwd, allowlist),
		).toBe("docs/extensions.md");
	});

	test("allowlisted absolute path under package dir → relative with trailing slash", () => {
		if (!has_entries) return;
		const abs = path.join(allowlist.entries[0].dir, "docs");
		expect(normalizePathConstraint(abs, cwd, allowlist)).toBe("docs/");
	});

	test("non-allowlisted absolute path /etc/passwd → throws", () => {
		expect(() => normalizePathConstraint("/etc/passwd", cwd, allowlist)).toThrow(
			"Path constraint must be relative to the workspace: /etc/passwd",
		);
	});

	test("workspace-relative src → src/ (unchanged with allowlist)", () => {
		expect(normalizePathConstraint("src", cwd, allowlist)).toBe("src/");
	});

	test("workspace-relative glob *.ts → *.ts (unchanged with allowlist)", () => {
		expect(normalizePathConstraint("*.ts", cwd, allowlist)).toBe("*.ts");
	});

	test("workspace-relative dot → null (unchanged with allowlist)", () => {
		expect(normalizePathConstraint(".", cwd, allowlist)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// buildQuery with external target
// ---------------------------------------------------------------------------

describe("buildQuery with external target", () => {
	const allowlist = buildExternalAllowlist();
	const has_entries = allowlist.entries.length > 0;
	const cwd = process.cwd();

	test("buildQuery with ./pi-coding-agent/docs includes docs/ and pattern", () => {
		if (!has_entries) return;
		const q = buildQuery("./pi-coding-agent/docs", "renderCall", undefined, cwd, allowlist);
		expect(q).toContain("docs/");
		expect(q).toContain("renderCall");
	});
});
