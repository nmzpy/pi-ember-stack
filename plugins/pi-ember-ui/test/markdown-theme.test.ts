import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import piEmberUiPlugin from "../index.ts";
import {
	buildThemeBgColors,
	buildThemeFgColors,
	MODE_COLORS,
	setActiveMode,
} from "../mode-colors.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

type Handler = (event: unknown, ctx: unknown) => unknown;

function make_pi(): {
	pi: ExtensionAPI;
	events: Map<string, Handler>;
	handlers: Map<string, Handler>;
} {
	const events = new Map<string, Handler>();
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler): void {
			handlers.set(name, handler);
		},
		events: {
			on(name: string, handler: Handler): void {
				events.set(name, handler);
			},
			emit(): void {},
		},
		registerCommand(): void {},
	} as unknown as ExtensionAPI;
	return { pi, events, handlers };
}

function make_theme(mode_id: keyof typeof MODE_COLORS): Theme {
	const accent = MODE_COLORS[mode_id];
	return new Theme(
		buildThemeFgColors(accent) as never,
		buildThemeBgColors(accent) as never,
		"truecolor",
	);
}

function make_markdown_theme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

const original_home = process.env.HOME;
const original_theme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
const original_theme_old = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY_OLD];
let temp_home: string | undefined;
let shutdown_handler: Handler | undefined;

afterEach(() => {
	shutdown_handler?.({}, { hasUI: false });
	shutdown_handler = undefined;
	setActiveMode("code");
	if (original_home === undefined) delete process.env.HOME;
	else process.env.HOME = original_home;
	if (original_theme === undefined) delete (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	else (globalThis as Record<PropertyKey, unknown>)[THEME_KEY] = original_theme;
	if (original_theme_old === undefined)
		delete (globalThis as Record<PropertyKey, unknown>)[THEME_KEY_OLD];
	else (globalThis as Record<PropertyKey, unknown>)[THEME_KEY_OLD] = original_theme_old;
	if (temp_home) fs.rmSync(temp_home, { recursive: true, force: true });
	temp_home = undefined;
});

describe("live Markdown headings", () => {
	test("all Markdown instances follow the active mode despite a Code-seed global theme", () => {
		temp_home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ember-ui-theme-"));
		process.env.HOME = temp_home;
		setActiveMode("code");

		const { pi, events, handlers } = make_pi();
		piEmberUiPlugin(pi);
		shutdown_handler = handlers.get("session_shutdown");
		const mode_change = events.get("pi-ember-ui:mode-change");
		expect(mode_change).toBeDefined();

		const code_theme = make_theme("code");
		const plan_theme = make_theme("plan");
		const debug_theme = make_theme("debug");
		const markdown = new Markdown("# Live heading", 0, 0, make_markdown_theme(code_theme));
		const split_markdown = new Markdown(
			"### Module 3: Live heading",
			0,
			0,
			make_markdown_theme(code_theme),
		);

		setActiveMode("plan");
		mode_change?.({ liveOnly: true }, {});
		(globalThis as Record<PropertyKey, unknown>)[THEME_KEY] = code_theme;
		markdown.invalidate();
		split_markdown.invalidate();
		const plan_output = markdown.render(80).join("\n");
		const plan_split_output = split_markdown.render(80).join("\n");
		expect(plan_output).toContain(plan_theme.getFgAnsi("mdHeading"));
		expect(plan_output).not.toContain(code_theme.getFgAnsi("mdHeading"));
		expect(plan_split_output).toContain(plan_theme.getFgAnsi("mdHeading"));
		expect(plan_split_output).toContain(plan_theme.getFgAnsi("text"));

		setActiveMode("debug");
		mode_change?.({ liveOnly: true }, {});
		(globalThis as Record<PropertyKey, unknown>)[THEME_KEY] = code_theme;
		markdown.invalidate();
		split_markdown.invalidate();
		const debug_output = markdown.render(80).join("\n");
		const debug_split_output = split_markdown.render(80).join("\n");
		expect(debug_output).toContain(debug_theme.getFgAnsi("mdHeading"));
		expect(debug_output).not.toContain(code_theme.getFgAnsi("mdHeading"));
		expect(debug_split_output).toContain(debug_theme.getFgAnsi("mdHeading"));
		expect(debug_split_output).toContain(debug_theme.getFgAnsi("text"));
	});
});
