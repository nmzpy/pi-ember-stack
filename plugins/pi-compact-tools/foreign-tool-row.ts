/**
 * Compact rows for foreign tools (SSOT).
 *
 * Pi renders a tool that defines neither `renderCall` nor `renderResult` as a
 * bold tool name plus its raw result text inside a colored shell. Third-party
 * extensions register exactly that shape — pi-browser's `browser_*` tools are
 * the canonical case — so their rows dumped raw markdown into the transcript
 * while every Ember-owned tool call rendered as a compact bullet row.
 *
 * This patch routes those tools through the shared `CompactRenderer`, so they
 * render as the same bullet-led, single-row, `ctrl+o`-expandable rows as every
 * other compact tool call:
 *
 *   `• browser_navigate url http://localhost:3000/#modes`
 *
 * Ownership rules:
 * - The extension keeps the tool, its schema, its execution, and its result.
 *   Only Pi's *fallback* renderer is substituted, and only when the tool
 *   defines no renderer of its own; every tool with a `renderCall` or a
 *   `renderResult` is delegated to Pi's original getter untouched.
 * - The substituted renderers are the shared `CompactRenderer` entry points, so
 *   bullet color, label painting, width truncation, and the `ctrl+o` expanded
 *   output path stay SSOT with the native compact tools.
 * - The render path stays pure: no terminal writes, no differential-state
 *   mutation, no private render timer, and no `requestRender()` call.
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { CompactRenderer } from "./renderer.ts";
import { getSharedRenderer } from "./shared-renderer.ts";

const FOREIGN_ROW_PATCH_MARKER = Symbol.for("pi-ember-stack:compact-foreign-tool-row");

type RenderCallArgs = Parameters<CompactRenderer["renderCall"]>;
type RenderResultArgs = Parameters<CompactRenderer["renderResult"]>;

/** CompactRenderer-backed call renderer, matching Pi's positional call shape. */
type CompactCallRenderer = (
	args: RenderCallArgs[1],
	theme: RenderCallArgs[2],
	context: RenderCallArgs[3],
) => Component;

/** CompactRenderer-backed result renderer, matching Pi's positional call shape. */
type CompactResultRenderer = (
	result: RenderResultArgs[2],
	options: RenderResultArgs[3],
	theme: RenderResultArgs[4],
	context: RenderResultArgs[5],
) => Component;

/** Only the seams this patch reads or replaces are typed. */
interface ToolExecutionPatchHost {
	[FOREIGN_ROW_PATCH_MARKER]?: boolean;
	toolName: string;
	getCallRenderer?: () => CompactCallRenderer | undefined;
	getResultRenderer?: () => CompactResultRenderer | undefined;
	getRenderShell?: () => string;
}

/**
 * Whether Pi would fall back to its raw dump for this tool. True only when the
 * tool defines neither renderer — a tool with either one keeps its own row.
 */
function uses_pi_fallback_row(
	host: ToolExecutionPatchHost,
	originalGetCallRenderer: NonNullable<ToolExecutionPatchHost["getCallRenderer"]>,
	originalGetResultRenderer: NonNullable<ToolExecutionPatchHost["getResultRenderer"]>,
): boolean {
	return (
		originalGetCallRenderer.call(host) === undefined &&
		originalGetResultRenderer.call(host) === undefined
	);
}

export function install_foreign_tool_row_patch(): void {
	const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPatchHost;
	if (proto[FOREIGN_ROW_PATCH_MARKER]) return;

	const originalGetCallRenderer = proto.getCallRenderer;
	const originalGetResultRenderer = proto.getResultRenderer;
	const originalGetRenderShell = proto.getRenderShell;
	if (
		typeof originalGetCallRenderer !== "function" ||
		typeof originalGetResultRenderer !== "function" ||
		typeof originalGetRenderShell !== "function"
	) {
		throw new Error(
			"pi-compact-tools: ToolExecutionComponent renderer seams are missing — cannot install the foreign-tool compact row patch.",
		);
	}
	proto[FOREIGN_ROW_PATCH_MARKER] = true;

	const renderer = getSharedRenderer();

	proto.getCallRenderer = function compactForeignKeyCallRenderer(
		this: ToolExecutionPatchHost,
	): CompactCallRenderer | undefined {
		if (!uses_pi_fallback_row(this, originalGetCallRenderer, originalGetResultRenderer)) {
			return originalGetCallRenderer.call(this);
		}
		const name = this.toolName;
		return (args, theme, context) => renderer.renderCall(name, args, theme, context);
	};

	proto.getResultRenderer = function compactForeignKeyResultRenderer(
		this: ToolExecutionPatchHost,
	): CompactResultRenderer | undefined {
		if (!uses_pi_fallback_row(this, originalGetCallRenderer, originalGetResultRenderer)) {
			return originalGetResultRenderer.call(this);
		}
		const name = this.toolName;
		return (result, options, theme, context) =>
			renderer.renderResult(name, context.args, result, options, theme, context);
	};

	// Pi's "self" shell renders the tool's own component without the fallback
	// colored box, which is what every Ember compact row uses.
	proto.getRenderShell = function compactForeignKeyRenderShell(
		this: ToolExecutionPatchHost,
	): string {
		if (!uses_pi_fallback_row(this, originalGetCallRenderer, originalGetResultRenderer)) {
			return originalGetRenderShell.call(this);
		}
		return "self";
	};
}
