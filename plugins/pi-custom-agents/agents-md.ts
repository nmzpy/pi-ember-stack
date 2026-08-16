/**
 * Hierarchical AGENTS.md auto-loader for pi-custom-agents.
 *
 * Pi natively loads the project-root AGENTS.md into the system prompt. This
 * module discovers nested AGENTS.md files under the session cwd (project
 * root) as tools touch their directories, and injects their instructions
 * into every LLM request as ONE virtual custom message so instructions
 * discovered mid-turn (after a tool call) are available to the very next
 * LLM request — without persisting repeated copies in the session.
 *
 * Activation is shallow -> deep for each directory walk: when a tool targets
 * `root/a/b/file.ts`, the loader walks `root`, `root/a`, `root/a/b` and
 * activates each existing `AGENTS.md` in that order. Instructions from
 * unrelated modules are retained for the rest of the session, with a
 * deterministic first-activation order; directory-local precedence comes
 * from the shallow->deep ordering (deeper files append after shallower
 * ones).
 *
 * The root AGENTS.md is intentionally excluded — Pi already put it in the
 * system prompt. The parent root instructions remain active after the model
 * changes modules.
 *
 * Path handling is filesystem-real, not string-slash based: relative paths
 * resolve against the project root (or an explicit tool cwd), `..` is
 * normalized, symlinks are resolved through `realpath` (an existing symlink
 * cannot escape the canonical root; a nonexistent create target is judged
 * through its nearest existing ancestor), and everything outside the root
 * is rejected. Bash commands are heuristic only: a leading `cd <dir>` /
 * `cd -- <dir>` plus obvious absolute or dot-relative operands; ambiguous
 * commands are ignored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse_patch } from "../pi-ember-applypatch/parse.ts";

export const AGENTS_FILE_NAME = "AGENTS.md";
/** Unambiguous customType marker for the virtual context instruction message. */
export const CONTEXT_CUSTOM_TYPE = "pi-agents-md-instructions";

const PATH_FIELDS: readonly string[] = ["path", "file_path", "filePath"];

type AgentsMdRecord = {
	canonicalPath: string;
	relativePosixPath: string;
	quickSignature: string;
	contentHash: string;
	content: string;
	order: number;
};

/** Structural mirror of pi-coding-agent's CustomMessage (not package-exported). */
type AgentsMdContextMessage = {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
};

function isWindows(): boolean {
	return process.platform === "win32";
}

function normalizeCase(p: string): string {
	return isWindows() ? p.toLowerCase() : p;
}

export function samePath(a: string, b: string): boolean {
	return normalizeCase(path.resolve(a)) === normalizeCase(path.resolve(b));
}

export function isInside(root: string, target: string): boolean {
	const rootKey = normalizeCase(path.resolve(root));
	const targetKey = normalizeCase(path.resolve(target));
	return targetKey === rootKey || targetKey.startsWith(`${rootKey}${path.sep}`);
}

/**
 * Canonicalize a path, resolving symlinks through the nearest existing
 * ancestor so nonexistent create targets still get a symlink-safe base.
 * Returns the original normalized path when nothing can be resolved.
 */
export function realpathOrAncestor(p: string): string {
	let current = path.normalize(p);
	const tail: string[] = [];
	while (true) {
		try {
			const real = fs.realpathSync(current);
			return tail.length === 0 ? real : path.join(real, ...tail.reverse());
		} catch {
			const parent = path.dirname(current);
			if (samePath(parent, current)) return current;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

export function canonicalRoot(cwd: string): string {
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

/**
 * Resolve a raw tool path operand against the project root (or an explicit
 * tool base). Returns the canonical absolute path, or undefined when the
 * target escapes the root (including through symlinks).
 */
export function resolveRootTarget(raw: string, root: string, base?: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const joined = path.isAbsolute(trimmed) ? trimmed : path.resolve(base ?? root, trimmed);
	const canonical = realpathOrAncestor(path.normalize(joined));
	if (!isInside(root, canonical)) return undefined;
	return canonical;
}

/** Files use their parent directory; directories retain themselves. */
export function applicableDirectory(target: string): string {
	try {
		return fs.statSync(target).isDirectory() ? target : path.dirname(target);
	} catch {
		return path.dirname(target);
	}
}

/** Ancestor directories from root (inclusive) down to dir, shallow -> deep. */
export function ancestorChain(root: string, dir: string): string[] {
	const chain: string[] = [];
	let current = path.normalize(dir);
	if (!isInside(root, current)) return [];
	while (true) {
		chain.push(current);
		if (samePath(current, root)) break;
		const parent = path.dirname(current);
		if (samePath(parent, current)) break;
		current = parent;
	}
	chain.reverse();
	return chain;
}

/** Existing `dir/AGENTS.md` candidates from root down to dir, shallow -> deep. */
export function agentsMdCandidates(root: string, dir: string): string[] {
	return ancestorChain(root, dir)
		.filter((d) => {
			try {
				return fs.statSync(d).isDirectory();
			} catch {
				return false;
			}
		})
		.map((d) => path.join(d, AGENTS_FILE_NAME));
}

export function toPosixRelative(root: string, target: string): string {
	return path.relative(root, target).split(path.sep).join("/");
}

function hashContent(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

function statSignature(p: string): string | undefined {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return undefined;
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return undefined;
	}
}

function readFileSafe(p: string): string | undefined {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

function stripQuotes(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}

function tokenizeShellWords(command: string): string[] {
	const tokens: string[] = [];
	const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
	for (const match of command.matchAll(re)) {
		tokens.push(match[0]);
	}
	return tokens;
}

function isConcretePathOperand(word: string): boolean {
	if (!word) return false;
	const dotRelative =
		word === "." || word === ".." || word.startsWith("./") || word.startsWith("../");
	// Bare relative paths with at least one separator (e.g. `gui/services/AGENTS.md`)
	// are real path operands; bare tokens like `grep`, `-n`, `--help` have no
	// separator and stay rejected.
	const bareRelative = !path.isAbsolute(word) && !dotRelative && word.includes("/");
	if (!path.isAbsolute(word) && !dotRelative && !bareRelative) return false;
	if (/[\s;|&<>$`(){}]/.test(word)) return false;
	if (/[*?[\]~]/.test(word)) return false;
	return true;
}

/**
 * Heuristic bash path extraction. Returns an optional explicit `cd` base and
 * concrete path operands (the cd dir itself plus absolute/dot-relative
 * operands elsewhere in the command). Ambiguous commands yield no targets.
 */
export function bashTargets(command: string): { base?: string; targets: string[] } {
	const trimmed = command.trim();
	if (trimmed === "") return { targets: [] };
	const targets: string[] = [];
	let base: string | undefined;

	const cdMatch = /^\s*cd\s+(?:--\s+)?([^\s&|;]+)/.exec(trimmed);
	if (cdMatch?.[1] !== undefined) {
		const dir = stripQuotes(cdMatch[1]);
		if (dir !== "" && dir !== "~" && !dir.startsWith("$")) {
			base = dir;
			targets.push(dir);
		}
	}

	const rest = trimmed.replace(/^\s*cd\s+(?:--\s+)?[^\s&|;]+\s*(?:&&\s*)?/, "");
	for (const token of tokenizeShellWords(rest)) {
		const word = stripQuotes(token);
		if (isConcretePathOperand(word)) targets.push(word);
	}
	return { base, targets };
}

function applyPatchPaths(raw: string): string[] {
	if (!raw.trim()) return [];
	const parsed = parse_patch(raw);
	if (!parsed.ok) return [];
	const paths: string[] = [];
	for (const op of parsed.ops) {
		paths.push(op.path);
		if ("move_to" in op && op.move_to) paths.push(op.move_to);
	}
	return paths;
}

function firstPathField(input: Record<string, unknown>): string | undefined {
	for (const field of PATH_FIELDS) {
		const value = input[field];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

/**
 * Derive concrete path operands from a tool call's input. Native path tools
 * use `path` (with known aliases); bash uses the heuristic; apply_patch is
 * parsed with the shared envelope parser.
 */
export function deriveToolPaths(toolName: string, input: Record<string, unknown>): string[] {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "grep":
		case "find":
		case "ls": {
			const p = firstPathField(input);
			return p ? [p] : [];
		}
		case "bash": {
			const command = typeof input.command === "string" ? input.command : "";
			return bashTargets(command).targets;
		}
		case "apply_patch": {
			const raw = typeof input.input === "string" ? input.input : "";
			return applyPatchPaths(raw);
		}
		default:
			return [];
	}
}

export class AgentsMdLoader {
	private root: string | undefined;
	private records = new Map<string, AgentsMdRecord>();
	private order: string[] = [];
	private nextOrder = 0;
	private pendingScans = new Map<string, Set<string>>();
	/** Only ever inject the AGENTS.md context message once per session. */
	private hasDeliveredContext = false;

	get active(): boolean {
		return this.root !== undefined;
	}

	get activeCount(): number {
		return this.order.length;
	}

	/** Posix-relative paths of active files in canonical activation order. */
	activeFiles(): string[] {
		return this.order
			.map((p) => this.records.get(p)?.relativePosixPath)
			.filter((p): p is string => p !== undefined);
	}

	startSession(cwd: string): void {
		this.shutdown();
		this.root = canonicalRoot(cwd);
	}

	shutdown(): void {
		this.root = undefined;
		this.records.clear();
		this.order = [];
		this.nextOrder = 0;
		this.pendingScans.clear();
		this.hasDeliveredContext = false;
	}

	noteToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
		if (!this.root) return;
		if (toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			this.noteBashCall(toolCallId, command);
			return;
		}
		const paths = deriveToolPaths(toolName, input);
		for (const raw of paths) {
			const resolved = resolveRootTarget(raw, this.root);
			if (!resolved) continue;
			const dir = applicableDirectory(resolved);
			this.rememberScan(toolCallId, dir);
			this.activateWalk(dir);
		}
	}

	noteToolExecutionEnd(toolCallId: string): void {
		if (!this.root) return;
		const dirs = this.pendingScans.get(toolCallId);
		if (dirs) {
			for (const dir of dirs) this.rescanWalk(dir);
			this.pendingScans.delete(toolCallId);
		}
		this.pruneMissing();
	}

	/**
	 * Build the single virtual context message representing all active nested
	 * AGENTS.md files, or undefined when none are active, the message has
	 * already been delivered this session, or the incoming messages already
	 * carry the marker.
	 */
	buildContextMessage(messages: AgentMessage[]): AgentMessage | undefined {
		if (!this.root || this.hasDeliveredContext || this.order.length === 0) return undefined;
		const sections: string[] = [];
		for (const p of this.order) {
			const record = this.records.get(p);
			if (!record) continue;
			sections.push(`<agents_md path="${record.relativePosixPath}">\n${record.content}\n</agents_md>`);
		}
		const freshContent = sections.length > 0 ? sections.join("\n\n") : undefined;
		if (freshContent === undefined) return undefined;
		// If an existing marker message is already in the conversation (e.g.
		// from a resumed session), do not re-inject and do not re-paste the
		// instructions on later user re-queries. The AGENTS.md instructions are
		// delivered exactly once per session.
		for (const message of messages) {
			if (
				message.role === "custom" &&
				"customType" in message &&
				message.customType === CONTEXT_CUSTOM_TYPE
			) {
				this.hasDeliveredContext = true;
				return undefined;
			}
		}
		this.hasDeliveredContext = true;
		const message: AgentsMdContextMessage = {
			role: "custom",
			customType: CONTEXT_CUSTOM_TYPE,
			content: freshContent,
			display: false,
			timestamp: Date.now(),
		};
		return message as AgentMessage;
	}

	/** Bash operands resolve against the extracted cd base (itself root-resolved). */
	private noteBashCall(toolCallId: string, command: string): void {
		if (!this.root) return;
		const { base, targets } = bashTargets(command);
		const baseResolved = base ? resolveRootTarget(base, this.root) : undefined;
		if (baseResolved) {
			const dir = applicableDirectory(baseResolved);
			this.rememberScan(toolCallId, dir);
			this.activateWalk(dir);
		}
		const operandBase = baseResolved ?? this.root;
		for (const raw of targets) {
			if (base !== undefined && raw === base) continue;
			const resolved = resolveRootTarget(raw, this.root, operandBase);
			if (!resolved) continue;
			const dir = applicableDirectory(resolved);
			this.rememberScan(toolCallId, dir);
			this.activateWalk(dir);
		}
	}

	private rememberScan(toolCallId: string, dir: string): void {
		let dirs = this.pendingScans.get(toolCallId);
		if (!dirs) {
			dirs = new Set();
			this.pendingScans.set(toolCallId, dirs);
		}
		dirs.add(dir);
	}

	private activateWalk(dir: string): void {
		if (!this.root) return;
		for (const candidate of agentsMdCandidates(this.root, dir)) {
			this.activateCandidate(candidate);
		}
	}

	private activateCandidate(candidate: string): void {
		if (!this.root) return;
		if (samePath(candidate, path.join(this.root, AGENTS_FILE_NAME))) return;
		const quick = statSignature(candidate);
		if (quick === undefined) return;
		const existing = this.records.get(candidate);
		if (existing) {
			if (existing.quickSignature !== quick) this.refreshRecord(candidate, existing);
			return;
		}
		const content = readFileSafe(candidate);
		if (content === undefined) return;
		this.records.set(candidate, {
			canonicalPath: candidate,
			relativePosixPath: toPosixRelative(this.root, candidate),
			quickSignature: quick,
			contentHash: hashContent(content),
			content,
			order: this.nextOrder++,
		});
		this.order.push(candidate);
	}

	private rescanWalk(dir: string): void {
		if (!this.root) return;
		for (const candidate of agentsMdCandidates(this.root, dir)) {
			const quick = statSignature(candidate);
			const existing = this.records.get(candidate);
			if (quick === undefined) {
				if (existing) this.dropRecord(candidate);
				continue;
			}
			if (existing) {
				if (existing.quickSignature !== quick) this.refreshRecord(candidate, existing);
			} else {
				this.activateCandidate(candidate);
			}
		}
	}

	private refreshRecord(candidate: string, record: AgentsMdRecord): void {
		const content = readFileSafe(candidate);
		if (content === undefined) {
			this.dropRecord(candidate);
			return;
		}
		const quick = statSignature(candidate);
		if (quick !== undefined) record.quickSignature = quick;
		record.content = content;
		record.contentHash = hashContent(content);
	}

	private dropRecord(candidate: string): void {
		this.records.delete(candidate);
		const index = this.order.indexOf(candidate);
		if (index >= 0) this.order.splice(index, 1);
	}

	/** General safety net: drop active files deleted by any means. */
	private pruneMissing(): void {
		for (const p of [...this.order]) {
			if (!fs.existsSync(p)) this.dropRecord(p);
		}
	}
}

const loader = new AgentsMdLoader();

/**
 * Register the session/tool/context hooks on the given ExtensionAPI. The
 * loader is session-scoped: `session_start` captures the project root from
 * `ctx.cwd`; `session_shutdown` clears all state. Pi invokes the cached
 * extension factory with a FRESH ExtensionAPI after /resume, /new, and /fork,
 * and handlers registered on the prior API are disposed with it — so hooks
 * must be registered on every factory invocation (never guarded by a
 * module-global once flag). The singleton loader remains safe because
 * `session_start` resets it and `session_shutdown` clears it.
 */
export function installAgentsMdHooks(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		loader.startSession(ctx.cwd);
	});

	pi.on("session_shutdown", () => {
		loader.shutdown();
	});

	pi.on("tool_call", (event) => {
		if (!loader.active) return;
		loader.noteToolCall(event.toolCallId, event.toolName, event.input as unknown as Record<string, unknown>);
	});

	pi.on("tool_execution_end", (event) => {
		if (!loader.active) return;
		loader.noteToolExecutionEnd(event.toolCallId);
	});

	pi.on("context", (event) => {
		if (!loader.active) return undefined;
		const message = loader.buildContextMessage(event.messages);
		if (!message) return undefined;
		return { messages: [...event.messages, message] };
	});
}
