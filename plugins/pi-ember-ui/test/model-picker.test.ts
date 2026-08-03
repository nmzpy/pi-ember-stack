import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	find_exact_model_reference,
	find_session_reference,
	fallback_to_native_resume_for_tests,
	bind_live_editor_for_tests,
	set_native_editor_submit_value_for_tests,
	should_auto_submit_slash_text,
	should_auto_submit_resume_text,
	extract_model_command_search,
	should_route_model_slash_to_picker,
	resume_truncate_text,
} from "../model-picker.ts";

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
	{ provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
	{ provider: "xai", id: "grok-4.5", name: "Grok 4.5" },
];

function session(partial: Partial<SessionInfo> & Pick<SessionInfo, "path" | "id">): SessionInfo {
	const now = new Date();
	return {
		cwd: "/work",
		created: now,
		modified: now,
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
		...partial,
	};
}

describe("resume_truncate_text", () => {
	const long_title =
		"This is a really long session title that keeps going and going well past the middle of the screen for the resume menu";
	const strip_ansi = (s: string) => s.replace(/\u001b\[0m/g, "");

	test("caps the title at half the terminal content width", () => {
		// contentWidth 120 -> half is 60 visible columns, well past the old
		// data-driven (narrow) primary column of 40.
		const out = resume_truncate_text(long_title, 120, 40, 118);
		const plain = strip_ansi(out);
		expect(plain.endsWith("...")).toBe(true);
		const visible = plain.slice(0, -3);
		expect(visible.length).toBeGreaterThan(40);
		expect(visible.length).toBeLessThanOrEqual(60);
	});

	test("falls back to the (narrow) column-width half when content width is unset", () => {
		const out = resume_truncate_text(long_title, 0, 40, 118);
		const plain = strip_ansi(out);
		expect(plain.endsWith("...")).toBe(true);
		expect(plain.slice(0, -3).length).toBeLessThanOrEqual(20);
	});

	test("never truncates a title shorter than half the screen", () => {
		const short_title = "Fixing the Thinking header";
		expect(resume_truncate_text(short_title, 120, 40, 40)).toBe(short_title);
	});

	test("respects pi-tui's primary-column bound (maxWidth)", () => {
		const out = resume_truncate_text(long_title, 120, 40, 12);
		expect(strip_ansi(out).slice(0, -3).length).toBeLessThanOrEqual(12);
	});
});

describe("find_exact_model_reference", () => {
	test("matches canonical provider/id", () => {
		const model = find_exact_model_reference("anthropic/claude-sonnet-4", MODELS);
		expect(model?.provider).toBe("anthropic");
		expect(model?.id).toBe("claude-sonnet-4");
	});

	test("rejects ambiguous bare ids", () => {
		const ambiguous = [
			{ provider: "a", id: "shared", name: "A" },
			{ provider: "b", id: "shared", name: "B" },
		];
		expect(find_exact_model_reference("shared", ambiguous)).toBeUndefined();
	});

	test("matches unique bare id", () => {
		expect(find_exact_model_reference("grok-4.5", MODELS)?.provider).toBe("xai");
	});
});

describe("model slash routing", () => {
	test("extract_model_command_search parses bare and filtered commands", () => {
		expect(extract_model_command_search("/model")).toBe("");
		expect(extract_model_command_search("/model ")).toBe("");
		expect(extract_model_command_search("/model claude")).toBe("claude");
		expect(extract_model_command_search("  /model grok  ")).toBe("grok");
		expect(extract_model_command_search("/resume foo")).toBeNull();
	});

	test("should_route_model_slash_to_picker only after filter characters", () => {
		expect(should_route_model_slash_to_picker("/model")).toBe(false);
		expect(should_route_model_slash_to_picker("/model ")).toBe(true);
		expect(should_route_model_slash_to_picker("/model claude")).toBe(true);
		expect(should_route_model_slash_to_picker("/modelclaude")).toBe(true);
	});

	test("extract_model_command_search strips /model prefix for picker filter", () => {
		expect(extract_model_command_search("/model anthropic/claude-sonnet-4")).toBe(
			"anthropic/claude-sonnet-4",
		);
		expect(extract_model_command_search("/modelclaude")).toBe("claude");
	});
});

describe("find_session_reference", () => {
	const sessions = [
		session({
			path: "/sessions/alpha.jsonl",
			id: "alpha-id",
			name: "Alpha Plan",
			firstMessage: "plan the feature",
		}),
		session({
			path: "/sessions/beta.jsonl",
			id: "beta-id",
			firstMessage: "fix the bug",
		}),
	];

	test("matches full path", () => {
		expect(find_session_reference("/sessions/alpha.jsonl", sessions)?.id).toBe("alpha-id");
	});

	test("matches session id", () => {
		expect(find_session_reference("beta-id", sessions)?.path).toBe("/sessions/beta.jsonl");
	});

	test("matches unique display name", () => {
		expect(find_session_reference("Alpha Plan", sessions)?.path).toBe("/sessions/alpha.jsonl");
	});

	test("matches unique fuzzy first-message text", () => {
		expect(find_session_reference("fix the", sessions)?.id).toBe("beta-id");
	});

	test("rejects empty reference", () => {
		expect(find_session_reference("  ", sessions)).toBeUndefined();
	});
});

describe("should_auto_submit_slash_text", () => {
	test("commits slash commands that already have an argument", () => {
		expect(should_auto_submit_slash_text("/model anthropic/claude-sonnet-4")).toBe(true);
		expect(should_auto_submit_slash_text("/resume /sessions/a.jsonl")).toBe(true);
		expect(should_auto_submit_slash_text("/login anthropic")).toBe(true);
		expect(should_auto_submit_slash_text("/export path/to/file")).toBe(true);
	});

	test("skips bare commands, command-name picks, and unfinished paths", () => {
		expect(should_auto_submit_slash_text("")).toBe(false);
		expect(should_auto_submit_slash_text("/")).toBe(false);
		expect(should_auto_submit_slash_text("hello")).toBe(false);
		expect(should_auto_submit_slash_text("/settings")).toBe(false);
		expect(should_auto_submit_slash_text("/model")).toBe(false);
		expect(should_auto_submit_slash_text("/resume")).toBe(false);
		expect(should_auto_submit_slash_text("/model ")).toBe(false);
		expect(should_auto_submit_slash_text("/export path/to/dir/")).toBe(false);
		expect(should_auto_submit_slash_text('/export "path/to/dir/"')).toBe(false);
	});
});

describe("should_auto_submit_resume_text", () => {
	test("commits a selected session on the same Enter press", () => {
		expect(should_auto_submit_resume_text("/resume /sessions/alpha.jsonl")).toBe(true);
	});

	test("does not commit the bare command or an unfinished directory", () => {
		expect(should_auto_submit_resume_text("/resume")).toBe(false);
		expect(should_auto_submit_resume_text("/resume /sessions/")).toBe(false);
	});
});

describe("native /resume fallback", () => {
	const NATIVE_SUBMIT_KEY = Symbol.for("pi-ember-ui:native-submit");

	test("delegates to per-editor native submitValue when switchSession capture is missing", () => {
		let editor_text = "";
		let native_called = false;
		const editor = {
			setText(text: string) {
				editor_text = text;
			},
			[NATIVE_SUBMIT_KEY]() {
				native_called = true;
			},
		};
		bind_live_editor_for_tests(editor);

		const ok = fallback_to_native_resume_for_tests("/sessions/alpha.jsonl");
		expect(ok).toBe(true);
		expect(editor_text).toBe("/resume /sessions/alpha.jsonl");
		expect(native_called).toBe(true);
	});

	test("falls back to prototype native submit when instance key is missing", () => {
		let native_called = false;
		const editor = { setText() {} };
		bind_live_editor_for_tests(editor);
		set_native_editor_submit_value_for_tests(function native_submit(this: unknown) {
			native_called = true;
			void this;
		});

		expect(fallback_to_native_resume_for_tests("/sessions/beta.jsonl")).toBe(true);
		expect(native_called).toBe(true);
	});

	test("returns false when native submit or editor is unavailable", () => {
		bind_live_editor_for_tests(undefined);
		set_native_editor_submit_value_for_tests(undefined);
		expect(fallback_to_native_resume_for_tests("/sessions/alpha.jsonl")).toBe(false);
	});
});
