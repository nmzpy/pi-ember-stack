/* eslint-disable */
// Faithful /resume session-switch repro: teardown renders (header/widget
// removal), rebuild (chat clear + re-add), session-start renders, status line.
import { TUI, Container, Text, Spacer } from "@earendil-works/pi-tui";

class FakeTerminal {
	constructor(cols, rows) {
		this._cols = cols;
		this._rows = rows;
		this.buffer = "";
		this.writes = [];
	}
	get columns() {
		return this._cols;
	}
	get rows() {
		return this._rows;
	}
	get kittyProtocolActive() {
		return false;
	}
	write(data) {
		this.buffer += data;
		this.writes.push(data);
	}
	start() {}
	stop() {}
	async drainInput() {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

const height = 40;
const term = new FakeTerminal(120, height);
const tui = new TUI(term, false);
tui.setClearOnShrink(false);

const header = new Container();
const chat = new Container();
const status = new Container();
const footer = new Container();
const editor = new Container();
editor.addChild(new Text("> ", 1, 0));
const widgetAbove = new Container();
widgetAbove.addChild(new Spacer(1));
tui.addChild(header);
tui.addChild(chat);
tui.addChild(status);
tui.addChild(footer);
tui.addChild(widgetAbove);
tui.addChild(editor);

function fill(container, lines) {
	container.clear();
	for (let i = 0; i < lines; i++) {
		container.addChild(new Text(`line ${i}`, 1, 0));
	}
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function render(label) {
	tui.requestRender();
	await wait(80);
	if (process.env.TRACE) console.log(`[render ${label}] bytes=${term.buffer.length}`);
}

function scrollbackEstimate() {
	// Count how many lines of scrollback the terminal would plausibly have:
	// after the last write, screen shows rows [sb, sb+height); sb = max(0, totalWrittenAbove).
	// We approximate using the most recent render's line count via writes of \r\n.
	let lines = 0;
	let last = "";
	for (const w of term.writes) {
		const m = w.match(/\r\n/g);
		if (m) lines += m.length;
		last = w;
	}
	// A fullRender(true) clears scrollback then writes newLines.length lines.
	// A differential append adds to scrollback.
	const clear = term.buffer.includes("\x1b[3J");
	return { approxLines: lines, lastClear: clear, tail: last.slice(0, 120).replace(/\x1b/g, "␛") };
}

const EMPTY_CHAT = 0;

async function scenario(name, oldLines, newLines) {
	// Reset TUI state by creating a fresh TUI each scenario.
	term.buffer = "";
	term.writes = [];
	fill(chat, oldLines);
	await render("old session initial");
	term.buffer = "";
	term.writes = [];

	// 1) Teardown: extension UI reset (header/widget removed) -> renders with OLD chat still present.
	header.clear();
	status.clear();
	await render("teardown: header removed");
	// 2) Session rebuild: chatContainer.clear() + renderInitialMessages() synchronously.
	fill(chat, EMPTY_CHAT);
	fill(chat, newLines);
	await render("rebuild transcript");
	// 3) Session start: startup header, thinking widget, footer re-installed.
	header.addChild(new Text("HEADER", 1, 0));
	await render("session start header");
	// 4) Post-switch status line.
	status.addChild(new Text("Resumed session", 1, 0));
	await render("status shown");
	status.clear();
	await render("status cleared");

	const sb = scrollbackEstimate();
	console.log(`\n=== ${name}: old=${oldLines} new=${newLines} ===`);
	console.log(`  approx written lines in final render: ${sb.approxLines}, last fullRender clear: ${sb.lastClear}`);
	console.log(`  final render tail: ${JSON.stringify(term.buffer.slice(-180))}`);
}

await scenario("short resume", 200, 45);
await scenario("long resume", 45, 300);
process.exit(0);
