/* eslint-disable */
// Repro harness: simulate a /resume session switch against pi-tui's TUI with a
// fake terminal, then inspect the escape sequences Pi emits (scrollback clear?).
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
tui.setClearOnShrink(true);

const chat = new Container();
const header = new Container();
header.addChild(new Text("HEADER", 1, 0));
const footer = new Container();
footer.addChild(new Text("FOOTER", 1, 0));
tui.addChild(header);
tui.addChild(chat);
tui.addChild(footer);
const editor = new Text("> ", 1, 0);
const editorContainer = new Container();
editorContainer.addChild(editor);
tui.addChild(editorContainer);

function fill(container, lines) {
	container.clear();
	for (let i = 0; i < lines; i++) {
		container.addChild(new Text(`line ${i}`, 1, 0));
	}
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function render() {
	tui.requestRender();
	await wait(80);
}

async function scenario(name, oldLines, newLines) {
	term.buffer = "";
	term.writes = [];
	fill(chat, oldLines);
	await render();
	const first = term.buffer;
	term.buffer = "";
	term.writes = [];
	// Simulate the switch: replace chat content, emit shutdown/start renders,
	// then the rebuilt transcript.
	fill(chat, newLines);
	await render();
	const second = term.buffer;
	const clearSeq = second.includes("\x1b[2J");
	const clearScrollback = second.includes("\x1b[3J");
	// Rough scrollback estimate: after the final render, terminal scrollback is
	// max(0, totalContent - height) IF the writes scrolled naturally, else 0.
	console.log(`\n=== ${name}: old=${oldLines} new=${newLines} ===`);
	console.log(`second render bytes: ${second.length}`);
	console.log(`fullRender clear-screen: ${clearSeq}, clear-scrollback: ${clearScrollback}`);
	console.log(`write buffer tail (visible area):`);
	const visible = second.length > 3000 ? second.slice(-3000) : second;
	console.log(JSON.stringify(visible.slice(0, 600)));
}

await scenario("short resume (shrink)", 200, 45);
await scenario("long resume (grow)", 45, 300);
await scenario("ongoing conversation (append)", 45, 60);
process.exit(0);
