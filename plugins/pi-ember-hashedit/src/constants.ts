export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;
export const MAX_RANGE_STALE_LINES = 100;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 5;
export const NEW_CONTENT_NOT_ARRAY_MSG =
	`[E_BAD_SHAPE] "replacement_lines" must be an array of strings, one element per line, not a single string.` +
	` Do not pass one string with \\n separators — pass an array of lines: ["line1", "line2"]. Use [] to delete a range.`;
