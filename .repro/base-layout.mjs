import { SelectList, visibleWidth } from "@earendil-works/pi-tui";
const identity = (t) => t;
const theme = { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity };
let resume_render_width = 0;
class R extends SelectList {
	render(width) { resume_render_width = width; return super.render(width); }
}
const base = SelectList.prototype.getPrimaryColumnWidth;
R.prototype.getPrimaryColumnWidth = function () {
	if (resume_render_width > 0) return Math.max(1, Math.floor(resume_render_width * 0.5));
	return base.call(this);
};
const layout = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: Number.POSITIVE_INFINITY,
	truncatePrimary: (ctx) => {
		const { text, maxWidth, columnWidth } = ctx;
		const w = Math.max(1, Math.min(maxWidth, Math.floor((resume_render_width || columnWidth) * 0.5)));
		return w >= visibleWidth(text) ? text : text.slice(0, w - 3) + "...";
	},
};
const items = [
	{ value: "/a", label: "Short title", description: "2h · 5 msgs" },
	{ value: "/b", label: "A much longer session title that would normally widen the data-driven column far past the midpoint of the resume menu", description: "1d · 42 msgs" },
];
const list = new R(items, 7, theme, layout);
const lines = list.render(120);
for (const line of lines) {
	const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
	console.log("vis:", visibleWidth(plain), "dot:", plain.indexOf(" · "), JSON.stringify(plain));
}
