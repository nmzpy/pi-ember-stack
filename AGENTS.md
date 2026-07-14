# pi-ember-stack AGENTS.md

2026

## Scope

- `pi-ember-stack` is the single Ember-owned Pi package and repository.
- It is a cross-platform TypeScript package for Pi on Windows, macOS, and Linux.
- The Ember application lives in the separate `Ember` repository and consumes this
  package through its project-local `.pi/settings.json`.
- The user is the sole maintainer and decision-maker.

## Core Principles

- **Quality First:** Prefer stable, production-safe Pi extensions over quick hacks.
- **Single Source of Truth (SSOT):** Every piece of data, config, constant, color,
  mode definition, tool mapping, or business logic has exactly one authoritative
  source. No duplicated constants, parallel config files, mirrored state, or
  copy-pasted logic. Derived representations must reference the canonical source.
  - Mode colors live in `pi-ember-ui/mode-colors.ts` — never hardcode hex values
    in renderers, themes, or agent definitions.
  - Tool factories live in `pi-compact-tools/index.ts` `TOOL_FACTORIES` — never
    re-import or re-register a tool from a second location.
  - Theme color tokens are defined once in `ember.json` (static) or
    `buildThemeFgColors`/`buildThemeBgColors` (dynamic) — never inline hex in
    component code.
  - Grouping keys (`groupKey`) and groupable tool sets (`GROUPABLE_TOOLS`) are
    defined once in `renderer.ts` — never duplicate the membership check.
- **DRY:** Keep one canonical implementation for each tool, mode, provider, and
  configuration rule. Do not recreate functionality in parallel plugin folders.
- **Cross-Platform by Default:** Never introduce Windows-only paths, shell syntax,
  environment assumptions, or filesystem separators into published code.
- **Simple Explanations:** Describe the user-facing behavior and operational impact
  after changes.
- **Explicit Releases:** Never commit, push, publish, delete repositories, or alter
  credentials unless the user explicitly requests that action.

## Golden Rules

- **Token-First Theming:** All UI colors must flow through theme tokens (`theme.fg`,
  `theme.bg`) or the shared `mode-colors.ts` helpers. Never embed raw hex or ANSI
  escape sequences directly in renderer or component code. The live accent color is
  the single authority for mode-derived visuals.
- **Compact Rendering Is Authoritative:** Tool call rows are single-line, bullet-led,
  and never dump raw content. Match counts, diff stats, and status labels append
  inline to the existing call row — never on a separate line below. Group headers
  (`Exploring`/`Explored`) summarize; child rows stay compact.
- **Dynamic Theme Is the Live Source:** `applyDynamicTheme()` rebuilds the full
  `Theme` instance from `mode-colors.ts` on every mode change. The static
  `ember.json` is the install-time seed only. Never patch individual theme fields
  ad-hoc; rebuild through the canonical pipeline.
- **Editor Patch Discipline:** The `Editor.prototype.render` monkey-patch is the
  single place where border, thinking animation, and content inset logic lives.
  Detect border lines structurally (by character content), not by fragile index
  arithmetic. Slash-command dimming gates on `getText()` content, not on external
  flags.
- **Animation Compliance:** Thinking animation frames, intervals, and opacity
  progressions are defined once as constants at the top of `pi-ember-ui/index.ts`.
  Never duplicate or hardcode animation timing in other files.
- **Fail Fast, No Fallbacks:** If a plugin cannot register its tools, apply its
  theme, or resolve its bundled agents, surface the error — do not silently
  degrade to a partial experience.

## Repository Ownership

- `pi-ember-stack` is the only Pi-owned repository.
- Do not create standalone repositories for compact tools, custom agents, plans,
  subagents, or Devin auth.
- Third-party code may be vendored under the appropriate plugin directory only when
  its license, attribution, and provenance are retained.
- The Ember application repository is intentionally separate from this package.

## Architecture Snapshot

Pi loads the one package entrypoint and the internal registry dispatches enabled
plugins from the project configuration:

```text
Pi
└── @nmzpy/pi-ember-stack
    ├── plugins/index.ts
    ├── plugins/pi-compact-tools/
    │   └── compact native tool rendering
    ├── plugins/pi-custom-agents/
    │   ├── primary modes, plans, footer, questionnaire
    │   └── subagent implementation and bundled agent definitions
    └── plugins/devin-auth/
        └── Devin provider, OAuth, catalog, and streaming
```

The project-local registry is `.pi/ember-stack.json`. The package entrypoint is
declared in `package.json` through the `pi.extensions` field. Keep those two
mechanisms aligned with the actual plugin folders.

## Plugin Boundaries

### `pi-compact-tools`

- Owns compact rendering for native coding tools.
- Every tool-call row uses the compact bullet prefix: `• `.
- Edit calls show `+N / -N` inline on the same row as the filename.
- Consecutive discovery calls (`read`, `grep`, `find`, and `ls`) may render as one
  inset `Explored` section with compact child rows.
- Use Pi's self-rendering `Component` contract carefully. Avoid spacer-heavy shells,
  duplicate result rows, and full preview diffs.
- Respect third-party ownership. `pi-fff` may own `grep` and `find` when
  `PI_FFF_MODE=override`; do not register conflicting tools in that mode.

### `pi-custom-agents`

- Owns `/coder`, `/architect`, `/doctor`, `/orchestrator`, and `/ui-doctor`.
- Owns the plan-review flow, questionnaire tool, footer, mode cycling, and
  `/subagent-model`.
- Resolves bundled definitions from `import.meta.url`; never use an absolute user
  home path or a Windows-only source path.
- Contains the vendored subagent implementation and bundled `.md` agent definitions.
- Keep read-only modes read-only through their active-tool allowlists.
- Does **not** persist or restore the active model. Pi core already writes the
  selected model to `settings.json` (`defaultProvider`/`defaultModel`) and the
  session (`model_change` entry) on every `/model`, `Ctrl+P`, and `pi.setModel()`.
  The persisted `pi-ember-stack.json` state is mode-only.

### `devin-auth`

- Owns the Devin provider, OAuth flow, model catalog, and streaming transport.
- Primes the live model catalog during the awaited factory load (reading
  credentials from `auth.json` via `AuthStorage`) so devin models exist before
  pi flushes pending provider registrations and restores the session model.
  `session_start` re-primes to cover `/login` and catalog-TTL expiry.
- Credentials, tokens, and provider secrets remain machine-local.
- Never commit `auth.json`, API keys, OAuth tokens, or generated credential files.

## Non-Negotiable Code Rules

- Use TypeScript ESM and strict typechecking. Run `npm run typecheck` after source
  changes.
- Use `snake_case` for local functions and variables where the surrounding Pi API
  permits; use `PascalCase` for classes and `UPPER_CASE` for constants.
- Prefer explicit types and narrow interfaces. Minimize `any`; use it only where Pi's
  dynamic extension API makes it unavoidable.
- Keep functions focused and avoid duplicated constants, tool definitions, renderers,
  or parallel configuration sources.
- Catch specific errors and surface actionable failures. Do not silently swallow
  extension-load, tool-registration, path-resolution, or package-install errors.
- Do not use absolute Windows paths in published source. Resolve package-owned files
  relative to `import.meta.url`; resolve runtime workspace operations from `ctx.cwd`.
- Do not add network calls to tests. Mock external providers and native boundaries.
- Preserve upstream licenses and attribution when modifying vendored code.
- Do not weaken production code to satisfy stale tests; update obsolete tests instead.

## Pi API Rules

- Register each command, shortcut, flag, and tool exactly once across the package.
- Check existing third-party tool ownership before overriding a built-in tool name.
- When overriding a built-in tool, delegate execution to Pi's original factory and
  change only the intended rendering or wrapper behavior.
- Keep tool renderers compact and deterministic. Reuse the same state object when a
  result must update the original call row.
- Use `ExtensionAPI` lifecycle events for session state and tool sequencing; do not
  mutate the TUI from unrelated asynchronous work.
- Treat project trust as a Pi security decision. Do not bypass it in code.
- **Read the Pi extensions docs before modifying extensions.** Consult
  `@earendil-works/pi-coding-agent/docs/extensions.md` (resolved from the installed
  package, not a hardcoded path) for the canonical `ExtensionAPI` contract, event
  types, lifecycle hooks, tool registration, UI context, and rendering APIs.

## Validation

Before proposing a source change, run the smallest relevant checks:

```text
npm run typecheck
git diff --check
npm pack --dry-run
```

For package or loader changes, also verify from a clean project directory:

```text
pi --approve --print "Reply with OK" --no-tools
```

When testing renderer behavior, exercise the registered `Component` objects with a
fake theme and deterministic arguments. Confirm bullets, grouped discovery rows,
inline edit statistics, error rendering, and absence of duplicate tool registration.

## Git and Release Discipline

- Preserve unrelated working-tree changes and staged changes.
- Never use `git reset --hard`, `git checkout --`, or `git stash` without explicit
  approval.
- Do not automatically commit, push, publish to npm, tag releases, or delete remote
  repositories. Ask or wait for an explicit user instruction.
- Keep `package.json` and `package-lock.json` synchronized when changing versions.
- Publish only intentional package versions. Update Ember's pinned package version
  separately when a release is approved.
- Release notes should describe user-facing Pi behavior, not vendoring mechanics.

## Change Checklist

For every change, verify:

- The behavior has one canonical owner under `plugins/`.
- No old standalone Pi repository or absolute path is referenced.
- Tool/command/flag names do not conflict with Pi or installed third-party packages.
- Windows, macOS, and Linux path behavior remains valid.
- Typecheck and targeted runtime/renderer checks pass.
- Secrets and generated package-install state remain untracked.
- No commit, push, publish, or destructive remote action occurs without approval.
- **Keep AGENTS.md updated** when architecture, plugin boundaries, conventions, or rules change. New plugins, new tools, new commands, and new rendering patterns must be reflected here.
