import { describe, expect, test } from "bun:test";
import { Spacer } from "@earendil-works/pi-tui";
import {
	CHATBOX_LEADING_ROWS,
	ensure_chatbox_leading_spacer,
	finalize_editor_input_after,
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

	test("finalize_editor_input_after does not request renders", () => {
		let renders = 0;
		const editor = {
			getText: () => "/model ",
			isShowingAutocomplete: () => true,
			tui: { requestRender: () => renders++ },
		};
		finalize_editor_input_after(editor);
		expect(renders).toBe(0);
	});
});
