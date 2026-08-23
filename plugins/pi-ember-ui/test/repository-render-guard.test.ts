import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type SourceFile = {
	absolute: string;
	relative: string;
	source: string;
	code: string;
};

const repo_root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const plugins_root = path.join(repo_root, "plugins");
const stale_copy = path.join(repo_root, ".orig-pi-ember-ui.ts");
const render_intent_file = "pi-ember-ui/render-intent.ts";

/**
 * The Cursor bridge writes framed RPC bytes to its child-process stdout. It is
 * an IPC transport, not the live terminal, so it is the only production
 * source excluded from the terminal-write check.
 */
const IPC_BRIDGE_FILE = "pi-cursor-auth/src/cloud-direct/h2-bridge.mjs";

/** These timers service network/browser lifetimes and never paint Pi's TUI. */
const NON_RENDER_INTERVAL_FILES = new Set([
	"pi-cursor-auth/src/cloud-direct/chat.ts",
	"pi-ember-webtools/curator-page.ts",
	"pi-ember-webtools/curator-server.ts",
]);

function source_files(directory: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "test" && entry.name !== "node_modules") {
				files.push(...source_files(absolute));
			}
			continue;
		}
		if (!entry.isFile() || ![".ts", ".mjs"].includes(path.extname(entry.name))) continue;
		if (entry.name.endsWith("-test.mjs")) continue;
		files.push(absolute);
	}
	return files;
}

/** Remove comments and literal contents while preserving source line offsets. */
function strip_non_code(source: string): string {
	let output = "";
	let index = 0;
	let comment: "line" | "block" | undefined;
	let quote: "'" | '"' | "`" | undefined;

	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];

		if (comment === "line") {
			if (char === "\n") {
				comment = undefined;
				output += char;
			} else {
				output += " ";
			}
			index += 1;
			continue;
		}
		if (comment === "block") {
			if (char === "*" && next === "/") {
				output += "  ";
				index += 2;
				comment = undefined;
			} else {
				output += char === "\n" ? "\n" : " ";
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (char === "\\") {
				output += "  ";
				if (source[index + 1] === "\n") output += "\n";
				index += 2;
				continue;
			}
			if (char === quote) quote = undefined;
			output += char === "\n" ? "\n" : " ";
			index += 1;
			continue;
		}

		if (char === "/" && next === "/") {
			output += "  ";
			index += 2;
			comment = "line";
			continue;
		}
		if (char === "/" && next === "*") {
			output += "  ";
			index += 2;
			comment = "block";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			output += " ";
			index += 1;
			quote = char;
			continue;
		}
		output += char;
		index += 1;
	}
	return output;
}

function read_sources(): SourceFile[] {
	return source_files(plugins_root).map((absolute) => ({
		absolute,
		relative: path.relative(plugins_root, absolute).replaceAll(path.sep, "/"),
		source: fs.readFileSync(absolute, "utf8"),
		code: strip_non_code(fs.readFileSync(absolute, "utf8")),
	}));
}

function line_number(source: string, offset: number): number {
	return source.slice(0, offset).split("\n").length;
}

function matches(code: string, pattern: RegExp): number[] {
	const offsets: number[] = [];
	for (const match of code.matchAll(pattern)) {
		if (match.index !== undefined) offsets.push(match.index);
	}
	return offsets;
}

function findings_for_pattern(
	file: SourceFile,
	pattern: RegExp,
	label: string,
): string[] {
	return matches(file.code, pattern).map(
		(offset) => `${file.relative}:${line_number(file.code, offset)} ${label}`,
	);
}

describe("repository render authority", () => {
	test("uses render-intent for every native render request", () => {
		const findings: string[] = [];
		const native_bindings = new Set([
			"tui.requestRender?.();",
			"bind_render_intent(() => editor.tui!.requestRender!());",
		]);
		const observed_bindings: string[] = [];
		for (const file of read_sources()) {
			const direct_calls = matches(file.code, /\.\s*requestRender\s*(?:\?\.)?!?\s*\(/g);
			for (const offset of direct_calls) {
				const line_start = file.code.lastIndexOf("\n", offset - 1) + 1;
				const line_end = file.code.indexOf("\n", offset);
				const line = file.code.slice(line_start, line_end < 0 ? undefined : line_end);
				const trimmed_line = line.trim();
				const is_native_binding =
					file.relative === "pi-ember-ui/index.ts" &&
					native_bindings.has(trimmed_line);
				if (is_native_binding) {
					observed_bindings.push(trimmed_line);
				} else {
					findings.push(
						`${file.relative}:${line_number(file.code, offset)} direct requestRender call`,
					);
				}
			}
		}
		expect(
			findings,
			"Only the excluded pi-ember-ui native binding bridge may mention a direct requestRender call; all requests must enter request_render().",
		).toEqual([]);
		expect(observed_bindings.sort()).toEqual([...native_bindings].sort());

		const intent = read_sources().find((file) => file.relative === render_intent_file);
		expect(intent).toBeDefined();
		expect(intent?.source).toContain("export function request_render");
		expect(intent?.source).toContain("if (cb) cb();");
	});

	test("has no direct TUI invalidation, terminal painting, or renderer patches", () => {
		const findings = read_sources().flatMap((file) => [
			...findings_for_pattern(
				file,
				/\b(?:[A-Za-z_$][\w$]*\.)?tui(?:Ref)?\s*(?:\?\.\s*|\.\s*)invalidate\s*\(/g,
				"direct TUI invalidate",
			),
			...findings_for_pattern(file, /\b(?:tui|tuiRef)\s*\.\s*render\s*\(/g, "manual TUI render"),
			...findings_for_pattern(file, /\.\s*doRender\s*\b/g, "renderer internals"),
			...findings_for_pattern(file, /\.\s*requestRender\s*=/g, "requestRender monkey patch"),
			...findings_for_pattern(
				file,
				/\b(?:TUI|InteractiveMode|Editor)\.prototype\.[A-Za-z_$][\w$]*\s*=\s*function/g,
				"renderer prototype patch",
			),
		]);
		const terminal_findings = read_sources()
			.filter((file) => file.relative !== IPC_BRIDGE_FILE)
			.flatMap((file) => [
				...findings_for_pattern(file, /\b(?:process\.)?(?:stdout|stderr)\.write(?:Sync)?\s*\(/g, "terminal stream write"),
				...findings_for_pattern(file, /\bterminal\.write\s*\(/g, "terminal write"),
				...findings_for_pattern(file, /\bwriteSync\s*\(/g, "synchronous terminal write"),
				...findings_for_pattern(file, /\b(?:clearScreen|clearFromCursor|cursorTo)\s*\(/g, "terminal cursor/clear operation"),
			]);
		findings.push(...terminal_findings);
		expect(findings).toEqual([]);
	});

	test("keeps render timing free of PulseManager and setInterval machinery", () => {
		const findings: string[] = [];
		for (const file of read_sources()) {
			findings.push(...findings_for_pattern(file, /\bPulseManager\b/g, "PulseManager"));
			if (
				file.relative !== render_intent_file &&
				!NON_RENDER_INTERVAL_FILES.has(file.relative)
			) {
				findings.push(
					...findings_for_pattern(file, /\bsetInterval\s*\(/g, "setInterval in plugin source"),
				);
			}
		}
		expect(findings).toEqual([]);
	});

	test("does not retain the stale duplicate UI source", () => {
		expect(fs.existsSync(stale_copy)).toBe(false);
	});
});
