import { describe, expect, test } from "bun:test";
import {
	build_auto_continue_content,
	is_benign_compact_error,
	should_skip_compact,
	COMPACT_FOCUS_INSTRUCTIONS,
	DEFAULT_AUTO_CONTINUE_MAX_CHARS,
} from "../auto-continue.ts";

// ---------------------------------------------------------------------------
// should_skip_compact
// ---------------------------------------------------------------------------

describe("should_skip_compact", () => {
	test("true when last entry type is compaction", () => {
		expect(should_skip_compact([{ type: "message" }, { type: "compaction" }])).toBe(true);
	});

	test("false when last entry is message/other", () => {
		expect(should_skip_compact([{ type: "message" }])).toBe(false);
		expect(should_skip_compact([{ type: "assistant" }, { type: "user" }])).toBe(false);
	});

	test("false on empty array", () => {
		expect(should_skip_compact([])).toBe(false);
	});

	test("true when last non-null entry is compaction (trailing nulls)", () => {
		expect(should_skip_compact([{ type: "compaction" }, null, undefined])).toBe(true);
	});

	test("false when all entries are null/undefined", () => {
		expect(should_skip_compact([null, undefined, null])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// is_benign_compact_error
// ---------------------------------------------------------------------------

describe("is_benign_compact_error", () => {
	test("true for Error('Already compacted')", () => {
		expect(is_benign_compact_error(new Error("Already compacted"))).toBe(true);
	});

	test("true for string 'Nothing to compact (session too small)'", () => {
		expect(is_benign_compact_error("Nothing to compact (session too small)")).toBe(true);
	});

	test("true for 'Compaction failed: Already compacted'", () => {
		expect(is_benign_compact_error("Compaction failed: Already compacted")).toBe(true);
	});

	test("true for Error with 'Compaction failed: Nothing to compact'", () => {
		expect(is_benign_compact_error(new Error("Compaction failed: Nothing to compact"))).toBe(true);
	});

	test("false for unrelated errors", () => {
		expect(is_benign_compact_error(new Error("Network timeout"))).toBe(false);
		expect(is_benign_compact_error("Something went wrong")).toBe(false);
		expect(is_benign_compact_error(42)).toBe(false);
		expect(is_benign_compact_error(null)).toBe(false);
		expect(is_benign_compact_error(undefined)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// COMPACT_FOCUS_INSTRUCTIONS
// ---------------------------------------------------------------------------

describe("COMPACT_FOCUS_INSTRUCTIONS", () => {
	test("contains all four required labels", () => {
		expect(COMPACT_FOCUS_INSTRUCTIONS).toContain("goal:");
		expect(COMPACT_FOCUS_INSTRUCTIONS).toContain("done:");
		expect(COMPACT_FOCUS_INSTRUCTIONS).toContain("left:");
		expect(COMPACT_FOCUS_INSTRUCTIONS).toContain("files:");
	});

	test("forbids markdown headers", () => {
		expect(COMPACT_FOCUS_INSTRUCTIONS.toLowerCase()).toContain("no markdown headers");
	});

	test("mentions output token limit context", () => {
		expect(COMPACT_FOCUS_INSTRUCTIONS).toContain("output token limit");
	});

	test("forbids bold and italics", () => {
		const lower = COMPACT_FOCUS_INSTRUCTIONS.toLowerCase();
		expect(lower).toContain("bold");
		expect(lower).toContain("italics");
	});
});

// ---------------------------------------------------------------------------
// build_auto_continue_content
// ---------------------------------------------------------------------------

describe("build_auto_continue_content", () => {
	test("without plan text still has resume directive and is not just 'continue'", () => {
		const out = build_auto_continue_content({});
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toBe("continue");
		expect(out).toContain("cut off by the maximum output token limit");
		expect(out).toContain("goal:/files:/done:/left:");
		expect(out).toContain("left");
		expect(out).toContain("continue the interrupted task now");
	});

	test("does not include Checkpoint: or raw summary dump", () => {
		const out = build_auto_continue_content({});
		expect(out).not.toContain("Checkpoint:");
		expect(out).not.toContain("## Goal");
		expect(out).not.toContain("## Progress");
	});

	test("does not accept compaction_summary (removed from input)", () => {
		// compaction_summary is no longer in AutoContinueContentInput;
		// passing it via any-cast should be ignored (not pasted).
		const out = build_auto_continue_content({
			latest_plan_text: "Module 1: Create helpers.",
		} as Record<string, unknown>);
		expect(out).not.toContain("Checkpoint:");
		expect(out).not.toContain("## Goal");
	});

	test("respects max_chars for plan excerpt", () => {
		const long_plan = "Module 1: " + "x".repeat(10_000);
		const out = build_auto_continue_content({
			latest_plan_text: long_plan,
			max_chars: 500,
		});
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out).toContain("cut off by the maximum output token limit");
		expect(out).toContain("[…truncated");
	});

	test("default max_chars is 6000", () => {
		expect(DEFAULT_AUTO_CONTINUE_MAX_CHARS).toBe(6000);
	});

	test("plan text is included when provided", () => {
		const out = build_auto_continue_content({
			latest_plan_text: "Module 1: Create helpers. Module 2: Wire index.ts.",
		});
		expect(out).toContain("Plan draft so far:");
		expect(out).toContain("Module 1");
	});

	test("resume text mentions goal/files/done/left labels to follow", () => {
		const out = build_auto_continue_content({});
		expect(out).toContain("goal:");
		expect(out).toContain("done:");
		expect(out).toContain("left:");
		expect(out).toContain("files:");
	});
});
