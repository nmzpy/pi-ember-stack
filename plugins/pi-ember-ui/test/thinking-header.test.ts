import { describe, expect, test } from "bun:test";
import { arm_pre_token_thinking_status, thinking_status_should_show } from "../index.ts";
import {
	setGroupReopenableActive,
	setGroupThinkingChildActive,
	isThinkingBlocksHidden,
	setThinkingBlocksHidden,
	setToolGroupActive,
} from "../mode-colors.ts";

describe("thinking header visibility", () => {
	test("shows when thinking blocks are hidden and a settled group is only reopenable", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			setGroupReopenableActive(true);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(true);
		} finally {
			setGroupReopenableActive(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hides when thinking blocks are visible even if agent is pending", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(false);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(false);
			setGroupReopenableActive(false);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
		} finally {
			setThinkingBlocksHidden(prev_hidden);
		}
	});

	test("hides when thinking blocks are hidden but in-group Thinking child is active", () => {
		const prev_hidden = isThinkingBlocksHidden();
		setThinkingBlocksHidden(true);
		try {
			setToolGroupActive(false);
			setGroupThinkingChildActive(true);
			setGroupReopenableActive(true);
			arm_pre_token_thinking_status();
			expect(thinking_status_should_show()).toBe(false);
		} finally {
			setGroupThinkingChildActive(false);
			setGroupReopenableActive(false);
			setThinkingBlocksHidden(prev_hidden);
		}
	});
});
