import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const BULLET = "• ";

/** ANSI-aware multi-line tool row — truncates each line to viewport width. */
export class CompactGroupText implements Component {
	text = "";

	setText(text: string): void {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		return this.text.split("\n").map((line) => truncateToWidth(line, availableWidth));
	}

	lineCount(): number {
		return this.text.length === 0 ? 0 : this.text.split("\n").length;
	}
}
