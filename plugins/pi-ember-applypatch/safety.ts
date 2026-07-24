/**
 * Workspace-root path normalization and traversal rejection for apply_patch.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ResolvedPath = {
	/** Relative path using forward slashes (display / result key). */
	relative: string;
	/** Absolute resolved path under the workspace root. */
	absolute: string;
};

/**
 * Normalize a patch path relative to `workspace_root`.
 * Rejects absolute paths, empty paths, `..` escapes, and symlink escapes.
 */
export function resolve_under_root(workspace_root: string, raw_path: string): ResolvedPath {
	const trimmed = String(raw_path ?? "").trim();
	if (!trimmed) {
		throw new Error("Path is empty");
	}
	if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
		throw new Error(`Absolute paths are not allowed: ${trimmed}`);
	}
	if (trimmed.includes("\0")) {
		throw new Error("Path contains a null byte");
	}

	const root = path.resolve(workspace_root);
	const joined = path.resolve(root, trimmed);
	const relative = path.relative(root, joined);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Path escapes workspace root: ${trimmed}`);
	}

	assert_no_symlink_escape(root, joined);

	const display = relative.split(path.sep).join("/");
	return { relative: display || ".", absolute: joined };
}

/**
 * If any existing ancestor of `target` (up to `root`) resolves outside the
 * real workspace root via symlink, reject. Non-existent paths are fine as
 * long as the lexical check already passed — we only probe existing nodes
 * and stop at the workspace root boundary (never walk above it).
 */
function assert_no_symlink_escape(root: string, target: string): void {
	let real_root = root;
	try {
		if (fs.existsSync(root)) {
			real_root = fs.realpathSync(root);
		}
	} catch {
		// Keep lexical root.
	}

	let probe = target;
	while (true) {
		const rel_to_root = path.relative(root, probe);
		if (rel_to_root.startsWith("..") || path.isAbsolute(rel_to_root)) {
			return;
		}

		try {
			if (fs.existsSync(probe)) {
				const real = fs.realpathSync(probe);
				const rel = path.relative(real_root, real);
				if (rel.startsWith("..") || path.isAbsolute(rel)) {
					throw new Error(`Path escapes workspace root via symlink: ${target}`);
				}
				return;
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}

		if (probe === root || rel_to_root === "") return;
		const parent = path.dirname(probe);
		if (parent === probe) return;
		probe = parent;
	}
}
