import { SelectList } from "@earendil-works/pi-tui";
const identity = (text) => text;
const theme = { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };
const layout = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: Number.POSITIVE_INFINITY,
	truncatePrimary: (ctx) => {
		const text = ctx.text;
		const w = Math.max(1, Math.min(ctx.maxWidth, Math.floor((ctx.columnWidth || 0) * 0.5)));
		return text.length <= w ? text : text.slice(0, w - 3) + "...";
	},
};
const items = [
	{ value: "/a", label: "Short title", description: "2h · 5 msgs" },
	{ value: "/b", label: "A much longer session title that would normally widen the data-driven column far past the midpoint of the resume menu", description: "1d · 42 msgs" },
	{ value: "/c", label: "Medium title", description: "3w · 7 msgs" },
];
// replicate: our override returns floor(width/2) when width known
let resume_render_width = 0;
class R extends SelectList {
	render(width) { resume_render_width = width; return super.render(width); }
}
// install midpoint override via prototype (same as production)
let base = SelectList.prototype.getPrimaryColumnWidth;
R.prototype.getPrimaryColumnWidth = function () {
	if (resume_render_width > 0) return Math.max(1, Math.floor(resume_render_width * 0.5));
	return base.call(this);
};
const list = new R(items, 7, theme, layout);
const lines = list.render(120);
for (const line of lines) {
	console.log("ROW:", JSON.stringify(line));
	console.log("idx msgs:", line.indexOf("msgs"), "idx 5 msgs:", line.indexOf("5 msgs"), "len:", line.length);
}
