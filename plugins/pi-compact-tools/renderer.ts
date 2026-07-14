import { Text, type Component } from "@earendil-works/pi-tui";

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
	/**
	 * The record whose component currently renders the group header.
	 * The latest call to join the group becomes the owner so the
	 * header always renders in the current turn's visible component.
	 */
	renderOwner?: CompactCall;
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

function groupKey(name: string, args: any): string | undefined {
	if (DISCOVERY_TOOLS.has(name)) return "__discovery__";
	if (name === "bash") {
		const dir = bashCdDir(textValue(args?.command));
		return dir ? `bash:${dir}` : undefined;
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

const PULSE_INTERVAL_MS = 600;

function bulletColor(record: CompactCall, theme: any): string {
	if (record.isError) return theme.fg("error", BULLET);
	if (record._completed) return theme.fg("success", BULLET);
	const pulse = Math.floor(Date.now() / PULSE_INTERVAL_MS) % 2 === 0;
	return pulse ? theme.fg("muted", BULLET) : theme.fg("dim", BULLET);
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
	if (group.records.some((r) => r.isError)) return theme.fg("error", BULLET);
	if (group.records.every((r) => r._completed)) return theme.fg("success", BULLET);
	const pulse = Math.floor(Date.now() / PULSE_INTERVAL_MS) % 2 === 0;
	return pulse ? theme.fg("muted", BULLET) : theme.fg("dim", BULLET);
}

function groupHeaderLabel(group: DiscoveryGroup): string {
	const allDone = group.records.every((r) => r._completed);
	const verb = allDone ? "Explored" : "Exploring";
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
	const lines = [
		groupBulletColor(group, theme) + theme.fg("text", theme.bold(groupHeaderLabel(group))),
	];
	for (const [index, record] of group.records.entries()) {
		const prefix = index === 0 ? "  └ " : "    ";
		const suffix = record._completed && (record.name === "grep" || record.name === "find")
			? matchLabel(record.result, theme)
			: "";
		lines.push(
			theme.fg("dim", prefix) +
			bulletColor(record, theme) +
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
	private pulseTimer: ReturnType<typeof setInterval> | null = null;
	private readonly pendingPulses = new Set<CompactCall>();

	private startPulse(record: CompactCall): void {
		this.pendingPulses.add(record);
		if (this.pulseTimer) return;
		this.pulseTimer = setInterval(() => {
			if (this.pendingPulses.size === 0) {
				this.stopPulse();
				return;
			}
			for (const r of this.pendingPulses) r.invalidate?.();
		}, PULSE_INTERVAL_MS);
	}

	private stopPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = null;
		}
	}

	beginTurn(): void {
		// Do NOT reset lastCall / lastGroupKey here. Resetting breaks
		// grouping when turn_start fires between renderCall registrations
		// (e.g. parallel bash calls with the same cd dir). Consecutive
		// calls with the same group key should always group, even across
		// turn boundaries. Different keys naturally don't group.
		this.pendingPulses.clear();
		this.stopPulse();
	}

	observeCall(name: string, id: string, args: any): CompactCall {
		return this.registerCall(name, id, args);
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
			existing.invalidate = invalidate ?? existing.invalidate;
			return existing;
		}

		const record: CompactCall = { id, name, args, isError: false };
		this.calls.set(id, record);
		const key = groupKey(name, args);
		if (key && this.lastCall && key === this.lastGroupKey) {
			const group = this.lastCall.group ?? { records: [this.lastCall], renderOwner: this.lastCall };
			this.lastCall.group = group;
			// New record joins the group — become renderOwner so the group
			// header renders in this call's (current-turn) component.
			const prevOwner = group.renderOwner;
			group.renderOwner = record;
			if (prevOwner && prevOwner !== record) prevOwner.invalidate?.();
			group.records.push(record);
			record.group = group;
			for (const groupedCall of group.records) groupedCall.invalidate?.();
		}
		this.lastCall = record;
		this.lastGroupKey = key;
		record.invalidate = invalidate;
		this.startPulse(record);
		return record;
	}

	setResult(record: CompactCall, result: any, isError: boolean): void {
		if (record._completed && record.result === result && record.isError === isError) return;
		record.isError = isError;
		record._completed = true;
		record.result = result;
		this.pendingPulses.delete(record);
		if (this.pendingPulses.size === 0) this.stopPulse();
		if (record.group) {
			record.group.renderOwner?.invalidate?.();
		}
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
			return new Text(formatGroup(record.group, theme), 0, 0);
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

export { BULLET, DISCOVERY_TOOLS, GROUPABLE_TOOLS };
