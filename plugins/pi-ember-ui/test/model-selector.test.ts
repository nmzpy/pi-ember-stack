import { describe, expect, test } from "bun:test";
import { SUCCESS_GREEN, blendToHex, PAGE_BG } from "../mode-colors.ts";
import { __test_only } from "../model-selector.ts";

describe("model selector", () => {
	test("effort_point_color uses four-step ladder when xhigh is available", () => {
		const efforts = ["low", "medium", "high", "xhigh"] as const;
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.25),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.5),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.75),
		);
		expect(__test_only.effort_point_color("xhigh", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 1),
		);
	});

	test("effort_point_color uses three-step ladder when high is the max", () => {
		const efforts = ["low", "medium", "high"] as const;
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.33),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.66),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 1),
		);
	});

	test("effort_point_color uses six-step ladder when max is available", () => {
		const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
		expect(__test_only.effort_point_color("minimal", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.2),
		);
		expect(__test_only.effort_point_color("low", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.2),
		);
		expect(__test_only.effort_point_color("medium", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.4),
		);
		expect(__test_only.effort_point_color("high", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.6),
		);
		expect(__test_only.effort_point_color("xhigh", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 0.8),
		);
		expect(__test_only.effort_point_color("max", [...efforts])).toBe(
			blendToHex(SUCCESS_GREEN, PAGE_BG, 1),
		);
	});
});
