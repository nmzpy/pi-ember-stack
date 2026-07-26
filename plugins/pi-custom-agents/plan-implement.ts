/**
 * Same-session plan implement content (SSOT).
 *
 * After compaction the transcript may only retain a short summary; the hidden
 * pi-agents-plan-implement message must embed latest_plan_text so Implement
 * still receives the full approved plan.
 */

/** Join the mode directive with the durable plan text captured during plan mode. */
export function build_plan_implement_message_content(
	plan_text: string,
	directive: string,
): string {
	const plan = plan_text.trim();
	const trimmed_directive = directive.trim();
	if (!plan) return trimmed_directive;
	return `${trimmed_directive}\n\nApproved plan:\n\n${plan}`;
}
