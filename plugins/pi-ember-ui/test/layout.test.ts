import { describe, expect, test } from "bun:test";
import { Spacer } from "@earendil-works/pi-tui";
import {
	CHATBOX_LEADING_ROWS,
	bind_slash_command_exit_render,
	ensure_chatbox_leading_spacer,
	finalize_editor_input_after,
	reset_slash_command_tracking,
	request_overlay_collapse_render,
	sync_slash_command_active,
} from "../layout.ts";

describe("native layout integration", () => {
	test("keeps one leading chatbox spacer without touching TUI internals", () => {
		const editor = {
			getText: () => "",
			handleInput: () => {},
			render: () => [],
		};
		const widget = { children: [new Spacer(3), new Spacer(2)] };
		const tui = { children: [widget, { children: [editor] }] } as never;

		ensure_chatbox_leading_spacer(tui);

		expect(widget.children.length).toBe(1);
		expect(widget.children[0]).toBeInstanceOf(Spacer);
		expect((widget.children[0] as unknown as { lines: number }).lines).toBe(
			CHATBOX_LEADING_ROWS,
		);
	});

	test("slash/autocomplete collapse only requests a deferred native render", async () => {
		reset_slash_command_tracking();
		let renders = 0;
		bind_slash_command_exit_render(() => renders++);
		let text = "/model ";
		const editor = {
			getText: () => text,
			isShowingAutocomplete: () => true,
			tui: { requestRender: () => renders++ },
		};
		sync_slash_command_active(editor);
		text = "hello";
		finalize_editor_input_after(editor);
		await new Promise((resolve) => setImmediate(resolve));
		expect(renders).toBe(1);
		request_overlay_collapse_render();
		await new Promise((resolve) => setImmediate(resolve));
		expect(renders).toBe(2);
	});
});
