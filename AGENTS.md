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
    `buildThemeFgColors`/`buildThemeBgColors`/`buildThemeExportColors`
    (dynamic) — never inline hex in component code. Export colors
    (pageBg, cardBg, infoBg) are derived from `PAGE_BG` and the accent via
    `buildThemeExportColors` in `mode-colors.ts` and written to the
    installed `ember.json` only at install time (`ensureThemeInstalled`).
    Never write the theme JSON mid-session: Pi's theme file watcher
    reloads via `createTheme()`, which drops custom bg keys
    (`subagentBg`) and crashes `theme.bg("subagentBg")`. Live mode
    switches update the in-memory Theme only; `reassertLiveTheme` +
    `scheduleThemeReassert` reclaim the global theme after any
    install-time write races the watcher.
  - Grouping keys (`groupKey`) and groupable tool sets (`GROUPABLE_TOOLS`) are
    defined once in `renderer.ts` — never duplicate the membership check.
  - Pulse timing (`PULSE_INTERVAL_MS`), bullet-color logic
    (`statusBulletColor`, `groupBulletColorFromFlags`), and the pulse timer
    (`PulseManager`) are defined once in `pi-compact-tools/renderer.ts` — never
    duplicate pulse timing or bullet-color logic in other plugins. The
    subagent renderer no longer uses `PulseManager`; it subscribes to the
    shared gradient clock instead (see Animation Compliance).
  - Terminal gradient rendering (Gaussian sweep, RGB interpolation, Chalk
    colorization, semantic presets, and the 20 FPS shared clock) lives once
    in `pi-ember-ui/gradient.ts` — never duplicate gradient math, animation
    timing, or color constants in other files.
  - The subagent-running flag (`isLatestSubagentRunning`/
    `setLatestSubagentRunning`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the session-scan logic that sets it.
  - The output-limit auto-continue flag (`isPlanAutoContinuing`/
    `setPlanAutoContinuing`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the output-limit suppression logic that sets it. The flag
    suppresses the length-error row during auto-continue recovery in all
    modes, not only plan mode.
  - The questionnaire-active flag (`isQuestionnaireActive`/
    `setQuestionnaireActive`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the overlay-active logic that sets it.
- **DRY:** Keep one canonical implementation for each tool, mode, provider, and
  configuration rule. Do not recreate functionality in parallel plugin folders.
- **Cross-Platform by Default:** Never introduce Windows-only paths, shell syntax,
  environment assumptions, or filesystem separators into published code.
- **Simple Explanations:** Describe the user-facing behavior and operational impact
  after changes.
- **Explicit Releases:** Never commit, push, publish, delete repositories, or alter
  credentials unless the user explicitly requests that action.

## Golden Rules

- **Never Nuke Scrollback:** Never call `requestTuiRender(true)`,
  `tui.requestRender(true)`, or anything that emits `\x1b[3J` from render,
  lifecycle, or snap paths. Pi's `requestRender(true)` sets
  `previousWidth = -1` / `previousHeight = -1`, forcing `doRender()` into
  `fullRender(true)` which emits `\x1b[2J\x1b[H\x1b[3J` — the `3J` destroys
  terminal scrollback and pins the viewport to the bottom (the "can't
  scroll anymore" bug). Use `requestTuiRenderSnapToBottom()` (re-exported
  from `pi-ember-ui/layout.ts` `snap_tui_to_bottom`) for any snap that must
  re-pin the chatbox to the bottom after a line-count shrink: it clears only
  the visible screen (`\x1b[2J\x1b[H`, never `3J`), resets Pi's
  differential bookkeeping, and requests a normal render whose first-render
  path re-anchors `previousViewportTop` to the bottom. The slash-command
  exit snap, the thinking-toggle snap, and the compact-group auto-settle
  snap all use this helper.
- **Token-First Theming:** All UI colors must flow through theme tokens (`theme.fg`,
  `theme.bg`) or the shared `mode-colors.ts` helpers. Never embed raw hex or ANSI
  escape sequences directly in renderer or component code. The live accent color is
  the single authority for mode-derived visuals.
- **Compact Rendering Is Authoritative:** Tool call rows are single-line, bullet-led,
  and never dump raw content. Both standalone and grouped call rows use the
  `CompactGroupText` component (ANSI-aware `truncateToWidth` at the TUI's
  supplied available width) so a long bash command, file path, or result line
  never wraps to multiple rows — it ellipsizes to one row. Match counts, diff
  stats, and status labels append inline to the existing call row — never on a
  separate line below. Group headers (`Exploring`/`Explored`) summarize;
  child rows stay compact.
- **Dynamic Theme Is the Live Source:** `applyDynamicTheme()` rebuilds the full
  `Theme` instance from `mode-colors.ts` on every mode change. The static
  `ember.json` is the install-time seed only. Never patch individual theme fields
  ad-hoc; rebuild through the canonical pipeline. Live mode switches use the
  `liveOnly` event path: update the theme color maps, bump
  `markdownThemeGeneration`, invalidate the TUI so each
  `AssistantMessageComponent.updateContent` rebuilds its `CachedMarkdown`
  children (the skip-guard keys on the theme generation — mode switches
  recolor MD headers/links/bullets; identical invalidate inputs still
  skip). `install_markdown_theme_patch` is the one global Markdown boundary:
  before every `Markdown.render`, it binds the component's `heading` callback
  to `emberHeadingStyle`, so assistant/custom/compaction/branch/skill/changelog
  Markdown all resolve `mdHeading` through the live Theme rather than Pi's
  watcher-replaced static seed. Never add per-component heading patches.
  Invalidate the loaded-resources container
  (`invalidateLoadedResources`), and request a render. Heading color
  always resolves via the live Theme at call time (`emberHeadingStyle` →
  `mdHeading`), never a closed-over Theme from construction. The
  `ExpandableText.prototype.invalidate` patch (installed by
  `installExpandableTextPatch`) re-evaluates the `getCollapsedText`/
  `getExpandedText` callbacks on invalidate so the `[Context]`/`[Skills]`/
  `[Extensions]`/`[Themes]` section headers and bodies refresh their ANSI
  codes with the live accent. Never bypass this patch by baking
  `theme.fg(...)` output into a `Text` without a re-evaluation path.
  `invalidateLoadedResources()` is a recursive walk over the live `tuiRef`
  tree (not the old fragile grandchild-only scan): it invalidates every
  `ExpandableText` and also recolors plain accent `Text` rows that Pi
  bakes once at construction and never refreshes (`✓ New session started`,
  `What's New`, `Keyboard Shortcuts`). The baked-accent recolor table
  (`ACCENT_TEXT_RECOLORERS`) maps the ANSI-stripped visible string to a
  recolor function that re-renders via `resolve_live_theme().fg("accent",
  …)` — SSOT, no hardcoded hex. If Pi adds new accent `Text` rows in the
  future, add them to `ACCENT_TEXT_RECOLORERS`; do not add a second
  recolor path. A `WeakSet` guards against cycles; O(nodes) per mode
  switch.
- **Editor Patch Discipline:** The `Editor.prototype.render` monkey-patch is the
  single place where border and content inset logic lives. Detect border lines
  structurally (by character content), not by fragile index arithmetic.
  Slash-command dimming gates on `getText()` content, not on external flags.
  The editor border is a **straight-rule chatbox**: 0-column outer inset, with
  dim, inset-by-1 horizontal rules (`──`) on top and bottom (`DIM_COLOR`),
  no side pipes, no rounded corners. The editor content has 1-col inner
  padding (`INNER_PAD = 1`) on each side plus a 2-col gutter on the left.
  The gutter shows a `> ` prompt glyph on the first editor body row and a
  `  ` (two-space) gutter on subsequent rows; in shell mode the prompt
  glyph is `! ` instead of `> `. The `innerWidth` passed to Pi's original
  render subtracts `INSET * 2 + 2 + INNER_PAD * 2` from the terminal width
  (the `+ 2` is the gutter, not pipe columns). When the agent is in Working
  state (`workingActive` or `agentRunPending`, from `agent_start` to
  `agent_settled`) or in shell mode, the prompt glyph and the non-slash
  middle separator use `MUTED_COLOR` instead of `TEXT_COLOR`, giving the
  chatbox a dimmed appearance while the agent is running. The border color
  logic for those elements is `(isShellMode() || workingActive ||
  agentRunPending) ? MUTED_COLOR : TEXT_COLOR`. In slash-command mode, the
  middle separator is rendered as a dim inset horizontal rule (`──` at
  `DIM_COLOR`, inset **1 column on each side**, `SLASH_MIDDLE_INSET = 1`)
  with no junction glyph. The previous slash-mode bottom border dimming
  is removed. Pi's native TUI render path is
  left unpatched — content flows top-down and scrolls when it exceeds the
  terminal height. The `recompute_latest_subagent_running()` helper
  scans `sessionCtx.sessionManager` entries and writes the result to the
  shared `isLatestSubagentRunning()`/`setLatestSubagentRunning()` flag in
  `pi-ember-ui/mode-colors.ts`. It is called ONLY from
  `tool_execution_start`/`tool_execution_end` handlers — never from the
  render path. The local subagent-running cache has been removed; the
  editor border no longer reads subagent state. Never duplicate this
  session-scan logic and never call it from a render closure. The
  Thinking/Working gradient label is NO LONGER rendered inside the editor
  border — it lives in a `setWidget("ember-thinking", …)` row above the editor
  (see Thinking Widget below). The editor fake cursor (Pi's `\x1b[7m` reverse
  video) is blinked at 500ms via `cursorBlinkTimer` (`CURSOR_BLINK_INTERVAL_MS`).
  The `Editor.prototype.render` override strips `\x1b[7m...\x1b[0m` from all
  rendered lines when `cursorVisible` is false, leaving the zero-width
  `CURSOR_MARKER` intact so IME positioning still works. The blink timer is
  started in `session_start` (TUI mode) and cleared in `session_shutdown`.
- **Per-Frame Render Budget:** No render closure (editor render, header render,
  footer render, tool renderCall/renderResult, PulseManager timer) may call
  `sessionManager.getEntries()`, `sessionManager.getBranch()`,
  `ctx.getContextUsage()`, `estimateContextTokens`, or any synchronous fs. These
  are O(n) or O(total context) and exceed the 33ms frame budget on long
  sessions, causing infini-lock. Cache their results on lifecycle events
  (`message_end`, `tool_execution_end`, `session_start`) and read the cache in
  render closures. The custom footer in `pi-ember-ui/footer.ts` uses
  `footerStatsCache` (recomputed on `message_end`/`tool_execution_end`) instead
  of iterating entries + calling `getContextUsage()` every frame.
- **updateContent Skip Guard:** The patched
  `AssistantMessageComponent.prototype.updateContent` skips the full
  `contentContainer.clear()` + Markdown recreation when the message reference,
  `hideThinkingBlock`, and `outputPad` are unchanged (same key as the last
  call). `invalidate()` (theme change, thinking toggle) calls `updateContent`
  with the same message — without the guard, every assistant message in the
  transcript rebuilds all its Markdown children synchronously, freezing long
  transcripts on `ctrl+t`. A bounded shared Markdown render cache, keyed by
  content, block type, padding, width, and theme generation, also serves fresh
  assistant components created during Pi rebuilds; it is cleared on dynamic
  theme changes and session shutdown.
- **discoverAgents Cache TTL:** `agents.ts` `discoverAgents()` skips the
  fs-based `dirSignature()` validation for `CACHE_VALIDATION_TTL_MS` (2s)
  after a successful validation, so cache hits do zero synchronous fs. Agent
  `.md` edits within the TTL are not detected until `/subagent reload` or the
  TTL expires.
- **Animation Compliance:** Thinking animation frames, intervals, and opacity
  progressions are defined once as constants in `pi-ember-ui/gradient.ts`.
  Never duplicate or hardcode animation timing in other files. The gradient is
  timer-driven: a single 20 FPS `setInterval` (`GRADIENT_TICK_MS` = 50) in
  `gradient.ts` advances a phase computed from elapsed monotonic time
  (`performance.now()`), not incremental frame steps — so lag catches up
  instead of slowing the animation. The render scheduler
  (`MIN_RENDER_INTERVAL_MS` = 50) matches the clock tick rate so no ticks
  are wasted. The sweep cycle is `GRADIENT_DURATION_MS` = 1600 ms (20%
  faster than the original 2 s); the logo round-trip is
  `LOGO_DURATION_MS` = 3200 ms. The sweep uses an offscreen-to-offscreen
  Gaussian center (`compute_sweep_center`) with unified edge padding
  (`EDGE_PADDING` = `Math.ceil(3 * GRADIENT_SIGMA)` = 9 cells) for all
  presets — no preset-specific padding branching — ensuring the Gaussian
  fully exits before the phase wraps, preventing visible snap-restart on
  short labels. No circular wrap. The accent palette is a 3-stop
  RGB-space blend (MUTED_COLOR base → 50% toward accent → accent peak) with a
  per-generation RGB cache — no per-char hex parsing. Semantic presets
  (`thinking`, `working`, `exploringGroup`, `workingGroup`, `subagent`)
  reference shared base palette definitions; `thinking`/`working`/`subagent`
  share the accent palette, `exploringGroup`/`workingGroup` share the
  muted→text palette. `renderLiveGradient(text, preset)` drives the
  Thinking/Working widget, subagent running-agent labels, and compact group
  headers. The Pi logo gradient animation runs indefinitely on
  fresh sessions (`startup`/`new`) until the first streamed assistant token
  (`thinking_delta` or `text_delta`), so turn-start lifecycle events never
  prematurely stop the intro. The logo shares the same phase/Gaussian
  helper/clock but preserves its radial base design. Once stopped it renders
  as a static 2-stop vertical gradient
  (top muted `#808080`, bottom text `TEXT_COLOR` from `mode-colors.ts`) with
  a box-drawing drop-shadow contour (`─│┌┐└┘├┤┬┴┼` glyphs at 25% opacity,
  offset one cell down and right).
  `session_shutdown` is the safety floor. The shared `PULSE_INTERVAL_MS`
  constant lives in `pi-compact-tools/renderer.ts` and is used by
  `PulseManager` for compact-tool bullet flashing only; the subagent
  renderer subscribes to the shared gradient clock via
  `subscribeGradientTick`/`unsubscribeGradientTick` from
  `pi-ember-ui/index.ts` (re-exported from `gradient.ts`). The clock
  dispatches a stable snapshot of subscribers each tick — callbacks added
  or removed during dispatch are not visited until the next tick, preventing
  same-tick re-addition loops.
- **Thinking/Summarizing Widget & Tool Group Precedence:** The Thinking/Working
  gradient label is rendered in a `setWidget("ember-thinking", …)` row directly
  above the editor (default `aboveEditor` placement; `CHATBOX_LEADING_ROWS` in
  `layout.ts` is 1 blank row above the label when visible, or above the chatbox
  when hidden; the label is flush to the editor), NOT inside the editor top
  border. The widget row has a 3-column inset on left and right. The widget
  render closure is O(1): it reads `thinkingActive`, `workingActive`,
  `agentRunPending`, and `summarizingActive` and remains visible while compact
  groups are active, so the chatbox state is never hidden by an
  `Exploring`/`Editing`/`Writing`/`Bashing` transcript group. It is
  suppressed when a questionnaire overlay is active
  (`isQuestionnaireActive()` in `mode-colors.ts`, set by the questionnaire
  tool) so the Thinking/Working header does not show behind a Plan Review
  or Tool Loop Detected prompt. The
  `agentRunPending` flag (SSOT in `pi-ember-ui/index.ts`, never duplicated)
  bridges the inter-run gap: `agent_end` fires between each low-level run,
  but Pi may auto-retry, auto-compact and retry, or continue with queued
  follow-ups — only `agent_settled` means Pi will not run again
  automatically. `agent_start` sets it true; `agent_settled` (and
  `session_shutdown`, the safety floor) clear it. While it is true the
  widget stays visible (showing `Thinking` when neither `thinkingActive`
  nor `workingActive` is set) and the editor border stays muted, so the header
  state is never lost during compaction/retry/follow-up gaps.
  When Pi is compacting context (manual `/compact`, threshold, or overflow
  recovery), `summarizingActive` is set by a prototype patch on
  `InteractiveMode.showStatusIndicator`/`clearStatusIndicator`. The widget then
  shows `Summarizing` with the live `thinking` gradient, suppresses the stock
  `CompactionStatusIndicator` text, and hides `Thinking`/`Working`. The flag is
  cleared on `compaction_end` (success, abort, or error) and `session_shutdown`.
  Escape-to-cancel remains wired by Pi's `compaction_start` editor handler.
  Never clear `thinkingActive`/`workingActive` from `agent_end` alone and
  expect the widget to stay — `agent_end` is not the end of the user's
  task. Group headers still carry their own muted/text gradient
  sweep via `renderLiveGradient(label, "exploringGroup")` or
  `"workingGroup"` (no accent color — just muted→text). When the group settles
  (visible user-facing text, a non-group or different-group tool, a user
  message, or `turn_end`), the header reverts to plain bold final summary.
  Thinking deltas do NOT settle the group — the model routinely thinks
  between consecutive discovery calls, and settling on every thinking
  delta would prevent read/grep/find/ls calls from ever folding into a
  single `Exploring` group. Only visible text (the agent writing its
  response) marks the boundary between exploration batches. The
  `isToolGroupActive`/`setToolGroupActive` flag lives in
  `pi-ember-ui/mode-colors.ts` (SSOT), written from `pi-compact-tools` lifecycle
  handlers (`tool_call`, `tool_execution_end`, `turn_end`, `session_start`) via
  `CompactRenderer.hasActiveGroups()` — never from a render closure. The
  widget, the thinking tick timer, and the group tick subscriptions are
  cleared on `session_shutdown`. `Ctrl+T` (show/hide thinking blocks) is
  also the toggle that reveals/collapses settled group child rows — see
  the Settled-group collapse bullet in the `pi-compact-tools` grouping
  contract.
- **Message/Row Background Token:** The `MUTED_MESSAGE_BG` constant in
  `mode-colors.ts` (`desaturateHex(blendToHex("#ffffff", PAGE_BG, 0.05), 1)` —
  white at 5% opacity over `PAGE_BG`, desaturated to a pure neutral grey =
  `#262626` so the PAGE_BG blue bias does not bleed through) is the single
  source for the subagent-row and custom/compaction-message backgrounds.
  It is mode-independent: no orange/purple/green/yellow accent tint bleeds
  into message backgrounds. `buildThemeBgColors` assigns the same constant
  to `subagentBg` and `customMessageBg`; the static `ember.json` seed mirrors
  it (`subagentBg`/`customMsgBg` = `#262626`). Never inline a hex value for
  these backgrounds and never re-derive them from the accent. The subagent
  background is applied per completed/failed row only; running rows and the
  `Subagents` header remain transparent.
- **User-message / questionnaire / compaction border style:**
  `UserMessageComponent`, the questionnaire `renderCall`/`renderResult`, and
  `CompactionSummaryMessageComponent` use chatbox-style horizontal rules (`──`)
  at 50% opacity over `PAGE_BG`, sourced from `TEXT_COLOR` via
  `colorWithOpacity(..., 0.5)` in `pi-ember-ui/index.ts`. The
  `chatboxBorderContainer(content, paddingX)` helper wraps content with a top
  and bottom `DynamicBorder` and a `Box(paddingX, 0, undefined)` for
  left/right inset, with no background fill. This replaces the previous
  `userMessageBg`/`customMessageBg` block backgrounds for those rows.
  Compaction summaries render a plain bold `Compaction` header (no
  `[compaction]` label) followed by a single line:
  `Summarized {tokensBefore} tokens into ~{estimatedSummaryTokens}.`
  (estimate = `Math.ceil(summary.length / 4)`). The collapsed row appends a
  dim `ctrl+o to expand` hint; the expanded row shows the summary Markdown
  under the same header/stats line. The background is transparent; only
  `MUTED_MESSAGE_BG` still applies to subagent-row and custom/compaction
  message backgrounds where the chatbox rule style has not been applied.
  OSC133 zone markers are preserved by `UserMessageComponent.render` wrapping
  the rendered block.
- **Mode-switch tool-access reminder:** When `apply_mode` switches between two
  different modes, it injects a hidden `pi-agents-tool-access` custom message
  (`display: false`, same channel as `pi-agents-auto-continue` and
  `pi-agents-loop-retry`) telling the model which tools it lost, which it
  gained, and its current tool set. This steers the next turn without
  cluttering the transcript. Never duplicate this reminder in other plugins.
- **Frozen code-accent visuals:** The Pi header logo gradient and the header
  bullet (`•`) are frozen at the code-mode accent (`MODE_COLORS.code` =
  `#EB6E00`) in every mode — they never follow the live mode accent. The
  Markdown token `mdLink` is also frozen at the code accent.
  `mdHeading` and `mdListBullet` (ordered `1.` / unordered `-` markers)
  use `MUTED_COLOR` — never the live or code accent. Compact-tool match
  counts (`N matches`) also use `muted`. The header render closure in
  `pi-ember-ui/index.ts` passes `MODE_COLORS.code` to
  `renderLogoWithGradient` and paints the header bullet via `fgAnsi` +
  `MODE_COLORS.code` directly (not `mdListBullet`). Pi's startup update
  notice (`pi update` / changelog URL) is patched in
  `installUpdateNotificationPatch` to use `text`/`muted` instead of
  `accent`, so it never inherits the startup mode color (e.g. plan purple).
  Everything else (footer mode label, thinking/working gradient, borders,
  tool titles, `customMessageLabel`) continues to follow the live mode
  accent. Never rewire the logo/header-bullet to `getActiveModeColor()`.
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
    │   ├── primary modes, plans, questionnaire
    │   └── subagent implementation and bundled agent definitions
    ├── plugins/devin-auth/
    │   └── Devin provider, OAuth, catalog, and streaming
    ├── plugins/pi-cursor-auth/
    │   └── Cursor subscription auth, model discovery, and Pi-native streaming
    ├── plugins/pi-ember-dcp/
    │   └── Dynamic context pruning, compress tool, /dcp controls
    ├── plugins/pi-ember-fff/
    │   └── FFF-powered grep/find with external allowlist
    └── plugins/pi-ember-webtools/
        └── Web search, URL fetching, GitHub cloning, PDF/YouTube/video extraction
```

The global plugin registry is `PI_HOME/pi-ember-stack.json` (resolved from
`PI_HOME` or `~/.pi/agent/`). It is the single source of truth for both the
enabled plugin list (the `plugins` array, owned by `plugins/index.ts`) and the
persisted mode and per-mode model state (owned by `pi-custom-agents/index.ts`). Both writers
use read-merge-write so neither clobbers the other's fields. There is no
project-local `ember-stack.json` — the plugin list is global, not per-project.
The package entrypoint is declared in `package.json` through the `pi.extensions`
field. Keep that mechanism aligned with the actual plugin folders.

## Plugin Boundaries

### `pi-compact-tools`

- Owns compact rendering for native coding tools.
- Every standalone tool-call row uses the compact bullet prefix: `• `.
- Edit calls show `+N | -N` inline on the same row as the filename. While
  the model streams `oldText`/`newText` (before the edit runs), the counts
  are live: `streamingEditStats` computes a running line-level diff
  (`Diff.diffArrays`) on each `renderCall` so the row updates from `+1` toward
  the final count in real time. Once the edit completes, the authoritative
  `diffStats` from `result.details.diff` takes over. Both standalone and
  grouped edit rows use the same live path. `Diff` is imported once in
  `renderer.ts` — never duplicate line-diff counting in other plugins.
  Write calls also show `+N | -0` as `content` streams and once completed:
  `streamingWriteStats` counts non-empty content lines from `args.content`
  (write has no `details.diff`); `-0` is shown because write is a full
  rewrite / new file.
- Consecutive discovery calls (`read`, `grep`, `find`, `ls`, and bash
  `grep` invocations) fold into one inset `Exploring`/`Explored N files` group
  with compact, bullet-free child rows; only the group header carries the
  bullet. Bash grep calls display as "Search" and join the discovery
  group. Consecutive `edit`, `write`, and non-grep `bash` calls form separate
  `Editing`/`Edited N files`, `Writing`/`Written N files`, and
  `Bashing`/`Bashed N commands` groups. Grouped edit children show only their
  path plus `+N -N`; grouped write children show only their path plus
  `+N -0`; grouped Bash children show only a `$` command preview. Grouped read children include
  their supplied offset and line limit. Final file counts use distinct
  tool-call target paths; Bash counts all command entries. Every group header
  and child is one ANSI-aware, width-truncated terminal row. The
  grouping contract is:
  - **First-member ownership:** The first call that creates a group
    anchors the group header (`renderOwner`) and keeps it for the
    rest of the group's lifetime. Ownership never migrates to later calls.
    New same-type calls append as child rows under the existing header.
  - **Single live group:** The renderer tracks one `currentGroup` at a
    time. When a groupable tool arrives whose `groupKey` differs from the
    current group's key, the current group is settled (label flips to
    past tense) and dropped as the active target. A fresh group is
    started at the new call's transcript position. This prevents a later
    same-type call from reopening a settled group and rendering above
    intervening blocks — groups are chronological. The old
    `discoveryGroup`/`workingGroup` dual-slot model was removed; there is
    no cross-group settling because settling + starting fresh is
    equivalent and simpler.
  - **Cross-turn grouping:** Discovery and action groups persist across
    consecutive turns. `beginTurn()`/`endTurn()` do not reset the active
    group, so sequential read/grep/find/ls, edit, write, or bash calls
    fold into a single `Exploring`/`Editing`/`Writing`/`Bashing` header
    until the agent writes visible user-facing text, the user sends a
    message, a non-groupable tool runs, or the group key changes.
    `agent_end` settles all groups so completed runs flip to
    `Explored`/`Edited`/`Written`/`Bashed`. The `settled` flag lives on
    `DiscoveryGroup`; `settleGroup`/`settleGroups`/`settleAllGroups` are
    the single setters. Settled groups can be reopened when a new same-key
    call arrives; the label flips back to present tense.
  - **Settled-group collapse in compact mode:** When a group is settled
    (all members complete AND the agent has moved on) AND thinking blocks
    are hidden, `formatGroup` collapses the block to the single header row
    (`• Explored N files`) — the `├`/`└` child rows and any per-member
    error row are suppressed. The collapse gate is
    `allCompleted && settled && isThinkingBlocksHidden()` in `formatGroup`
    (and the mirrored `group_collapsed` check in `renderResultInner` for
    the error/expanded-output rows) — never duplicate this condition in
    other plugins. The shared `isThinkingBlocksHidden()` flag in
    `pi-ember-ui/mode-colors.ts` is the SSOT, mirrored from Pi's `Ctrl+T`
    toggle (`setHideThinkingBlock`). `Ctrl+T` (show thinking) triggers
    `rebuildChatFromMessages()`, which re-runs `renderCall` on every
    owner and reveals the child rows again with zero extra wiring.
    Running/live (unsettled) groups always show children with the live
    gradient header. Single-member groups take the standalone-row path
    and are unaffected. All four group types (Exploring/Editing/Writing/
    Bashing) collapse uniformly.
  - **Group-header gradient tick:** While a group is not settled, the
    owner's `invalidate` is subscribed to the shared gradient tick via
    `subscribeGradientTick`/`unsubscribeGradientTick` (exported from
    `pi-ember-ui/index.ts`, backed by the single 20 FPS clock in
    `gradient.ts`). This
    makes the group header gradient sweep at the same `GRADIENT_TICK_MS`
    cadence as the Thinking/Working widget. The sweep uses
    `renderLiveGradient(label, "exploringGroup")` or `"actionGroup"`
    (muted→text only, no accent color). The tick timer stays alive
    while any group subscriber is active even if thinking/working are
    inactive. Subscriptions
    are removed on settle and session reset. The subscription uses a stable
    callback identity with a mutable invalidate target so Pi rebuilds (which
    provide fresh invalidate closures) rebind the target without churning the
    subscriber Set.
  - **Owner-only invalidation:** Joining a group invalidates only the
    group owner (one invalidation), not all members. This eliminates
    duplicate-header flicker and extra blank lines. This invalidation
    only runs from `registerCall` for *new* calls (never during Pi
    rebuilds, which early-return for existing ids).
  - **Shared group visual handle:** The group's `callText` (`CompactGroupText`) is
    the single persistent visual for the group block. The owner re-binds
    it to its live component on every `renderCall`; members write into it
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
    `record.invalidate` back to dead components. The subagent renderer
    uses the same stable-callback pattern for gradient tick subscriptions:
    one `SubagentTickRecord` per `toolCallId` with a stable callback and a
    mutable `invalidateTarget` that is rebound on each render without
    churning the subscriber Set.
  - **Non-owner rendering:** Non-owner group members render an empty
    `Text` (zero vertical space) so only the owner hosts the visible
    group block.
- Bash failures render only the first error line as one ANSI-aware, width-truncated
  row; expanded output must not bypass this compact error boundary. Successful Bash
  output remains subject to the existing collapsed/expanded rendering rules.
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
  import from here. `renderer.ts` also exports `hasActiveGroups()` on
  `CompactRenderer` and imports `renderLiveGradient` from
  `pi-ember-ui/index.ts` to render a muted/text gradient sweep on the
  compact group header while any member is running or the
  group is not yet settled (reverting to plain
  bold final summaries when all complete and settled). The `isToolGroupActive`
  flag in `pi-ember-ui/mode-colors.ts` is driven from this plugin's
  lifecycle handlers via `hasActiveGroups()`.

### `pi-custom-agents`

- Owns `/coder`, `/architect`, `/doctor`, `/orchestrator`, and `/ui-doctor`.
- **Plain-text output directive:** The `OUTPUT_STYLE_DIRECTIVE` constant in
  `index.ts` is injected into every mode prompt (`plan`, `code`, `debug`,
  `orchestrate`) and mode transitions (`EXIT_TO_CODER`, `PLAN_IMPLEMENT_PROMPT`).
  Plan mode's output contract uses labeled lines (`Task:`, `Investigation:`,
  `Module N:`, `Acceptance Criteria:`, `Open Questions:`) instead of `##`/`###`
  markdown. Bundled subagent `.md` definitions (`coder.md`, `scout.md`) inline the
  same directive. `pi-ember-ui` Markdown rendering remains display-only and works
  on plain text.
- Owns the plan-review flow, questionnaire tool, mode cycling, and
  `/subagent-model`. Registers the mode-id → label resolver
  (`setModeLabelResolver`) so the `pi-ember-ui` footer can render the active
  mode label without duplicating the `MODES` map.
- **Questionnaire "None" option:** Every question rendered by the
  questionnaire tool automatically appends a user-only "None" option
  (value `__none__`, description "Specify the proper answer") that is not
  part of the tool schema or model-supplied options. Selecting it replaces
  the description with an inline multiline `Editor` (from `@earendil-works/pi-tui`)
  so the user can type a custom answer. Enter commits the typed text as the
  answer (`wasCustom: true`); Escape returns to the option list. The typed
  text flows to the model as the answer value/label.
- **Plan review:** Every completed plan turn, including turns where the model
  invoked and received a questionnaire answer, opens the canonical
  `showPlanReview()` questionnaire. The user can implement, copy, or use the
  automatic custom `None` option; typed None guidance refines the plan directly.
- **Output-limit auto-continue:** When the model hits the maximum output
  token limit (`stopReason === "length"`) in any mode, the extension
  silently sends a hidden `pi-agents-auto-continue` custom message
  (`display: false`) via `pi.sendMessage()` so the user never sees the error
  row or the recovery prompt. The suppression flag
  (`isPlanAutoContinuing`/`setPlanAutoContinuing`) lives in
  `pi-ember-ui/mode-colors.ts` (SSOT) and is set early in the `message_end`
  handler (before the TUI renders the error row) and cleared after the
  continue dispatch, on the `agent_settled` normal path, and on
  `session_shutdown`. The `pi-ember-ui` `AssistantMessageComponent` patch
  suppresses the length-error row when the flag is active (all modes, not
  only plan). A max-continue budget (`PLAN_AUTO_CONTINUE_MAX`, 5) prevents
  infinite loops; after the budget is exhausted the error surfaces normally.
  On `agent_settled` within the budget: a best-effort compact is attempted,
  then the hidden `pi-agents-auto-continue` message is always sent with the
  current `triggerTurn`. Compact is skipped when the branch tip is already
  `type === "compaction"` (Pi would throw "Already compacted"). Benign
  compact errors ("Already compacted", "Nothing to compact") never abort
  resume; non-benign compact errors still resume — continue is never gated
  on compact success. The compact `customInstructions`
  (`COMPACT_FOCUS_INSTRUCTIONS` SSOT in `auto-continue.ts`) steer the
  single session checkpoint to plain `Goal:`/`Done:`/`Left:`/`Files:`
  labeled lines (no markdown headers, no bold/italics). Pi injects that
  checkpoint into LLM context after compact(). The continue message is a
  short non-duplicating resume directive built by
  `build_auto_continue_content` (SSOT) — it does NOT re-paste the
  compaction summary; it tells the model to resume from `Left` and not
  redo `Done`. An optional plan draft excerpt (plan mode only) may be
  appended when not already in the compaction summary. Never duplicate
  the suppression flag, the resume logic, the compact focus instructions,
  or the continue-content builder in other plugins. Pure helpers SSOT:
  `plugins/pi-custom-agents/auto-continue.ts`.
- **Repeated tool-call guard:** `pi-custom-agents` tracks consecutive identical
  tool name/argument signatures across turns. After three repetitions it aborts
  the stream, notifies the user with the active model name, and uses the shared
  questionnaire UI with `End stream`, `Retry`, and the automatic custom `None`
  option. Retry injects the hidden `pi-agents-loop-retry` message instructing the
  model to back off and use a different tool; a custom None answer is injected
  as hidden guidance. Tracking resets at each agent run and session shutdown.
- Thinking blocks are shown/hidden through the built-in thinking-toggle
  keybinding, preserving Pi's native behavior.
- `/model` and `/resume` picking is owned by `pi-ember-ui/model-picker.ts`: it
  intercepts the editor `handleInput` / `submitValue` / keybindings, opens
  Pi's in-editor slash-argument autocomplete (chat-pill popup via
  `Editor.prototype.render` + autocomplete layout patch), and applies the
  choice on submit — same pattern for both, **without** `registerCommand`
  (registering a built-in name like `resume`/`model` conflicts and surfaces
  under Extension issues). `/model` calls `pi.setModel()` on exact
  `provider/id`; `/resume` (and `app.session.resume`) uses a captured
  `switchSession` from `ExtensionRunner.bindCommandContext` and session
  completions via `ctx.ui.addAutocompleteProvider`. Selection with Enter or
  Tab commits immediately; a slash command with an argument auto-submits,
  while bare `/model`/`/resume` Tab-picks advance to their argument picker.
  Directory completions ending in `/` or `"/` are skipped so path expansion
  can continue. Without `pi-ember-ui`, Pi's built-in overlay selectors still
  work. `/subagent-model` reuses `pickModelInEditor()` from the same module.
- **Slash-command exit render:** When the editor transitions out of a
  slash-command state (input no longer starts with `/` via Escape or
  backspace), `finalizeEditorInputAfter` primes Pi's viewport/high-water
  bookkeeping so the chatbox stays in place, then requests a normal
  differential render through the shared `pi-ember-ui` scheduler. It does not
  force Pi's full clear/redraw path or clear terminal scrollback. Pi's normal
  differential cleanup removes rows left below the collapsed chatbox. The
  `was_slash_command` flag is reset on `session_start` and `session_shutdown`.
  The check is O(1) (one `getText()` + string prefix test) and the render is
  throttled, so it never exceeds the per-frame budget.
- **Thinking-toggle scrollback-preserving snap:** When the user presses the
  thinking-blocks toggle (`app.thinking.toggle`, default `Ctrl+T`, user-
  remappable), the `pi-custom-agents` editor `handleInput` wrapper detects
  it via `getKeybindings().matches(data, "app.thinking.toggle")` before
  Pi's handler runs, then schedules `requestTuiRenderSnapToBottom()` on the
  next microtask after `original_handle_input` returns. Pi's
  `toggleThinkingBlockVisibility()` rebuilds the chat synchronously
  (`chatContainer.clear()` + `rebuildChatFromMessages()`); the rebuild
  collapses/expands settled compact-tool group child rows (see the
  Settled-group collapse bullet in the `pi-compact-tools` grouping
  contract), which changes the line count. Without the snap, Pi's
  differential `clearOnShrink` path can leave the viewport not pinned to
  the bottom (the "janked up" chatbox). `requestTuiRenderSnapToBottom()`
  (re-exported from `pi-ember-ui/layout.ts` `snap_tui_to_bottom`) clears
  only the visible screen (`\x1b[2J\x1b[H`, never `\x1b[3J`), resets
  `previousViewportTop`/`maxLinesRendered`/`previousLines`, and requests a
  normal render whose first-render path (`fullRender(false)`) re-anchors
  `previousViewportTop` to the bottom — pinning the chatbox without
  destroying terminal scrollback. The `queueMicrotask` ensures the snap
  fires after the synchronous rebuild but before Pi's next differential
  render tick, winning the race. The detection is O(1) (one keybinding
  match) and only schedules a render when the toggle actually fired, so it
  never exceeds the per-frame budget. **Never use `requestTuiRender(true)`
  or `tui.requestRender(true)` for this or any snap** — it emits `\x1b[3J`
  and nukes scrollback.
- **Group-settle collapse scrollback-preserving snap:** The same jank also
  happens when a compact-tool group auto-settles during the agent run
  (flips from `Exploring` to `Explored` and collapses its child rows on
  its own, with no user input). `CompactRenderer.scheduleGroupInvalidation()`
  (`pi-compact-tools/renderer.ts`) detects the collapse condition
  (`group.settled && all members completed && isThinkingBlocksHidden()`)
  before scheduling the owner invalidation, and when it holds, calls
  `requestTuiRenderSnapToBottom()` alongside the owner invalidate on the
  same microtask. This is the primary snap — it fires on every auto-settle
  during a run. `requestTuiRenderSnapToBottom()` (re-exported from
  `pi-ember-ui/layout.ts` `snap_tui_to_bottom`) clears only the visible
  screen (`\x1b[2J\x1b[H`, never `\x1b[3J`), resets Pi's differential
  bookkeeping, and requests a normal render whose first-render path pins
  the chatbox to the bottom without destroying terminal scrollback.
  Non-collapse invalidations (live gradient tick, mid-run bullet pulse,
  appending a new member) stay differential so the TUI stays smooth while
  a group is active. The `will_collapse` check is O(n) over group members
  (small n) and only runs once per settle, never from a render closure,
  so it never exceeds the per-frame budget. **Never use
  `requestTuiRender(true)` for this snap** — it emits `\x1b[3J` and nukes
  scrollback.
- **Shell mode:** Pressing `!` on empty input enters shell mode (the `!` is
  eaten so it never appears in the editor). The `interceptShellInput` function
  lives in `pi-ember-ui/shell-mode.ts` (SSOT) and is called from the
  `pi-custom-agents` editor `handleInput` wrapper. `!` detection (`is_bang_key`)
  uses the full public pi-tui key API — the same decoders Pi's `Editor.handleInput`
  uses — so it is terminal-agnostic and DRY with no hardcoded CSI sequences:
  `isKeyRelease` (ignore key-release events), `decodeKittyPrintable` (Kitty
  CSI-u shifted-codepoint / base-key-with-alt-keys), `matchesKey(data, "!" | "shift+!")`,
  and `parseKey(data) === "!" | "shift+!"` (covers xterm modifyOtherKeys, the
  Ghostty/tmux fallback when Kitty protocol is off). Never duplicate the
  terminal-encoding logic — use these public exports. Escape
  exits and clears the editor; backspace on empty exits. Enter prepends `!`
  to the editor text and returns `false` (falls through to Pi's normal
  `submitValue` → `onSubmit`), so Pi's built-in bash handler
  (`text.startsWith("!")` in `interactive-mode.js`) runs the command through
  the standard bash pipeline. Enter on empty command exits shell mode without
  submitting. The `isShellMode`/`setShellMode` flag lives in
  `pi-ember-ui/mode-colors.ts` (SSOT, stored on `globalThis` via
  `Symbol.for("pi-ember-ui:shell-mode")` so it survives jiti module
  duplication); the footer reads it to display
  "shell", and the editor border uses `MUTED_COLOR` while active.
- Resolves bundled definitions from `import.meta.url`; never use an absolute user
  home path or a Windows-only source path.
- Contains the vendored subagent implementation and bundled `.md` agent definitions.
- Agent requests resolve through the single `subagent/extensions/agents.ts`
  `resolveAgent()` helper; names are case-insensitive and surrounding whitespace
  is ignored, while the resolved frontmatter name is used for display and threads.
- **Subagent rendering:** The `subagent` tool uses `renderShell: "self"` and
  renders a compact, Exploring-style grouped layout. Running agent names use
  the same gradient sweep as the Thinking header via
  `renderLiveGradient(agentName, "subagent")`; completed agents use green
  bullets and failed agents use red bullets. Parallel/chain mode shows a
  `Subagents` header + `└ agent` children with the same status treatment. No
  `⏳`, `[scope]`, or `parallel (N tasks)` labels. Chain mode only shows
  running + completed steps (pending steps hidden until they start).
  The completed/failed bullet logic reuses `statusBulletColor` from
  `pi-compact-tools/renderer.ts` — never duplicate it. Failed rows append
  the real failure reason inline next to the agent name in `theme.fg("error", …)`
  (single ANSI-aware, width-truncated row); the reason is resolved once by
  `resolve_failure_message` in `runner.ts` (SSOT) from the non-generic
  `errorMessage`, the last assistant message's non-generic `errorMessage`,
  `stderr`, or the last assistant text output. The runner's post-run
  finalization only rewrites the message on actual failures
  (`isFailedResult`); a successful stop with no `errorMessage` is never
  force-marked failed. Timeout and parent-abort keep their specialized
  strings. Never duplicate failure-message resolution or the generic-abort
  guard in other plugins. The subagent
  renderer no longer uses `PulseManager`; it subscribes to the shared
  gradient clock via `subscribeGradientTick`/`unsubscribeGradientTick`
  with a stable per-`toolCallId` callback record (see Rebuild-safe
  invalidate rebind above). The runner owns completion through
  `session.prompt()` and disposes
  only after that promise settles; never race `agent_end` against disposal.
  The subagent runs **in-process** on the main thread — not in a
  `worker_thread`. The runner accepts the parent's extension-facing
  `ModelRegistry` and crosses to its canonical `ModelRuntime` exactly once in
  `runner.ts`; child sessions receive that same runtime so every registered
  provider, credential source, header, runtime override, and custom
  `models.json` entry is available without copying auth or re-registering
  providers. Never recreate child auth storage in `index.ts` or `service.ts`.
  `session.prompt()` is async and does not block the TUI
  render loop. The empty resource loader uses `createExtensionRuntime()`
  (from `@earendil-works/pi-coding-agent`) so the `ExtensionRuntime` shape
  (`pendingProviderRegistrations`, `flagValues`, `assertActive`, ...) is
  valid for `createAgentSession`'s `ExtensionRunner.bindCore()`. Never
  hardcode model or provider names in the subagent runner — resolve the
  model from the parent context and let the inherited registry provide
  the API provider.
  All agent rows (running, completed, failed) and the `Subagents` header
  are transparent — no `subagentBg` background. Completed/failed agent
  names render in plain text color (`theme.fg("text", …)`, not the live
  mode accent) so finished subagents don't flash the active mode color.
  The expanded view (Ctrl+O) is likewise transparent — each terminal
  agent's detailed output is a plain `Container`, no `subagentBg` Box,
  no aggregate outer box.
  The nested latest-tool-call preview row under a running subagent uses
  `SubagentToolText` (a `Component` defined in `render.ts`) — not pi-tui's
  wrapping `Text`. `SubagentToolText` truncates to half the viewport width
  (`TOOL_ROW_WIDTH_FRACTION` = 0.5) with an ANSI-aware ellipsis via
  `truncateToWidth` from `@earendil-works/pi-tui`, so a long bash command
  never spans more than one terminal row. This follows the `CompactGroupText`
  pattern from `pi-compact-tools/renderer.ts` (truncate, don't wrap) but at
  half width to keep the nested preview visually compact. Never use plain
  `Text` for the subagent tool row — it wraps long content across multiple
  rows. `truncateToWidth` is the SSOT lever for ANSI-aware truncation; the
  `TOOL_ROW_WIDTH_FRACTION` constant is the single source for the half-width
  threshold.
- Keep read-only modes read-only through their active-tool allowlists.
- Owns per-mode model memory. The persisted `pi-ember-stack.json` state is the
  SSOT for the active `mode` and the `modeModels` map
  (`Partial<Record<modeId, { provider, modelId }>>`). Each mode remembers its own
  last user-selected model; unbound modes have no entry and keep the live model on
  switch. The legacy top-level `model` field is migrated once into
  `modeModels[persistedMode || "code"]` and deleted on write, so `modeModels` is
  the sole authority — never write a parallel global `model`.
- Binds a model to the active mode only on explicit user picks: `model_select`
  events whose `source` is `"set"` (`/model`) or `"cycle"` (`Ctrl+P`). Restore
  and unknown sources are ignored, and programmatic mode-switch `setModel` is
  suppressed via the `applying_mode_model` flag so it never creates a false
  binding for a previously unbound mode. `session_shutdown` snapshots the active
  mode and the current `modeModels` only — it never binds the live model onto the
  current mode.
- Mode switches and `session_start` restore a mode's bound model when present and
  auth-configured (`modelRegistry.find` + `hasConfiguredAuth`); missing or
  unauthenticated bindings leave the live model unchanged (fail soft, no throw).
  A `mode_apply_generation` counter aborts stale async restores when a newer
  switch starts. Pi core still writes the selected model to `settings.json`
  (`defaultProvider`/`defaultModel`) and the session (`model_change` entry) on
  every `/model`, `Ctrl+P`, and `pi.setModel()`; `pi-ember-stack.json` is the
  per-mode memory on top of that.

### `devin-auth`

- Owns the Devin provider, OAuth flow, model catalog, and streaming transport.
- Tool-call argument streaming uses `parseStreamingJson` (from
  `@earendil-works/pi-ai`) on every `tool_call_args` delta so partial JSON
  is parsed incrementally — `block.arguments` is updated on each delta,
  not held at `{}` until the full JSON arrives. This lets compact tool rows
  show the file path and live `+N / -N` edit stats in real time as the
  model streams `oldText`/`newText`, before the tool call completes.
  `closeToolCall` uses the same parser for the final parse. Never revert
  to `JSON.parse` on partial JSON — it throws and leaves arguments empty
  until the full delta arrives.
- Primes the live model catalog during the awaited factory load (reading the
  credential via Pi's one-off `readStoredCredential`) so devin models exist before
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

### `pi-cursor-auth`

- Owns the `cursor` provider backed exclusively by the official Cursor Agent
  CLI's browser-authenticated subscription session. It does not use Cursor SDK
  API keys and does not fall back to the ambiguous `agent` executable name.
  `CURSOR_AGENT_EXECUTABLE` is the explicit executable override. Known install
  paths include `~/.local/bin/cursor-agent` (official installer),
  `~/.cursor-agent/cursor-agent`, `/opt/homebrew/bin/cursor-agent`, and
  `/usr/local/bin/cursor-agent`.
- Factory load registers the provider with an empty model catalog first, then
  attempts live discovery without auto-installing. A missing or unauthenticated
  CLI must not throw during extension load — that would take down the whole
  `pi-ember-stack`. `/login cursor`, streaming, and `/cursor-refresh-models`
  call `ensure_cursor_agent_executable()` which installs the official CLI when
  missing (macOS: Cursor.app `cursor agent` helper when present; otherwise
  `https://cursor.com/install` / Windows PowerShell installer), then fills the
  catalog.
- `/login cursor` delegates browser authentication to `cursor-agent login`.
  Cursor remains the credential authority; Pi stores only a non-secret auth
  marker. `/cursor-status`, `/cursor-refresh-models`, and `/cursor-logout` own
  diagnostics, live model refresh, and coordinated logout.
- The provider serializes Pi's existing system prompt, ordered messages, and
  active tool schemas into one neutral CLI request envelope. Never inject a
  Cursor/Composer persona, replace Pi's system prompt, add role-play text, or
  import the OpenCode HTTP proxy/prompt builder.
- Pi owns the tool loop. Cursor `stream-json` tool events are accepted only
  when they resolve to a tool in `context.tools`; accepted events become native
  Pi tool calls, while unknown or malformed tools terminate the request with an
  error. Keep native argument repair in `src/context.ts` as its SSOT.
- **Cursor-style tool name advertising:** The provider advertises Cursor-style
  tool names (`Read`, `Write`, `Edit`, `Shell`, `LS`, `Grep`, `Glob`) and
  Cursor-style argument names (`file_path`, `old_string`, `new_string`,
  `include`, `glob`) in the serialized prompt so the Cursor-trained model
  calls tools it recognizes. The `PI_TO_CURSOR_TOOL_NAME` map and
  `PI_TO_CURSOR_ARG_NAMES` remap table in `src/context.ts` are the single
  sources for the forward (Pi→Cursor) schema translation. The existing
  `TOOL_ALIASES` + `normalize_tool_arguments` handle the reverse
  (Cursor→Pi) mapping when the model responds. Never duplicate these
  maps in other files. Cursor wraps Model Context Protocol server tool
  calls in an `mcpToolCall` envelope whose real tool name lives at
  `args.name`/`args.tool_name` and whose real arguments live at
  `args.args`; `CursorEventConsumer.parse_tool_call` in `src/stream.ts`
  is the single place that unwraps this envelope before
  `resolve_pi_tool_name` runs, so MCP-routed tool calls resolve through
  Pi's normal registry instead of failing on the `mcpToolCall` wrapper
  name.
- Each provider turn uses a fresh CLI process so Cursor-side conversation state
  cannot diverge from Pi sessions, compaction, forks, or tool results. Abort and
  `session_shutdown` terminate all owned child processes.
- The provider advertises text and image input. Image content is passed through
  as base64 data URLs in the serialized request.
- Integration patterns are informed by `Nomadcxx/opencode-cursor`
  (BSD-3-Clause, see `plugins/pi-cursor-auth/LICENSE`), with attribution and
  provenance retained.

### `pi-ember-dcp`

- Owns dynamic context pruning for outbound LLM context and the `/dcp` command
  surface (`context`, `stats`, `sweep`, `manual`, `decompress`, `recompress`,
  `help`).
- Adapted from `@davecodes/pi-dcp` 0.2.0 by Davidcreador
  (AGPL-3.0-or-later; license retained in `plugins/pi-ember-dcp/LICENSE`).
  Upstream: https://github.com/Davidcreador/pi-dcp.
- **Outbound-only pruning:** A `context` handler runs the prune pipeline
  (deduplication, errored-input purge, stored compressions) immediately before
  each LLM call and returns a freshly built message array. Message objects share
  identity with persisted session entries and must not be mutated in place;
  session history on disk is never rewritten. Pipeline exceptions pass the
  original messages through unchanged.
- **Protected tools:** Always-protected tool names live once in
  `ALWAYS_PROTECTED_TOOLS` (`compress`, `write`, `edit`, `todo`, `task`,
  `skill`) — never hardcode a second membership set. User config may extend
  protection lists; it cannot remove the always-protected set.
- **`compress` tool:** Registers message-mode (`toolCallIds[]`) or range-mode
  (`start`/`end`) based on config. Permission `deny` skips registration.
  Compressions are stored in session state and reapplied on later context
  builds; they do not rewrite the transcript.
- **Config/state SSOT:** User config and runtime state live under `~/.pi-dcp/`
  (global `config.json`, prompts, session files) with optional project override
  at `<cwd>/.pi/dcp.json`. Defaults and load/merge live in `lib/config.ts` —
  never duplicate thresholds or paths elsewhere. Config `enabled: false` skips
  all wiring at factory time.
- **Lifecycle:** Session-bound state is restored on `session_start`, saved on
  `agent_end`/`session_shutdown`, and cleared on shutdown so jiti-cached
  modules cannot leak session IDs. Runtime `/dcp manual` is not persisted;
  `session_start` reseeds `manualMode` from live config so toggles cannot
  leak across `/new`/`/resume`/`/fork`. `session_compact` resets ID-based
  tracking while preserving user-requested compressions. Turn index and
  errored tool observations update from `turn_start`/`tool_result` only —
  never from a render path.
- **Bundled skill:** `plugins/pi-ember-dcp/skills/pi-dcp/` is registered via
  `resources_discover` (`skillPaths`) from the plugin entry — same pattern as
  `pi-ember-webtools` librarian. Skill text must match current commands/schema
  and retain upstream AGPL attribution.
- Does not own compact tool rendering, modes, providers, or web tools.

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

### `pi-ember-webtools`

- Ember-owned web tools, vendored from `pi-web-access` by Nico Bailon (MIT
  License, see `plugins/pi-ember-webtools/LICENSE`). Original source:
  https://github.com/nicobailon/pi-web-access
- Provides `web_search`, `fetch_content`, and `get_search_content` tools,
  plus `/websearch`, `/curator`, `/google-account`, and `/search` commands.
- Supports multiple search providers: OpenAI, Brave, Parallel, Tavily, Exa,
  Perplexity, and Gemini.
- The bundled `librarian` skill lives in `plugins/pi-ember-webtools/skills/` and
  is registered via `resources_discover` from the extension wrapper.
- The extension wrapper (`extensions/index.ts`) dynamically imports the
  vendored `index.ts` so the vendored source — which has type drift against
  pi 0.80 — is not pulled into our strict `tsc` compilation. The vendored
  `.ts` files are excluded from `tsconfig.json` and `biome.json` until they
  are brought into compliance. The runtime import works correctly via jiti.
- The vendored tests (`test/*.test.mjs`) use `node:test`, not `bun:test`, so
  they are excluded from the bun test gate in `t.gate.sh`.
- Runtime dependencies (`@mozilla/readability`, `linkedom`, `p-limit`,
  `turndown`, `unpdf`) are declared in the root `package.json`.
- When customizing vendored files, bring them into compliance with our
  TypeScript strict mode and Biome lint rules, then remove them from the
  `tsconfig.json` and `biome.json` exclude lists.
- **Curator page accent propagation:** The curator HTML page
  (`curator-page.ts`) derives its CSS accent variables (`--accent`,
  `--accent-hover`, `--accent-muted`, `--accent-subtle`, `--bg`,
  `--btn-primary-fg`, etc.) from the active mode color and `PAGE_BG`
  via `buildAccentVars()`. The accent color and page bg are passed from
  `index.ts` through `startCuratorServer` → `generateCuratorPage` at
  runtime, sourced from `getActiveModeColor()` and `PAGE_BG` in
  `mode-colors.ts`. Never hardcode hex accent or page-bg values in the
  curator CSS — always flow them through the SSOT accent pipeline.

## Non-Negotiable Code Rules

- Use TypeScript ESM and strict typechecking. Run `./t.gate.sh` after source
  changes — it runs Biome lint, `tsc --noEmit`, and Bun tests in one pass.
- Use `snake_case` for local functions and variables where the surrounding Pi API
  permits; use `PascalCase` for classes and `UPPER_CASE` for constants.
- Prefer explicit types and narrow interfaces. Minimize `any`; use it only where Pi's
  dynamic extension API makes it unavoidable.
- Keep functions focused and avoid duplicated constants, tool definitions, renderers,
  or parallel configuration sources.
- **Plain-text output convention:** Mode system prompts in `pi-custom-agents/index.ts`
  and bundled subagent `.md` definitions (`plugins/pi-custom-agents/subagent/agents/`)
  must direct the model to reply in plain dense text. No markdown headers (`#`, `##`,
  `###`), no `**bold**` / `*italics*`, no decorative bulleted lists. Use short labeled
  lines (`Label: value`) or compact `key: value` pairs. Code fences are reserved for
  multi-line code blocks. The `OUTPUT_STYLE_DIRECTIVE` constant in
  `plugins/pi-custom-agents/index.ts` is the SSOT for the directive; subagent `.md`
  files inline it since their bodies are standalone system prompts. Plan mode uses a
  labeled-line contract (`Task:`, `Investigation:`, `Module N:`, `Acceptance Criteria:`,
  `Open Questions:`) instead of `##`/`###` headers.
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