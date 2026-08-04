import { SelectList, visibleWidth } from "@earendil-works/pi-tui";
const identity = (t) => t;
const theme = { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };
let resume_render_width = 0;
class R extends SelectList {
	render(width) { resume_render_width = width; return super.render(width); }
}
const base = SelectList.prototype.getPrimaryColumnWidth;
R.prototype.getPrimaryColumnWidth = function () {
	return resume_render_width > 0 ? Math.max(1, Math.floor(resume_render_width * 0.5)) : base.call(this);
};
const layout = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: Number.POSITIVE_INFINITY,
	truncatePrimary: (ctx) => ctx.text.length <= 58 ? ctx.text : ctx.text.slice(0, 55) + "...",
};
const items = [
	{ value: "/a", label: "Short title", description: "2h · 5 msgs" },
];
const list = new R(items, 7, theme, layout);
const line = list.render(120)[0];
console.log("line:", JSON.stringify(line));
for (let i = 0; i < line.length; i++) {
	if (line[i] !== " ") console.log(i, JSON.stringify(line[i]));
}
