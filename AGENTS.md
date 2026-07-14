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
  - Pulse timing (`PULSE_INTERVAL_MS`), bullet-color logic
    (`statusBulletColor`, `groupBulletColorFromFlags`), and the pulse timer
    (`PulseManager`) are defined once in `pi-compact-tools/renderer.ts` — never
    duplicate pulse timing or bullet-color logic in other plugins.
  - The subagent-running flag (`isLatestSubagentRunning`/
    `setLatestSubagentRunning`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the session-scan logic that sets it.
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
  ad-hoc; rebuild through the canonical pipeline. Live mode switches use the
  `liveOnly` event path: update the editor/footer viewport without invalidating
  the resumed transcript.
- **Editor Patch Discipline:** The `Editor.prototype.render` monkey-patch is the
  single place where border, thinking animation, and content inset logic lives.
  Detect border lines structurally (by character content), not by fragile index
  arithmetic. Slash-command dimming gates on `getText()` content, not on external
  flags. When the latest tool call is a running `subagent`, the editor top border
  becomes a dim inset line (1 column left/right, 0.1875 opacity) and the
  Thinking/Working gradient label is suppressed — the subagent box above shows
  live progress via flashing bullets. The `recompute_latest_subagent_running()`
  helper scans `sessionCtx.sessionManager` entries and writes the result to both
  the shared `isLatestSubagentRunning()`/`setLatestSubagentRunning()` flag in
  `pi-ember-ui/mode-colors.ts` and a local `subagentRunningCached` flag. It is
  called ONLY from `tool_execution_start`/`tool_execution_end` handlers — never
  from the render path. The editor border patch reads `subagentRunningCached`
  (O(1)) instead of scanning the session every frame. Never duplicate this
  session-scan logic and never call it from a render closure.
- **Per-Frame Render Budget:** No render closure (editor render, header render,
  footer render, tool renderCall/renderResult, PulseManager timer) may call
  `sessionManager.getEntries()`, `sessionManager.getBranch()`,
  `ctx.getContextUsage()`, `estimateContextTokens`, or any synchronous fs. These
  are O(n) or O(total context) and exceed the 33ms frame budget on long
  sessions, causing infini-lock. Cache their results on lifecycle events
  (`message_end`, `tool_execution_end`, `session_start`) and read the cache in
  render closures. The custom footer in `pi-custom-agents/index.ts` uses
  `footerStatsCache` (recomputed on `message_end`/`tool_execution_end`) instead
  of iterating entries + calling `getContextUsage()` every frame.
- **updateContent Skip Guard:** The patched
  `AssistantMessageComponent.prototype.updateContent` skips the full
  `contentContainer.clear()` + Markdown recreation when the message reference,
  `hideThinkingBlock`, and `outputPad` are unchanged (same key as the last
  call). `invalidate()` (theme change, thinking toggle) calls `updateContent`
  with the same message — without the guard, every assistant message in the
  transcript rebuilds all its Markdown children synchronously, freezing long
  transcripts on `ctrl+t`.
- **discoverAgents Cache TTL:** `agents.ts` `discoverAgents()` skips the
  fs-based `dirSignature()` validation for `CACHE_VALIDATION_TTL_MS` (2s)
  after a successful validation, so cache hits do zero synchronous fs. Agent
  `.md` edits within the TTL are not detected until `/subagent reload` or the
  TTL expires.
- **Animation Compliance:** Thinking animation frames, intervals, and opacity
  progressions are defined once as constants at the top of `pi-ember-ui/index.ts`.
  Never duplicate or hardcode animation timing in other files. The shared
  `PULSE_INTERVAL_MS` constant lives in `pi-compact-tools/renderer.ts` and is
  reused by the subagent renderer via `PulseManager`.
- **Subagent Background Token:** The `subagentBg` theme token (defined once in
  `mode-colors.ts` `buildThemeBgColors` and seeded in `ember.json`) is the
  single source for the subagent box background — userMessage color at 10% less
  opacity. Never inline a hex value for subagent backgrounds.
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
    ├── plugins/devin-auth/
    │   └── Devin provider, OAuth, catalog, and streaming
    └── plugins/pi-ember-fff/
        └── FFF-powered grep/find with external allowlist
```

The project-local registry is `.pi/ember-stack.json`. The package entrypoint is
declared in `package.json` through the `pi.extensions` field. Keep those two
mechanisms aligned with the actual plugin folders.

## Plugin Boundaries

### `pi-compact-tools`

- Owns compact rendering for native coding tools.
- Every standalone tool-call row uses the compact bullet prefix: `• `.
- Edit calls show `+N / -N` inline on the same row as the filename.
- Consecutive discovery calls (`read`, `grep`, `find`, `ls`, and bash
  `grep` invocations) fold into one inset `Exploring`/`Explored` group
  with compact, bullet-free child rows; only the group header carries the
  bullet. Bash grep calls display as "Search" and join the discovery
  group. The grouping contract is:
  - **First-member ownership:** The first discovery call that creates a
    group anchors the group header (`renderOwner`) and keeps it for the
    rest of the turn. Ownership never migrates to later calls. New
    discovery calls append as child rows under the existing header.
  - **Per-turn grouping with thinking-only continuity:** Discovery calls
    group within a single turn. `beginTurn()` (fired on `turn_start`)
    does NOT reset grouping state — instead, grouping is reset lazily in
    `registerCall()` only when the current turn has produced visible text
    output (tracked via `noteVisibleText()`, called from `message_update`
    on `text_start`/`text_delta`). A turn that only streams thinking
    tokens and then does discovery calls appends to the previous turn's
    group so exploration stays coherent when nothing visible separates
    the turns. Cross-turn grouping was removed because new-turn discovery
    calls joined the previous turn's group as non-owners, rendering empty
    and vanishing below thinking traces; the thinking-only exception
    preserves coherent grouping when there is genuinely nothing visible
    between turns.
  - **Monotonic group-scoped label:** The `Exploring`→`Explored` label is
    driven by a group-scoped `hasNonDiscovery` flag. Once a non-discovery
    tool call appears in the group, the flag is sticky for the rest of
    the turn. The label does not flip back.
  - **Owner-only invalidation:** Joining a group invalidates only the
    group owner (one invalidation), not all members. This eliminates
    duplicate-header flicker and extra blank lines. This invalidation
    only runs from `registerCall` for *new* calls (never during Pi
    rebuilds, which early-return for existing ids).
  - **Shared group visual handle:** The group's `callText` (`Text`) is
    the single persistent visual for the group block. The owner re-binds
    it to its live `Text` on every `renderCall`; members write into it
    directly via `setText` in `renderResultInner` so completions (bullet
    color, match count, `Explored` label) appear without invalidating the
    owner. `setResult` does NOT invalidate the owner — direct `callText`
    updates replace the old synchronous invalidate→`updateDisplay`→
    `renderResult`→`setResult` path, which raced during Pi rebuilds.
  - **Rebuild-safe invalidate rebind:** Pi rebuilds tool components on
    thinking-toggle (`ctrl+t`), hide-thinking setting, compaction, and
    output-pad/cache-miss settings changes (`chatContainer.clear()` +
    `rebuildChatFromMessages()`). The `registerCall` early-return for an
    existing `toolCallId` swaps the destroyed component's invalidate out
    of the `PulseManager` and inserts the live one, so the pulse timer
    only fires live components and destroyed owners cannot hijack
    `record.invalidate` back to dead components.
  - **Non-owner rendering:** Non-owner group members render an empty
    `Text` (zero vertical space) so only the owner hosts the visible
    group block.
- Use Pi's self-rendering `Component` contract carefully. Avoid spacer-heavy shells,
  duplicate result rows, and full preview diffs.
- Respect third-party ownership. `pi-fff` may own `grep` and `find` when
  `PI_FFF_MODE=override`; do not register conflicting tools in that mode.
- Bash `grep` commands are intercepted in `tool_call` and rewritten to
  equivalent `rg` (ripgrep) invocations. Combined short flags (`-rn`,
  `-rin`), `--include`/`--exclude`/`--exclude-dir`, context flags (`-A`,
  `-B`, `-C`), and `cd <dir> &&` prefixes are translated. Unknown flags
  cause a safe bail (original grep runs unchanged).
- **Shared rendering primitives:** `renderer.ts` exports the canonical
  `PULSE_INTERVAL_MS`, `statusBulletColor`, `groupBulletColorFromFlags`,
  `PulseManager`, and `BULLET` for reuse by other plugins (notably the
  subagent renderer). Never duplicate pulse timing or bullet-color logic;
  import from here.

### `pi-custom-agents`

- Owns `/coder`, `/architect`, `/doctor`, `/orchestrator`, and `/ui-doctor`.
- Owns the plan-review flow, questionnaire tool, footer, mode cycling, and
  `/subagent-model`.
- Owns the `shift+t` thinking-level cycle through the extension editor. `ctrl+t`
  remains Pi's built-in thinking visibility toggle.
- The model picker uses `shift+m`; never bind `ctrl+m`, because macOS/Linux
  terminals encode Enter as carriage return (`Ctrl+M`).
- `/model` is intercepted in the extension editor's `handleInput` and redirected
  to the shared fuzzy-search `show_model_picker` (same as `shift+m`), so Pi's
  built-in unbounded model selector never appears.
- Resolves bundled definitions from `import.meta.url`; never use an absolute user
  home path or a Windows-only source path.
- Contains the vendored subagent implementation and bundled `.md` agent definitions.
- **Subagent rendering:** The `subagent` tool uses `renderShell: "self"` and
  renders a compact, Exploring-style grouped layout inside a `Box` with the
  `subagentBg` theme token (userMessage color at 10% less opacity). Running
  agent names use the same gradient sweep as the Thinking header; completed
  agents use green bullets and failed agents use red bullets. Parallel/chain
  mode shows a `Subagents` header + `└ agent` children with the same status
  treatment. No `⏳`, `[scope]`, or `parallel (N tasks)` labels. Chain mode
  only shows running + completed steps (pending steps hidden until they start).
  The completed/failed bullet logic and pulse timer reuse `statusBulletColor`
  and `PulseManager` from `pi-compact-tools/renderer.ts` — never duplicate
  them. The runner owns completion through `session.prompt()` and disposes
  only after that promise settles; never race `agent_end` against disposal.
  When the subagent is the latest running tool call, a full-opacity
  `border`-colored horizontal cap line is drawn above the box (visually
  extending the chatbox upward), gated on `isLatestSubagentRunning()` from
  `pi-ember-ui/mode-colors.ts`. The expanded view (Ctrl+O) wraps detailed
  per-agent output in the same `subagentBg` Box.
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
- When cancelling a `fetch` response body stream obtained via `getReader()`,
  call `reader.cancel()`, never `resp.body.cancel()`. The body is locked by
  the reader; `resp.body.cancel()` throws `ERR_INVALID_STATE` synchronously
  and can crash the process via `uncaughtException`. Always attach
  `.catch(() => {})` to `reader.cancel()` — on Node ≥25 a rejected
  `cancel()` promise surfaces as an unhandled rejection that triggers pi's
  `uncaughtException` handler and exits the process.
- An `unhandledRejection` guard in the extension entry point swallows
  `DOMException [AbortError]` rejections that arise when the user cancels
  an in-flight agent run (Escape during streaming). The agent's
  `AbortController.abort()` sets `signal.reason` to a `DOMException`; late
  rejections from the fetch body stream, `reader.cancel()`, or the
  `anySignal` polyfill can escape as unhandled rejections. Non-abort
  rejections are re-emitted so genuine bugs still surface. The guard is
  removed on `session_shutdown`.

### `pi-ember-fff`

- Owns the Ember-owned `grep` and `find` tool registrations (override mode),
  backed by the vendored `@ff-labs/fff-node` file finder.
- Delegates compact rendering to the shared `CompactRenderer` from
  `pi-compact-tools` via `getSharedRenderer()` so the TUI stays consistent
  across all discovery tools.
- Bash `grep` commands are intercepted in `tool_call` and rewritten to
  equivalent `rg` (ripgrep) invocations (same rewrite logic as
  `pi-compact-tools`).
- **External allowlist:** `grep` and `find` accept a `./pi-coding-agent`
  path alias (and absolute paths under the auto-detected
  `@earendil-works/pi-coding-agent` package directory) to search the
  installed package's docs and examples without hitting the
  workspace-relative path constraint. The package directory is
  auto-detected cross-platform via `import.meta.resolve` — never hardcoded.
  A secondary `FileFinder` instance is created for the external directory
  and routed to transparently. Controlled by the `fff-external-allow` flag
  (default: on) or `FFF_EXTERNAL_ALLOW` env var. The allowlist resolver
  (`buildExternalAllowlist`, `resolveExternalTarget`) lives in `query.ts`
  — the single source of truth for external path routing. The secondary
  finder is destroyed on `session_shutdown`.
- Path constraint normalization (`normalizePathConstraint`,
  `normalizeExcludes`, `buildQuery`) lives in `query.ts` — never duplicate
  path-mapping logic in the tool execute functions.

## Non-Negotiable Code Rules

- Use TypeScript ESM and strict typechecking. Run `./t.gate.sh` after source
  changes — it runs Biome lint, `tsc --noEmit`, and Bun tests in one pass.
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
- **Session-replacement discipline:** Pi re-evaluates extension factories on
  `/resume`, `/new`, `/fork`, and `/reload`, but jiti caches the module, so
  module-level `let`/`const` state survives across sessions with stale
  references. Every plugin that holds session-bound module-level state
  (timers, `ctx`, `requestRender`, `tuiRef`, `liveTheme`, renderer caches)
  MUST reset it in a `session_shutdown` handler and rebind it in
  `session_start`. The factory body must not call into session-bound state
  before `session_start` fires. There is no `session_switch` event — use
  `session_start` with `event.reason === "resume"` instead.
- Treat project trust as a Pi security decision. Do not bypass it in code.
- **Read the Pi extensions docs before modifying extensions.** Consult
  `@earendil-works/pi-coding-agent/docs/extensions.md` (resolved from the installed
  package, not a hardcoded path) for the canonical `ExtensionAPI` contract, event
  types, lifecycle hooks, tool registration, UI context, and rendering APIs.

## Validation

Before proposing a source change, run the validation gate:

```text
./t.gate.sh
```

This runs Biome lint (`biome lint`), TypeScript typecheck (`tsc --noEmit`),
and Bun tests (`buntest plugins/`) in one pass. For targeted checks on
specific files, pass them as arguments: `./t.gate.sh plugins/pi-compact-tools/renderer.ts`
(skips tests, runs lint + typecheck).

Individual commands are also available:

```text
npm run lint       # biome lint
npm run format     # biome format --write
npm run check      # biome check (lint + format)
npm run typecheck  # tsc --noEmit
```

For package or loader changes, also verify:

```text
git diff --check
npm pack --dry-run
```

and from a clean project directory:

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
