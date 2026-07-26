# pi-ember-fff

Ember-owned FFF-powered `grep` and `find` tools for Pi. Vendored from
[@ff-labs/pi-fff](https://github.com/ff-labs/pi-fff) 0.9.6 (MIT).

## Relationship to pi-compact-tools

When `pi-ember-fff` is enabled in `pi-ember-stack.json`, the stack loader
skips native `grep`/`find` registration in `pi-compact-tools` and this plugin
registers FFF-backed replacements instead. Both plugins share:

- **Compact rendering** via `getSharedRenderer()` from `pi-compact-tools`
- **Bash grep rewrite** via `bashGrepInfo` / `rewriteGrepToRg` in
  `pi-compact-tools/bash-grep.ts` (SSOT for detection and `grep` → `rg`
  translation)

## Module map

| File | Responsibility |
|------|----------------|
| `index.ts` | Flags, lifecycle, bash rewrite, wires registrars |
| `query.ts` | Path normalization, external allowlist, `buildQuery` |
| `cursor-store.ts` | Grep/find pagination cursor cache |
| `format.ts` | Output formatters (`formatGrepOutput`, `formatFindOutput`, `fffFileAnnotation`) |
| `finder.ts` | `FileFinder` lifecycle (workspace + external allowlist) |
| `mention.ts` | `@` path autocomplete provider |
| `grep-tool.ts` | `grep` tool registration |
| `find-tool.ts` | `find` tool registration |
| `commands.ts` | `/fff-health`, `/fff-rescan` |

## Flags

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `fff-frecency-db` | `FFF_FRECENCY_DB` | — | Path to frecency database |
| `fff-history-db` | `FFF_HISTORY_DB` | — | Path to query history database |
| `fff-enable-root-scan` | `FFF_ENABLE_ROOT_SCAN` | off | Index when launched from filesystem root |
| `fff-external-allow` | `FFF_EXTERNAL_ALLOW` | on | Allow `./pi-coding-agent` alias for package docs |

## Commands

- `/fff-health` — show finder health, git status, scan progress
- `/fff-rescan` — trigger a filesystem rescan

## External allowlist

`grep` and `find` accept `./pi-coding-agent` (and absolute paths under the
auto-detected `@earendil-works/pi-coding-agent` package) to search installed
package docs without leaving the workspace constraint. Resolver logic lives in
`query.ts`.
