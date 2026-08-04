import { Image, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ImageAttachment } from "./types.ts";

export class ImagePreviewMessage implements Component {
	private readonly images: Image[];

	constructor(
		private readonly attachments: ImageAttachment[],
		private readonly fallbackColor: (text: string) => string,
	) {
		this.images = attachments.map(
			(attachment) =>
				new Image(
					attachment.data,
					attachment.mimeType,
					{ fallbackColor },
					{
						maxWidthCells: 48,
						maxHeightCells: 12,
						filename: attachment.placeholder,
					},
					attachment.dimensions,
				),
		);
	}

	invalidate(): void {
		for (const image of this.images) image.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		for (let index = 0; index < this.attachments.length; index++) {
			const attachment = this.attachments[index];
			if (!attachment) continue;
			const label = this.fallbackColor(attachment.placeholder);
			lines.push(visibleWidth(label) > safeWidth ? truncateToWidth(label, safeWidth, "") : label);
			const image = this.images[index];
			if (!image) continue;
			lines.push(...image.render(Math.min(safeWidth, 48)));
			if (index < this.attachments.length - 1) lines.push("");
		}
		return lines;
	}
}
