import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// External allowlist — auto-detected pi-coding-agent package directory
// ---------------------------------------------------------------------------

/** The default alias for the pi-coding-agent package. */
export const PI_CODING_AGENT_ALIAS = "pi-coding-agent";

export type ExternalAllowlistEntry = {
  /** User-facing alias, e.g. "pi-coding-agent" (no leading ./). */
  alias: string;
  /** Auto-detected absolute directory. */
  dir: string;
};

export type ExternalAllowlist = {
  entries: readonly ExternalAllowlistEntry[];
  /** Resolve a user-facing path constraint to an allowlisted dir, or undefined. */
  resolve(pathConstraint: string): ExternalAllowlistEntry | undefined;
  /** True if an absolute path is inside an allowlisted dir. */
  covers(absolutePath: string): boolean;
};

export type ExternalTarget = {
  entry: ExternalAllowlistEntry;
  /** Path relative to entry.dir, forward-slashed, no leading ./, or "" for the whole dir. */
  relativePath: string;
};

/**
 * Auto-detect the installed @earendil-works/pi-coding-agent package root.
 * Returns undefined if detection fails (package not installed or
 * import.meta.resolve unavailable).
 */
function detect_pi_package_dir(): string | undefined {
  try {
    const resolved = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(resolved); // .../dist/index.js
    return path.dirname(path.dirname(entryPath)); // package root (parent of dist/)
  } catch {
    return undefined;
  }
}

/**
 * Build the external allowlist by auto-detecting the installed
 * @earendil-works/pi-coding-agent package directory. Returns an empty
 * allowlist if detection fails (fail-safe: no external access).
 */
export function buildExternalAllowlist(): ExternalAllowlist {
  const dir = detect_pi_package_dir();
  const entries: ExternalAllowlistEntry[] = [];
  if (dir) {
    entries.push({ alias: PI_CODING_AGENT_ALIAS, dir });
  }
  return {
    entries,
    resolve(pathConstraint: string): ExternalAllowlistEntry | undefined {
      let trimmed = pathConstraint.trim();
      if (!trimmed) return undefined;
      if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);
      for (const entry of entries) {
        if (trimmed === entry.alias) return entry;
        if (
          trimmed.startsWith(entry.alias + "/") ||
          trimmed.startsWith(entry.alias + path.sep)
        ) {
          return entry;
        }
      }
      return undefined;
    },
    covers(absolutePath: string): boolean {
      for (const entry of entries) {
        const rel = path.relative(entry.dir, absolutePath);
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * If `pathConstraint` targets an allowlisted external directory, return
 * the resolved entry and the sub-path relative to that dir. Otherwise
 * undefined. This lets the tool layer route to a secondary FileFinder
 * before normalization.
 */
export function resolveExternalTarget(
  pathConstraint: string | undefined,
  allowlist: ExternalAllowlist,
): ExternalTarget | undefined {
  if (!pathConstraint) return undefined;
  let trimmed = pathConstraint.trim();
  if (!trimmed) return undefined;

  // Absolute path — check if it's under an allowlisted dir.
  if (path.isAbsolute(trimmed)) {
    if (!allowlist.covers(trimmed)) return undefined;
    for (const entry of allowlist.entries) {
      const rel = path.relative(entry.dir, trimmed).replaceAll(path.sep, "/");
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return { entry, relativePath: rel };
      }
    }
    return undefined;
  }

  // Strip leading ./
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // Alias-prefixed relative path
  for (const entry of allowlist.entries) {
    if (trimmed === entry.alias) {
      return { entry, relativePath: "" };
    }
    // Check alias/ or alias\ as a prefix (cross-platform)
    const aliasPrefixFwd = entry.alias + "/";
    const aliasPrefixSep = entry.alias + path.sep;
    if (trimmed.startsWith(aliasPrefixFwd) || trimmed.startsWith(aliasPrefixSep)) {
      // Normalize to forward slashes for FFF
      const remainder = trimmed.startsWith(aliasPrefixFwd)
        ? trimmed.slice(aliasPrefixFwd.length)
        : trimmed.slice(aliasPrefixSep.length).replaceAll(path.sep, "/");
      return { entry, relativePath: remainder };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Path constraint normalization
// ---------------------------------------------------------------------------

export function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
  allowlist?: ExternalAllowlist,
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    // Allowlisted external absolute path — do not throw.
    if (allowlist?.covers(trimmed)) {
      const target = resolveExternalTarget(trimmed, allowlist);
      if (target) {
        // Return the relative path within the allowlisted dir.
        // If bare dir, return null (whole dir). Otherwise return the
        // relative subpath forward-slashed.
        if (!target.relativePath) return null;
        trimmed = target.relativePath;
        // Jump to the post-absolute-path normalization logic below.
      }
    } else {
      const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
      if (relative === "") return null;
      if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
        throw new Error(
          `Path constraint must be relative to the workspace: ${pathConstraint}`,
        );
      }
      trimmed = relative;
    }
  } else if (allowlist) {
    // Check for alias-prefixed relative path (e.g. ./pi-coding-agent/docs).
    const target = resolveExternalTarget(trimmed, allowlist);
    if (target) {
      if (!target.relativePath) return null;
      trimmed = target.relativePath;
    }
  }

  if (trimmed === "." || trimmed === "./") return null;
  // Strip a leading `./` so `./**/*.rs` and `**/*.rs` behave identically.
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // FFF's glob matcher can treat a hidden directory root glob such as
  // `.agents/**` as empty, while the tool contract says this means "inside
  // this directory". Collapse simple trailing recursive directory globs to the
  // directory-prefix constraint understood by the parser. Keep real file globs
  // such as `src/**/*.ts` unchanged.
  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  // Already signals path-constraint syntax to the parser.
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  // Globs (`*.ts`, `src/**/*.cc`, `{src,lib}`) are handled by the parser.
  if (/[*?[{]/.test(trimmed)) return trimmed;
  // Filename with extension (`main.rs`, `config.json`) → FilePath constraint.
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  // Bare directory prefix → append `/` so the parser sees a PathSegment.
  return `${trimmed}/`;
}

// Exclusions are emitted as `!<constraint>` tokens, which the Rust parser
// understands (crates/fff-query-parser/src/parser.rs). We normalize each one
// the same way as the include path so bare dirs become PathSegment excludes.
// Tolerate callers passing already-negated forms like `!src/` by stripping
// the leading `!` before normalizing so we never double-negate (`!!src/`).
export function normalizeExcludes(
  exclude: string | string[] | undefined,
  cwd = process.cwd(),
  allowlist?: ExternalAllowlist,
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd, allowlist);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

export function buildQuery(
  path: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
  allowlist?: ExternalAllowlist,
): string {
  const parts: string[] = [];
  if (path) {
    const pathConstraint = normalizePathConstraint(path, cwd, allowlist);
    if (pathConstraint) parts.push(pathConstraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd, allowlist));
  parts.push(pattern);
  return parts.join(" ");
}
