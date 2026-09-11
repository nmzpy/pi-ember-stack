import { beforeEach, describe, expect, test } from "bun:test";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { install_foreign_tool_row_patch } from "../foreign-tool-row.ts";
import { getSharedRenderer } from "../shared-renderer.ts";

/** Identity theme: rows are asserted without ANSI codes. */
const theme = {
	fg: (_token: string, text: string): string => text,
	bold: (text: string): string => text,
};

type PatchHost = {
	toolName: string;
	getCallRenderer?: () => (...args: never[]) => Component | undefined;
	getResultRenderer?: () => (...args: never[]) => Component | undefined;
	getRenderShell?: () => string;
};

function proto(): PatchHost {
	return ToolExecutionComponent.prototype as unknown as PatchHost;
}

/** Pi's real getters read these two fields; the fallback case leaves both empty. */
function make_host(toolName: string, overrides: Record<string, unknown> = {}): unknown {
	return {
		toolName,
		builtInToolDefinition: undefined,
		toolDefinition: {},
		...overrides,
	};
}

function make_context(args: unknown, expanded = false, isError = false) {
	return {
		args,
		toolCallId: `call-${Math.random().toString(36).slice(2)}`,
		invalidate: (): void => {},
		state: {} as Record<string, unknown>,
		expanded,
		isError,
	};
}

function render_lines(component: Component, width = 120): string[] {
	return component.render(width);
}

install_foreign_tool_row_patch();

// The shared renderer is a module singleton: browser calls group across tests,
// so each test starts from a clean session (same as Pi's session_start).
beforeEach(() => {
	getSharedRenderer().resetForSession();
});
describe("foreign tool compact row patch", () => {
	test("installs once", () => {
		const first = proto().getCallRenderer;
		install_foreign_tool_row_patch();
		expect(proto().getCallRenderer).toBe(first);
	});

	test("renders a lone browser call as one compact row with its browser verb", () => {
		const host = make_host("browser_navigate");
		const callRenderer = proto().getCallRenderer?.call(host as never) as (
			args: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		expect(typeof callRenderer).toBe("function");
		const component = callRenderer(
			{ url: "http://localhost:3000/#modes" },
			theme,
			make_context({ url: "http://localhost:3000/#modes" }),
		);
		expect(render_lines(component)).toEqual(["◇Navigating http://localhost:3000/#modes"]);
	});

	test("renders an argument-less browser call as a bare verb row", () => {
		const host = make_host("browser_reload");
		const callRenderer = proto().getCallRenderer?.call(host as never) as (
			args: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		const component = callRenderer({}, theme, make_context({}));
		expect(render_lines(component)).toEqual(["◇Reloading"]);
	});

	test("updates the same row in place when the result lands", () => {
		const host = make_host("browser_click");
		const args = { element: "Save button" };
		const context = make_context(args);
		const callRenderer = proto().getCallRenderer?.call(host as never) as (
			args: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		const resultRenderer = proto().getResultRenderer?.call(host as never) as (
			result: unknown,
			options: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		const call = callRenderer(args, theme, context);
		const result = resultRenderer(
			{ content: [{ type: "text", text: "### Open tabs\n- 0: chrome://newtab/" }] },
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		// The call row repaints in place: the browser verb snaps to past tense.
		expect(render_lines(call)).toEqual(["◇Clicked element Save button"]);
		// Collapsed result rows stay empty — the call row carries the summary.
		expect(render_lines(result)).toEqual([]);
	});

	test("shows the raw output only when expanded", () => {
		const host = make_host("browser_snapshot");
		const args = { selector: "body" };
		const context = make_context(args, true);
		const resultRenderer = proto().getResultRenderer?.call(host as never) as (
			result: unknown,
			options: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		const result = resultRenderer(
			{ content: [{ type: "text", text: "### Page\n- button Save\n- link Docs" }] },
			{ expanded: true, isPartial: false },
			theme,
			context,
		);
		const lines = render_lines(result);
		expect(lines.join("\n")).toContain("- button Save");
		expect(lines.join("\n")).toContain("- link Docs");
	});

	test("uses Pi's self shell so no fallback background box is painted", () => {
		expect(proto().getRenderShell?.call(make_host("browser_reload") as never)).toBe("self");
	});

	test("delegates to Pi's original renderer when the tool defines one", () => {
		const ownCall = (): Component => {
			throw new Error("own call renderer");
		};
		const host = make_host("custom_tool", { toolDefinition: { renderCall: ownCall } });
		expect(proto().getCallRenderer?.call(host as never)).toBe(ownCall);
		expect(proto().getRenderShell?.call(host as never)).toBe("default");
	});

	test("truncates the row to the supplied width", () => {
		const host = make_host("browser_navigate");
		const args = { url: `http://localhost:3000/${"x".repeat(200)}` };
		const callRenderer = proto().getCallRenderer?.call(host as never) as (
			args: unknown,
			theme: unknown,
			context: unknown,
		) => Component;
		const component = callRenderer(args, theme, make_context(args));
		const [line] = render_lines(component, 40);
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(line.startsWith("◇Navigating")).toBe(true);
	});
});
