/** Extract display text from an xAI/OpenAI Responses API response. */
export function extractResponsesText(data: unknown): string {
	if (typeof data === "object" && data !== null) {
		const obj = data as { output_text?: unknown; output?: unknown };
		if (typeof obj.output_text === "string" && obj.output_text) return obj.output_text;
		const chunks: string[] = [];
		if (Array.isArray(obj.output)) {
			for (const item of obj.output) {
				if (typeof item !== "object" || item === null) continue;
				const content = (item as { content?: unknown }).content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (typeof part !== "object" || part === null) continue;
					const p = part as { type?: unknown; text?: unknown };
					if (typeof p.text === "string" && (p.type === "output_text" || p.text)) {
						chunks.push(p.text);
					}
				}
			}
		}
		const joined = chunks.join("");
		if (joined) return joined;
	}
	return JSON.stringify(data);
}

/** Extract text from Responses content parts. */
export function textFromResponsesContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const item = part as { type?: unknown; text?: unknown };
			const type = typeof item.type === "string" ? item.type : "";
			return ["text", "input_text", "output_text"].includes(type) && typeof item.text === "string"
				? item.text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Extract an HTTP-like status from thrown xAI request errors. */
export function statusFromError(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null) {
		const status = (error as { status?: unknown }).status;
		if (typeof status === "number") return status;
	}
	return undefined;
}

/** Return a safe display message for thrown values. */
export function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}
