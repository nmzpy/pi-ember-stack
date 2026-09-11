import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS, VISUAL_TOOLS } from "../edit-tools.ts";
import { exit_mode_reminder, mode_reminder, ORCHESTRATE_TOOLS, VISUAL_VERIFICATION_GUIDANCE } from "../index.ts";
import { visual_extension_paths } from "../subagent/extensions/runner.ts";

/**
 * Visual verification is a first-class capability, not something an agent
 * improvises. Without these tools a Coder asked to "verify the UI" has only
 * `bash` and starts writing throwaway CDP/screenshot scripts in the OS temp
 * directory — one script per question, unreusable, invisible to the user.
 */
const REQUIRED_VISUAL_TOOLS = [
	"window_list",
	"window_screenshot",
	"browser_navigate",
	"browser_snapshot",
	"browser_take_screenshot",
	"browser_measure",
	"browser_scroll",
	"browser_focus",
	"browser_console_messages",
];

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "subagent", "agents");

/** Tool list from an agent definition's YAML frontmatter (LF or CRLF). */
function agent_tools(agentFile: string): string[] {
	const text = readFileSync(join(AGENTS_DIR, agentFile), "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const tools = /^tools:\s*(.+)$/m.exec(frontmatter)?.[1] ?? "";
	return tools
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

describe("visual tools SSOT", () => {
	test("covers every capability needed to look at a rendered UI", () => {
		for (const tool of REQUIRED_VISUAL_TOOLS) {
			expect(VISUAL_TOOLS).toContain(tool);
		}
	});

	test("stays observation-only: no editing, no mouse/keyboard driving", () => {
		for (const tool of [
			"edit",
			"write",
			"apply_patch",
			"replace",
			"browser_click",
			"browser_type",
			"browser_drag",
		]) {
			expect(VISUAL_TOOLS).not.toContain(tool);
		}
	});
});

describe("agent tool sets include visual verification", () => {
	test("default implementation agents can see what they built", () => {
		for (const tool of REQUIRED_VISUAL_TOOLS) {
			expect(DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS).toContain(tool);
		}
	});

	test("Coder declares the visual tools explicitly", () => {
		const tools = agent_tools("coder.md");
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of REQUIRED_VISUAL_TOOLS) {
			expect(tools).toContain(tool);
		}
	});

	test("Coder is told never to write throwaway screenshot scripts", () => {
		const text = readFileSync(join(AGENTS_DIR, "coder.md"), "utf8");
		expect(text).toContain("never write a screenshot");
		expect(text).toContain("No throwaway scripts");
	});

	test("Scout stays a lean read-only search agent", () => {
		const tools = agent_tools("scout.md");
		expect(tools).toContain("grep");
		expect(tools).not.toContain("browser_measure");
		expect(tools).not.toContain("window_screenshot");
	});

	test("Orchestrate can verify delegated work without an editing tool", () => {
		for (const tool of REQUIRED_VISUAL_TOOLS) {
			expect(ORCHESTRATE_TOOLS).toContain(tool);
		}
		for (const tool of ["edit", "write", "apply_patch", "replace", "bash"]) {
			expect(ORCHESTRATE_TOOLS).not.toContain(tool);
		}
	});
});

describe("child sessions load the visual extensions", () => {
	test("pi-ember-screen is always loaded so desktop window capture exists", () => {
		const paths = visual_extension_paths();
		expect(paths.some(p => p.endsWith(join("pi-ember-screen", "index.ts")))).toBe(true);
	});

	test("pi-browser is discovered from Pi's agent dir, never a literal user path", () => {
		const resolvedBrowser = join(getAgentDir(), "extensions", "pi-browser", "index.ts");
		for (const path of visual_extension_paths()) {
			const underAgentDir = path === resolvedBrowser;
			const underRepo = path.endsWith(join("pi-ember-screen", "index.ts"));
			expect(underAgentDir || underRepo).toBe(true);
		}
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "subagent", "extensions", "runner.ts"),
			"utf8",
		);
		// No hardcoded user home in the source — the location comes from getAgentDir().
		expect(source.includes("/Users/") && source.includes("pi-browser")).toBe(false);
		expect(source.includes("C:\\\\Users") && source.includes("pi-browser")).toBe(false);
	});
});

describe("runtime prompt guidance", () => {
	test("code and orchestrate mode prompts tell the model to use the tools instead of a script", () => {
		for (const prompt of [
			mode_reminder("code", "anthropic"),
			mode_reminder("orchestrate", "anthropic"),
			exit_mode_reminder("orchestrate", "anthropic"),
		]) {
			expect(prompt).toContain(VISUAL_VERIFICATION_GUIDANCE);
			expect(prompt).toMatch(/instead of writing a screenshot/);
		}
	});

	test("the orchestrate prompt lists the visual tools it can actually call", () => {
		const prompt = mode_reminder("orchestrate", "anthropic");
		for (const tool of ["browser_measure", "browser_take_screenshot", "window_screenshot"]) {
			expect(prompt).toContain(tool);
		}
	});

	test("a mode without visual tools does not advertise them", () => {
		const plan = mode_reminder("plan", "anthropic");
		expect(plan).not.toContain("browser_measure");
	});

	test("the Coder subagent prompt carries the same contract", () => {
		const coder = readFileSync(join(AGENTS_DIR, "coder.md"), "utf8");
		expect(coder).toContain("browser_measure");
		expect(coder).toContain("No throwaway scripts");
	});
});
