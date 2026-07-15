import { Text, type Component } from "@earendil-works/pi-tui";
import {
	renderLiveThinkingGradient,
	subscribeGroupTick,
	unsubscribeGroupTick,
} from "../pi-ember-ui/index.ts";

const BULLET = "• ";
const DISCOVERY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const GROUPABLE_TOOLS = new Set([...DISCOVERY_TOOLS, "bash"]);

export type ToolRenderContext = {
	args: any;
	toolCallId: string;
	invalidate: () => void;
	state: Record<string, any>;
	expanded?: boolean;
};

export type ToolRenderResultOptions = {
	isPartial: boolean;
	expanded?: boolean;
};

export type CompactCall = {
	id: string;
	name: string;
	args: any;
	group?: DiscoveryGroup;
	invalidate?: () => void;
	isError: boolean;
	_completed?: boolean;
	result?: any;
};

export type DiscoveryGroup = {
	records: CompactCall[];
	/** Group type: "discovery" (Exploring/Explored) or "working" (Working/Worked). */
	type?: "discovery" | "working";
	/**
	 * The record whose component renders the group header. Set once at
	 * group creation to the first member and never changed.
	 */
	renderOwner?: CompactCall;
	hasNonDiscovery?: boolean;
	/**
	 * Whether the agent has demonstrably moved on from this group (emitted
	 * visible text, started a non-group tool, or the turn ended). The label
	 * only flips to past tense (Explored/Worked) when both all members are
	 * complete AND the group is settled. While complete-but-unsettled, the
	 * group stays active (gradient + present tense) so the Thinking/Working
	 * widget stays hidden and there is no premature past-tense label.
	 */
	settled?: boolean;
	/**
	 * Shared visual handle for the group block. The owner re-binds this
	 * to its live `Text` on every `renderCall`; members write into it
	 * directly via `setText` in `renderResultInner` so the group stays
	 * visible across Pi rebuilds (thinking-toggle, compaction, settings)
	 * without relying on owner invalidation.
	 */
	callText?: Text;
};

function textValue(value: unknown, fallback = ""): string {
	if (value === undefined || value === null) return fallback;
	return String(value).replace(/[\r\n]+/g, " ");
}

function toolPath(args: any): string {
	return textValue(args?.file_path ?? args?.path, ".");
}

function bashCdDir(command: string): string | undefined {
	const match = /^\s*cd\s+([^\s&]+)\s*&&\s*/.exec(command);
	return match?.[1];
}

/**
 * Detect bash commands that are grep invocations (optionally preceded by
 * `cd <dir> &&`). Returns the extracted pattern and path so the call
 * can render as "Search" and join the discovery group.
 */
function bashGrepInfo(command: string): { pattern: string; path: string } | undefined {
	const stripped = command.replace(/^\s*cd\s+([^\s&]+)\s*&&\s*/, "");
	if (!/^\s*grep\b/.test(stripped)) return undefined;
	const cdDir = bashCdDir(command);
	const path = cdDir ?? ".";
	const afterGrep = stripped.replace(/^\s*grep\s+/, "");
	const cmdBeforePipe = afterGrep.split(/\s+[|>]/)[0];
	const parts = cmdBeforePipe.trim().split(/\s+/);
	let pattern: string | undefined;
	for (const part of parts) {
		if (!part.startsWith("-")) {
			pattern = part;
			break;
		}
	}
	if (!pattern) return undefined;
	pattern = pattern.replace(/^["']|["']$/g, "");
	return { pattern, path };
}

function groupKey(name: string, args: any): string | undefined {
	if (DISCOVERY_TOOLS.has(name)) return "__discovery__";
	if (name === "edit" || name === "write") return "__working__";
	if (name === "bash") {
		const command = textValue(args?.command);
		if (bashGrepInfo(command)) return "__discovery__";
		const dir = bashCdDir(command);
		return dir ? `bash:${dir}` : "__working__";
	}
	return undefined;
}

function errorText(result: any, isError: boolean): string | undefined {
	const content = result?.content?.find((item: any) => item.type === "text");
	if (!isError && !content?.text?.startsWith("Error")) return undefined;
	return textValue(content?.text, "Tool failed").split("\n")[0];
}

function fullOutputText(result: any): string {
	const content = result?.content?.find((item: any) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return "";
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatExpandedOutput(result: any, theme: any): string {
	const text = fullOutputText(result).trimEnd();
	if (!text) return "";
	return "\n" + text.split("\n").map((line) => theme.fg("text", line)).join("\n");
}

function bashLastLine(result: any): string | undefined {
	const content = result?.content?.find((item: any) => item.type === "text");
	const text = content?.text;
	if (typeof text !== "string") return undefined;
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length > 0) return line;
	}
	return undefined;
}

function formatBashResultLine(result: any, theme: any): string {
	const lastLine = bashLastLine(result);
	if (lastLine === undefined) return "";
	return "\n" + theme.fg("dim", "  ") + theme.fg("text", lastLine);
}

function diffStats(result: any): { additions: number; removals: number } {
	const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

function matchCount(result: any): number | undefined {
	const total = result?.details?.totalMatched;
	if (typeof total === "number") return total;
	return undefined;
}

function matchLabel(result: any, theme: any): string {
	const total = matchCount(result);
	if (total === undefined) return "";
	const label = total === 1 ? "1 match" : `${total} matches`;
	const color = total > 0 ? "success" : "muted";
	return theme.fg("dim", "  ") + theme.fg(color, label);
}

export const PULSE_INTERVAL_MS = 600;

/**
 * Canonical status-bullet color: error→red, completed→green, else a
 * flashing muted/dim bullet driven by PULSE_INTERVAL_MS. Shared by the
 * compact and subagent renderers; only subagent rows own a pulse timer.
 */
export function statusBulletColor(isError: boolean, isCompleted: boolean, theme: any): string {
	if (isError) return theme.fg("error", BULLET);
	if (isCompleted) return theme.fg("success", BULLET);
	const pulse = Math.floor(Date.now() / PULSE_INTERVAL_MS) % 2 === 0;
	return pulse ? theme.fg("muted", BULLET) : theme.fg("dim", BULLET);
}

/**
 * Canonical group-bullet color: any error→red, all completed→green,
 * else flashing. Derived from statusBulletColor's pulse logic.
 */
export function groupBulletColorFromFlags(hasError: boolean, allCompleted: boolean, theme: any): string {
	return statusBulletColor(hasError, allCompleted, theme);
}

/**
 * Shared pulse timer for renderers that need live status animation. Holds
 * a set of invalidate callbacks and fires them on one PULSE_INTERVAL_MS
 * interval, starting on first add and stopping when the last callback is
 * removed. Compact native-tool rows intentionally do not register here:
 * invalidating a tool row also requests a full TUI render.
 */
export class PulseManager {
	private readonly callbacks = new Set<() => void>();
	private timer: ReturnType<typeof setInterval> | undefined;

	add(cb: () => void): void {
		this.callbacks.add(cb);
		if (this.timer) return;
		this.timer = setInterval(() => {
			for (const cb of this.callbacks) {
				try { cb(); } catch { /* best effort */ }
			}
		}, PULSE_INTERVAL_MS);
	}

	remove(cb: () => void): void {
		this.callbacks.delete(cb);
		if (this.callbacks.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	clear(): void {
		this.callbacks.clear();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

function bulletColor(record: CompactCall, theme: any): string {
	return statusBulletColor(record.isError, record._completed === true, theme);
}

function formatEditStats(result: any, theme: any): string {
	const { additions, removals } = diffStats(result);
	return theme.fg("success", `+${additions}`) +
		theme.fg("dim", " / ") +
		theme.fg("error", `-${removals}`);
}

export function formatCallBody(name: string, args: any, theme: any, inGroup = false): string {
	const pathName = toolPath(args);
	switch (name) {
		case "read":
			return theme.fg("dim", theme.bold("Read")) +
				theme.fg("dim", ` ${pathName}`);
		case "grep":
			return theme.fg("dim", theme.bold("Search")) +
				theme.fg("dim", ` ${textValue(args?.pattern)}`) +
				theme.fg("dim", ` in ${pathName}`);
		case "find":
			return theme.fg("dim", theme.bold("Find")) +
				theme.fg("dim", ` ${textValue(args?.pattern)}`) +
				theme.fg("dim", ` in ${pathName}`);
		case "ls":
			return theme.fg("dim", theme.bold("List")) +
				theme.fg("dim", ` ${pathName}`);
		case "bash": {
			const cmd = textValue(args?.command);
			const grepInfo = bashGrepInfo(cmd);
			if (grepInfo) {
				return theme.fg("dim", theme.bold("Search")) +
					theme.fg("dim", ` ${grepInfo.pattern}`) +
					theme.fg("dim", ` in ${grepInfo.path}`);
			}
			const stripped = inGroup ? (cmd.replace(/^\s*cd\s+[^\s&]+\s*&&\s*/, "") || cmd) : cmd;
			return theme.fg("dim", theme.bold("Run")) +
				theme.fg("dim", ` $ ${stripped}`);
		}
		case "edit":
			return theme.fg("dim", theme.bold("edit")) +
				theme.fg("dim", ` ${pathName}`);
		case "write":
			return theme.fg("dim", theme.bold("write")) +
				theme.fg("dim", ` ${pathName}`);
		default:
			return theme.fg("dim", theme.bold(name));
	}
}

function groupBulletColor(group: DiscoveryGroup, theme: any): string {
	const hasError = group.records.some((r) => r.isError);
	const allCompleted = group.records.every((r) => r._completed);
	return groupBulletColorFromFlags(hasError, allCompleted, theme);
}

function groupHeaderLabel(group: DiscoveryGroup): string {
	const allDone = group.records.length > 0 && group.records.every((r) => r._completed) && group.settled === true;
	const isWorking = group.type === "working";
	const verb = allDone
		? (isWorking ? "Worked" : "Explored")
		: (isWorking ? "Working" : "Exploring");
	const first = group.records[0];
	if (!first) return verb;
	const key = groupKey(first.name, first.args);
	if (key?.startsWith("bash:")) {
		const dir = key.slice(5);
		return `${verb} ${dir}`;
	}
	return verb;
}

function formatGroup(group: DiscoveryGroup, theme: any): string {
	const allCompleted = group.records.length > 0 && group.records.every((r) => r._completed) && group.settled === true;
	const headerLabel = groupHeaderLabel(group);
	const headerText = allCompleted
		? theme.fg("text", theme.bold(headerLabel))
		: renderLiveThinkingGradient(headerLabel);
	const lines = [
		groupBulletColor(group, theme) + headerText,
	];
	for (const [index, record] of group.records.entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		const suffix = record._completed && (record.name === "grep" || record.name === "find")
			? matchLabel(record.result, theme)
			: "";
		lines.push(
			theme.fg("dim", prefix) +
			formatCallBody(record.name, record.args, theme, true) +
			suffix,
		);
	}
	return lines.join("\n");
}

export class CompactRenderer {
	private readonly calls = new Map<string, CompactCall>();
	private lastCall: CompactCall | undefined;
	private lastGroupKey: string | undefined;
	private currentGroup: DiscoveryGroup | undefined;
	/** The single discovery group persists until session replacement. */
	private discoveryGroup: DiscoveryGroup | undefined;
	/** The single working group (edit/write/non-grep bash) persists until session replacement. */
	private workingGroup: DiscoveryGroup | undefined;
	private readonly pendingGroupInvalidations = new Set<DiscoveryGroup>();

	/** Tick callback that re-renders the active group owner so the group
	 *  header gradient sweeps in lockstep with the Thinking/Working
	 *  widget. Subscribed while any group is unsettled (active); removed
	 *  on settle or session reset. */
	private groupTickCb: (() => void) | undefined;

	/** Whether the current turn has produced visible text output. */
	private turnHasText = false;
	private turnHasUserMessage = false;
	private canCarryPreviousGroup = false;

	beginTurn(): void {
		if (!this.canCarryPreviousGroup) this.resetGroupingState();
		this.canCarryPreviousGroup = false;
		this.turnHasText = false;
		this.turnHasUserMessage = false;
	}

	endTurn(thinkingHidden: boolean, message?: any): void {
		this.settleGroups();
		const messageHasText = Array.isArray(message?.content) && message.content.some(
			(part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim(),
		);
		this.canCarryPreviousGroup = thinkingHidden && !this.turnHasText && !messageHasText && !this.turnHasUserMessage;
	}

	/** Called by the plugin when the current turn produces visible text
	 *  output (text_start/text_delta). Break the old group immediately so
	 *  an intervening non-discovery tool cannot update it. */
	noteVisibleText(): void {
		if (!this.turnHasText) this.settleGroups();
		if (!this.turnHasText) this.resetGroupingState();
		this.turnHasText = true;
	}

	noteUserMessage(): void {
		if (!this.turnHasUserMessage) this.resetGroupingState();
		this.turnHasUserMessage = true;
	}

	/** Clear all accumulated call state. Called on session replacement
	 *  (/resume, /new, /fork) so stale rows from the previous session do
	 *  not leak into the new one. */
	resetForSession(): void {
		this.unsubscribeGroupTick();
		this.calls.clear();
		this.lastCall = undefined;
		this.lastGroupKey = undefined;
		this.currentGroup = undefined;
		this.discoveryGroup = undefined;
		this.workingGroup = undefined;
		this.pendingGroupInvalidations.clear();
		this.turnHasText = false;
		this.turnHasUserMessage = false;
		this.canCarryPreviousGroup = false;
	}

	/** Whether any tool group (discovery or working) currently has at
	 *  least one running member. Read by pi-compact-tools lifecycle handlers
	 *  to drive the shared `isToolGroupActive` flag in
	 *  pi-ember-ui/mode-colors.ts, which suppresses the Thinking/Working
	 *  widget while a group header carries the live gradient. */
	hasActiveGroups(): boolean {
		const groups = [this.discoveryGroup, this.workingGroup, this.currentGroup];
		for (const group of groups) {
			if (!group || group.records.length === 0) continue;
			const allComplete = group.records.every((r) => r._completed);
			if (group.records.some((r) => !r._completed)) return true;
			if (allComplete && !group.settled) return true;
		}
		return false;
	}

	/** Settle a single group so its label flips to past tense. No-op if
	 *  the group is missing, empty, or already settled. */
	private settleGroup(group: DiscoveryGroup | undefined): void {
		if (!group || group.records.length === 0 || group.settled) return;
		group.settled = true;
		this.scheduleGroupInvalidation(group);
	}

	/** Settle all live groups so their labels flip to past tense
	 *  (Explored/Worked). Called when the agent demonstrably moves on:
	 *  visible text, a non-group tool, or turn end. Idempotent per group
	 *  via scheduleGroupInvalidation. */
	private settleGroups(): void {
		this.settleGroup(this.discoveryGroup);
		this.settleGroup(this.workingGroup);
		this.unsubscribeGroupTick();
	}

	/** Subscribe the group owner to the thinking tick so the group header
	 *  gradient animates at the same cadence as the Thinking/Working
	 *  widget. Idempotent — only subscribes once. */
	private subscribeGroupTick(ownerInvalidate: (() => void) | undefined): void {
		if (!ownerInvalidate) return;
		if (this.groupTickCb) return;
		const cb = (): void => {
			ownerInvalidate();
		};
		this.groupTickCb = cb;
		subscribeGroupTick(cb);
	}

	/** Unsubscribe the group tick callback if one is active. */
	private unsubscribeGroupTick(): void {
		if (!this.groupTickCb) return;
		unsubscribeGroupTick(this.groupTickCb);
		this.groupTickCb = undefined;
	}

	private resetGroupingState(): void {
		this.lastCall = undefined;
		this.lastGroupKey = undefined;
		this.currentGroup = undefined;
		this.discoveryGroup = undefined;
		this.workingGroup = undefined;
	}

	private scheduleGroupInvalidation(group: DiscoveryGroup): void {
		if (this.pendingGroupInvalidations.has(group)) return;
		this.pendingGroupInvalidations.add(group);
		queueMicrotask(() => {
			if (!this.pendingGroupInvalidations.delete(group)) return;
			group.renderOwner?.invalidate?.();
		});
	}

	private markNonDiscoveryGroups(): void {
		// A non-group tool means the agent moved on from both discovery and
		// working — settle both so their labels flip to past tense.
		this.settleGroups();
	}

	private appendToGroup(group: DiscoveryGroup, record: CompactCall): void {
		// Attach every member only once the group has a second member. This
		// keeps a lone discovery call rendered as a normal standalone row.
		for (const member of group.records) member.group = group;
		group.records.push(record);
		record.group = group;
		this.currentGroup = group;
		this.scheduleGroupInvalidation(group);
	}

	registerCall(
		name: string,
		id: string,
		args: any,
		invalidate?: () => void,
	): CompactCall {
		const existing = this.calls.get(id);
		if (existing) {
			existing.args = args;
			// Keep the live callback for one-shot group-owner updates. The
			// tool_call lifecycle hook re-registers existing calls without a
			// component invalidator, so do not erase it there.
			if (invalidate) {
				existing.invalidate = invalidate;
			}
			return existing;
		}

		const record: CompactCall = { id, name, args, isError: false };
		this.calls.set(id, record);
		const key = groupKey(name, args);

		// A visible assistant message or user message separates this turn from
		// the old group. Reset lazily so a turn can still group its own calls.
		if ((this.turnHasText || this.turnHasUserMessage) && key !== undefined) {
			this.resetGroupingState();
			this.turnHasText = false;
			this.turnHasUserMessage = false;
		}

		if (key === undefined) {
			this.markNonDiscoveryGroups();
		}

		if (key === "__discovery__") {
			// Discovery is one persistent group. It intentionally survives
			// turn boundaries and intervening non-discovery calls; the latter
			// only makes the group label monotonic via hasNonDiscovery.
			// Starting/continuing discovery settles the working group — the
			// agent has moved on from working.
			this.settleGroup(this.workingGroup);
			if (!this.discoveryGroup) {
				this.discoveryGroup = {
					records: [record],
					renderOwner: record,
					type: "discovery",
				};
				this.currentGroup = this.discoveryGroup;
			} else {
				this.appendToGroup(this.discoveryGroup, record);
			}
		} else if (key === "__working__") {
			// Working group (edit/write/non-grep bash) — same persistent-group
			// semantics as discovery. Starting/continuing working settles the
			// discovery group — the agent has moved on from exploring.
			this.settleGroup(this.discoveryGroup);
			if (!this.workingGroup) {
				this.workingGroup = {
					records: [record],
					renderOwner: record,
					type: "working",
				};
				this.currentGroup = this.workingGroup;
			} else {
				this.appendToGroup(this.workingGroup, record);
			}
		} else if (key && this.lastCall && key === this.lastGroupKey) {
			const group = this.lastCall.group ?? { records: [this.lastCall] };
			this.lastCall.group = group;
			if (!group.renderOwner) group.renderOwner = this.lastCall;
			this.appendToGroup(group, record);
		}
		this.lastCall = record;
		this.lastGroupKey = key;
		record.invalidate = invalidate;
		return record;
	}

	setResult(record: CompactCall, result: any, isError: boolean): void {
		if (record._completed && record.result === result && record.isError === isError) return;
		record.isError = isError;
		record._completed = true;
		record.result = result;
		// Do NOT invalidate the owner here. The group visual is updated
		// directly via group.callText.setText() in renderResultInner so the
		// owner's next render picks up the change. Invalidating the owner
		// synchronously triggers updateDisplay -> renderResult -> setResult,
		// which races during Pi rebuilds (thinking-toggle, compaction) when
		// the owner component has been destroyed and recreated.
	}

	renderCall(
		name: string,
		args: any,
		theme: any,
		context: ToolRenderContext,
	): Component {
		try {
			return this.renderCallInner(name, args, theme, context);
		} catch {
			// Never throw: Pi's fallback would dump raw content. Return a
			// compact call row instead.
			return new Text(
				theme.fg("muted", BULLET) + formatCallBody(name, args, theme),
				0, 0,
			);
		}
	}

	private renderCallInner(
		name: string,
		args: any,
		theme: any,
		context: ToolRenderContext,
	): Component {
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		if (record.group && record.group.records.length > 1) {
			if (record.group.renderOwner !== record) return new Text("", 0, 0);
			const callText = context.state.callText instanceof Text
				? context.state.callText
				: new Text("", 0, 0);
			context.state.callText = callText;
			// Re-bind the group's shared visual handle to the owner's live
			// Text on every render. On Pi rebuilds (thinking-toggle,
			// compaction, settings) context.state is fresh, so a new Text is
			// created and the group handle is repointed to the live owner.
			record.group.callText = callText;
			callText.setText(formatGroup(record.group, theme));
			// While the group is not settled (agent hasn't moved on), subscribe
			// the owner's invalidate to the thinking tick so the gradient
			// header sweeps in lockstep with the Thinking/Working widget.
			if (!record.group.settled) {
				this.subscribeGroupTick(record.invalidate);
			} else {
				this.unsubscribeGroupTick();
			}
			return callText;
		}
		const callText = context.state.callText instanceof Text
			? context.state.callText
			: new Text("", 0, 0);
		context.state.callText = callText;
		callText.setText(
			bulletColor(record, theme) + formatCallBody(name, args, theme),
		);
		return callText;
	}

	renderResult(
		name: string,
		args: any,
		result: any,
		options: ToolRenderResultOptions,
		theme: any,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		try {
			return this.renderResultInner(name, args, result, options, theme, context);
		} catch {
			// Never throw: Pi's fallback would dump the full tool output
			// (e.g. entire file contents for read). Return an empty result
			// row — the call row already shows the compact summary.
			return new Text("", 0, 0);
		}
	}

	private renderResultInner(
		name: string,
		args: any,
		result: any,
		options: ToolRenderResultOptions,
		theme: any,
		context: ToolRenderContext & { isError: boolean },
	): Component {
		const record = this.registerCall(name, context.toolCallId, args, context.invalidate);
		this.setResult(record, result, context.isError);
		const expanded = options.expanded === true;

		if (record.group && record.group.records.length > 1) {
			// Update the shared group visual directly so the owner's row
			// reflects this member's completion (bullet color, match count,
			// Explored label) without invalidating the owner. setText clears
			// the Text cache; Pi's next requestRender re-renders the owner's
			// selfRenderContainer with the updated Text.
			record.group.callText?.setText(formatGroup(record.group, theme));
			if (record.group.renderOwner !== record) return new Text("", 0, 0);
			if (expanded && !options.isPartial) {
				const output = formatExpandedOutput(result, theme);
				if (output) return new Text(output, 0, 0);
			}
			const error = errorText(result, context.isError);
			return error ? new Text(theme.fg("error", error), 0, 0) : new Text("", 0, 0);
		}
		if (options.isPartial) return new Text("", 0, 0);

		const error = errorText(result, context.isError);
		const callText = context.state.callText;
		if (callText instanceof Text) {
			if (name === "edit") {
				callText.setText(
					bulletColor(record, theme) +
						formatCallBody(name, args, theme) +
						theme.fg("dim", "  ") +
						formatEditStats(result, theme),
				);
			} else if (name === "grep" || name === "find") {
				callText.setText(
					bulletColor(record, theme) +
						formatCallBody(name, args, theme) +
						matchLabel(result, theme),
				);
			} else if (name === "bash") {
				callText.setText(
					bulletColor(record, theme) +
						formatCallBody(name, args, theme) +
						formatBashResultLine(result, theme),
				);
			} else {
				callText.setText(
					bulletColor(record, theme) + formatCallBody(name, args, theme),
				);
			}
		}
		if (error) return new Text(theme.fg("error", error), 0, 0);
		if (expanded) {
			const output = formatExpandedOutput(result, theme);
			if (output) return new Text(output, 0, 0);
		}
		return new Text("", 0, 0);
	}
}

export { BULLET, DISCOVERY_TOOLS, GROUPABLE_TOOLS, bashGrepInfo };
