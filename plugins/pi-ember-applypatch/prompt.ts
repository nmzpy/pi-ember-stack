/**
 * SSOT for apply_patch tool description, prompt snippet, and guidelines.
 */

export const TOOL_NAME = "apply_patch";
export const TOOL_LABEL = "Apply Patch";

export const TOOL_DESCRIPTION =
	"Apply a Codex-style multi-file patch (add / update / delete / move) under the workspace root.";

export const TOOL_PROMPT_SNIPPET =
	"Apply Codex-style multi-file patches (add/update/delete/move) for file changes";

export const TOOL_PROMPT_GUIDELINES: readonly string[] = [
	"Use apply_patch for code changes. Use write only for new files when a full rewrite is clearer than an Add File patch.",
	"Wrap every apply_patch input in `*** Begin Patch` and `*** End Patch`. Paths must be relative to the workspace root — never absolute.",
	"apply_patch file ops: `*** Add File: path` (each body line starts with `+`), `*** Delete File: path`, or `*** Update File: path` (optional `*** Move to: newPath`, then one or more hunks).",
	"apply_patch Update hunks: optional `@@` header (a real source line copied from read, e.g. `@@ def foo():`), then every content line must start with exactly one prefix — ` ` (unchanged context), `-` (remove), or `+` (add). Never send raw source lines without a prefix.",
	"apply_patch: git-style `@@ -33,8 +33,10 @@` line-range headers are ignored automatically — context lines still must match the file. Prefer a source-line `@@` anchor or omit `@@` entirely.",
	"apply_patch tolerates trailing whitespace differences and common Unicode quote/dash variants when matching context; re-read the file if you still get Invalid Context or Ambiguous Context.",
	"apply_patch Add File lines must start with `+`. Context/removal/addition lines in Update hunks must include the prefix as the first character (e.g. ` def foo():` for an unchanged indented line).",
	"apply_patch: on Invalid Context or Ambiguous Context, re-read the file and resend a corrected patch for that path only.",
	"Batch related file changes into one apply_patch call when possible.",
];
