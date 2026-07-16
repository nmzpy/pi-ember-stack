import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Build a simple user text input array for xAI Responses requests. */
export function xaiTextInput(text: string): Array<{ role: "user"; content: string }> {
	return [{ role: "user", content: text }];
}

/** Return a pi tool error result with optional structured details. */
export function xaiToolError<T = undefined>(message: string, details?: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details: details as T,
	};
}
