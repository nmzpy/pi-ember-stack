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
  - The plan-auto-continue flag (`isPlanAutoContinuing`/
    `setPlanAutoContinuing`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the output-limit suppression logic that sets it.
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
  The editor border is a **chat pill**: 2-column inset on all sides, rounded
  corners (`╭╮╰╯`), vertical pipes (`│`) on interior lines that grow with the
  editor height, and `TEXT_COLOR` (not accent) for all border glyphs. The
  editor content has 1-col inner padding (`INNER_PAD = 1`) on each side
  between the text and the vertical pipe borders. The `innerWidth` passed to
  Pi's original render subtracts `INSET * 2 + 2 + INNER_PAD * 2` from the
  terminal width. Top/bottom border dashes span `innerWidth + INNER_PAD * 2`.
  When the agent is in Working state (`workingActive`, from `agent_start` to
  `agent_end`), all editor border lines (top corners, vertical pipes, bottom
  corners) use `MUTED_COLOR` instead of `TEXT_COLOR`, giving the chatbox a
  dimmed appearance while the agent is running. Shell mode also uses
  `MUTED_COLOR`. The border color logic is
  `(isShellMode() || workingActive) ? MUTED_COLOR : TEXT_COLOR`. In
  slash-command mode, the middle border line is rendered as a dim inset
  horizontal rule (`──` repeated at 0.1875 opacity, inset 1 col from the
  inner content area) with no inner junction or segment glyph. The previous
  slash-mode bottom border dimming is removed. Pi's native TUI render path is
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
  RGB-space blend (muted 10% tail → dim 40% → accent peak) with a
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
- **Thinking Widget & Tool Group Precedence:** The Thinking/Working gradient
  label is rendered in a `setWidget("ember-thinking", …)` row directly above the
  editor (default `aboveEditor` placement; `CHATBOX_LEADING_ROWS` in `layout.ts`
  is 1 blank row above the label when visible, or above the chatbox when hidden;
  the label is flush to the editor), NOT
  inside the editor top border. The widget row has a 3-column inset on left and
  right. The widget render closure is O(1): it reads `thinkingActive` and
  `workingActive` and remains visible while compact groups are active, so the
  chatbox state is never hidden by an `Exploring`/`Editing`/`Writing`/`Bashing`
  transcript group. Group headers still carry their own muted/text gradient
  sweep via `renderLiveGradient(label, "exploringGroup")` or
  `"workingGroup"` (no accent color — just muted→text). When the group settles
  (visible text, thinking text, a non-group or different-group tool, a user
  message, or `turn_end`), the header reverts to plain bold final summary.
  The
  `isToolGroupActive`/`setToolGroupActive` flag lives in
  `pi-ember-ui/mode-colors.ts` (SSOT), written from `pi-compact-tools` lifecycle
  handlers (`tool_call`, `tool_execution_end`, `turn_end`, `session_start`) via
  `CompactRenderer.hasActiveGroups()` — never from a render closure. The
  widget, the thinking tick timer, and the group tick subscriptions are
  cleared on `session_shutdown`.
- **Subagent Background Token:** The `subagentBg` theme token (defined once in
  `mode-colors.ts` `buildThemeBgColors` and seeded in `ember.json`) is the
  single source for the subagent row background — userMessage color at 10% less
  opacity. Never inline a hex value for subagent backgrounds. The background
  is applied per completed/failed row only; running rows and the `Subagents`
  header remain transparent.
- **Custom Message Background Token:** The `customMessageBg` theme token
  (defined in `buildThemeBgColors`) is accent-derived — the same value as
  `userMessageBg` (accent at 10% opacity over `PAGE_BG`). This covers
  compaction messages (`CompactionSummaryMessageComponent`) and custom
  messages. Never hardcode a separate hex value for `customMessageBg`; it
  references the same `userMsgBg` SSOT value.
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
    ├── plugins/pi-cursor-auth/
    │   └── Cursor subscription auth, model discovery, and Pi-native streaming
    ├── plugins/xai-auth/
    │   └── xAI (Grok) OAuth provider, catalog, streaming, custom tools, CLI shims
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
persisted mode/model state (owned by `pi-custom-agents/index.ts`). Both writers
use read-merge-write so neither clobbers the other's fields. There is no
project-local `ember-stack.json` — the plugin list is global, not per-project.
The package entrypoint is declared in `package.json` through the `pi.extensions`
field. Keep that mechanism aligned with the actual plugin folders.

## Plugin Boundaries

### `pi-compact-tools`

- Owns compact rendering for native coding tools.
- Every standalone tool-call row uses the compact bullet prefix: `• `.
- Edit calls show `+N / -N` inline on the same row as the filename.
- Consecutive discovery calls (`read`, `grep`, `find`, `ls`, and bash
  `grep` invocations) fold into one inset `Exploring`/`Explored N files` group
  with compact, bullet-free child rows; only the group header carries the
  bullet. Bash grep calls display as "Search" and join the discovery
  group. Consecutive `edit`, `write`, and non-grep `bash` calls form separate
  `Editing`/`Edited N files`, `Writing`/`Written N files`, and
  `Bashing`/`Bashed N commands` groups. Grouped edit children show only their
  path plus `+N / -N`; grouped write children show only their path; grouped
  Bash children show only a `$` command preview. Grouped read children include
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
  - **Per-turn grouping:** Calls group within a single turn. `beginTurn()`
    clears the previous grouping state, and `endTurn()` settles the group so
    its header immediately becomes a past-tense summary. A later same-type
    call starts a fresh group at its own transcript position rather than
    reopening the old block. The `settled` flag lives on `DiscoveryGroup`;
    `settleGroup`/`settleGroups` are the single setters. Settled groups are
    never reopened.
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
- Owns the plan-review flow, questionnaire tool, footer, mode cycling, and
  `/subagent-model`.
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
- **Plan-mode output-limit auto-continue:** When the model hits the maximum
  output token limit (`stopReason === "length"`) while generating a plan in
  plan mode, the extension silently sends a hidden `"continue"` custom
  message (`pi-agents-plan-continue`, `display: false`) via `pi.sendMessage()`
  so the user never sees the error row or the recovery prompt. The
  suppression flag (`isPlanAutoContinuing`/`setPlanAutoContinuing`) lives in
  `pi-ember-ui/mode-colors.ts` (SSOT) and is set in the `message_end` handler
  (before the TUI renders the error row) and cleared in `agent_settled` /
  `session_shutdown`. The `pi-ember-ui` `AssistantMessageComponent` patch
  suppresses the length-error row when the flag is active and the active mode
  is `plan`. A max-continue budget (`PLAN_AUTO_CONTINUE_MAX`, 5) prevents
  infinite loops; after the budget is exhausted the error surfaces normally.
  Never duplicate the suppression flag or the auto-continue logic in other
  plugins.
- **Repeated tool-call guard:** `pi-custom-agents` tracks consecutive identical
  tool name/argument signatures across turns. After three repetitions it aborts
  the stream, notifies the user with the active model name, and uses the shared
  questionnaire UI with `End stream`, `Retry`, and the automatic custom `None`
  option. Retry injects the hidden `pi-agents-loop-retry` message instructing the
  model to back off and use a different tool; a custom None answer is injected
  as hidden guidance. Tracking resets at each agent run and session shutdown.
- The built-in thinking-toggle and tree `Shift+T` keybindings are intentionally
  overridden to empty bindings, so thinking blocks cannot be hidden or shown and
  `Shift+T` is unbound.
- `/model` and `/resume` picking is owned by `pi-ember-ui/model-picker.ts`: it
  intercepts the editor `handleInput` / `submitValue` / keybindings, opens
  Pi's in-editor slash-argument autocomplete (chat-pill popup via
  `Editor.prototype.render` + autocomplete layout patch), and applies the
  choice on submit — same pattern for both, **without** `registerCommand`
  (registering a built-in name like `resume`/`model` conflicts and surfaces
  under Extension issues). `/model` calls `pi.setModel()` on exact
  `provider/id`; `/resume` (and `app.session.resume`) uses a captured
  `switchSession` from `ExtensionRunner.bindCommandContext` and session
  completions via `ctx.ui.addAutocompleteProvider`. Without `pi-ember-ui`,
  Pi's built-in overlay selectors still work. `/subagent-model` reuses
  `pickModelInEditor()` from the same module.
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
- **Shell mode:** Pressing `!` on empty input enters shell mode (the `!` is
  eaten so it never appears in the editor). The `interceptShellInput` function
  lives in `pi-ember-ui/shell-mode.ts` (SSOT) and is called from the
  `pi-custom-agents` editor `handleInput` wrapper. Escape exits and clears the
  editor; backspace on empty exits. Enter prepends `!` to the editor text and
  returns `false` (falls through to Pi's normal `submitValue` → `onSubmit`),
  so Pi's built-in bash handler (`text.startsWith("!")` in
  `interactive-mode.js`) runs the command through the standard bash pipeline.
  Enter on empty command exits shell mode without submitting. The
  `isShellMode`/`setShellMode` flag lives in `pi-ember-ui/mode-colors.ts`
  (SSOT); the footer reads it to display "shell", and the editor border uses
  `MUTED_COLOR` while active.
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
  `pi-compact-tools/renderer.ts` — never duplicate it. The subagent
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
  Running rows and the `Subagents` header remain transparent; only
  completed/failed rows receive a full-width `subagentBg` `Box`
  background. The expanded view (Ctrl+O) wraps each terminal agent's
  detailed output in its own independent `subagentBg` Box — no aggregate
  outer box.
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
- Does **not** persist or restore the active model. Pi core already writes the
  selected model to `settings.json` (`defaultProvider`/`defaultModel`) and the
  session (`model_change` entry) on every `/model`, `Ctrl+P`, and `pi.setModel()`.
  The persisted `pi-ember-stack.json` state is mode-only.

### `devin-auth`

- Owns the Devin provider, OAuth flow, model catalog, and streaming transport.
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
  `CURSOR_AGENT_EXECUTABLE` is the explicit executable override.
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
  maps in other files.
- Each provider turn uses a fresh CLI process so Cursor-side conversation state
  cannot diverge from Pi sessions, compaction, forks, or tool results. Abort and
  `session_shutdown` terminate all owned child processes.
- The provider advertises text input only. Images and image-bearing tool results
  fail explicitly rather than being silently omitted.
- Integration patterns are informed by `Nomadcxx/opencode-cursor`
  (BSD-3-Clause, see `plugins/pi-cursor-auth/LICENSE`), with attribution and
  provenance retained.

### `xai-auth`

- Owns the xAI (Grok) OAuth provider, model catalog, streaming transport,
  custom xAI tools, and Cursor/Grok CLI tool shims.
- Forked from [pi-xai-oauth](https://github.com/BlockedPath/pi-xai-oauth)
  (MIT License, see `plugins/xai-auth/LICENSE`). Original source attribution
  retained; adapted for the `pi-ember-stack` plugin architecture.
- Registers the `xai-auth` provider with a static model catalog (Grok 4.5,
  4.3, Build, Composer 2.5 Fast, 4.20 variants). Models are defined once in
  `src/models.ts` (SSOT) — never duplicate model definitions elsewhere.
- All OAuth constants (issuer URL, client ID, scopes, redirect port, refresh
  skew, API base URLs, CLI proxy URL, Grok client version) live in
  `src/constants.ts` — never hardcode these values in other files.
- OAuth login uses PKCE with a local callback server (`127.0.0.1:56121`) and
  manual-paste fallback for WSL/remote environments. Token refresh rotates
  automatically before expiry. Reuses `~/.grok/auth.json` from the official
  Grok CLI when present.
- Streaming delegates to pi's built-in OpenAI Responses transport
  (`openAIResponsesApi().streamSimple`) with xAI-specific payload rewriting
  (`rewriteXaiResponsesPayload`): system/developer text → top-level
  `instructions`, image-bearing `function_call_output` → text + replay,
  reasoning effort normalization, and `prompt_cache_key` routing. Grok Build
  and Composer route through `cli-chat-proxy.grok.com` with Grok CLI proxy
  headers; all other models hit `api.x.ai` directly.
- Custom xAI tools (`xai_generate_text`, `xai_web_search`, `xai_x_search`,
  `xai_multi_agent`, `xai_code_execution`, `xai_generate_image`,
  `xai_analyze_image`, `xai_critique`, `xai_deep_research`) use the xAI
  Responses API directly with OAuth credentials. Tool names are fixed —
  installing duplicate copies of this plugin causes registration conflicts.
- Cursor/Grok CLI tool shims (`Read`, `Write`, `StrReplace`, `Edit`, `Delete`,
  `LS`, `Grep`, `Glob`, `Shell`, `WebSearch`) are automatically enabled when
  a Grok CLI proxy model (`grok-build` or `grok-composer-2.5-fast`) is
  selected and disabled when switching back. The shims map Cursor-style
  argument names onto pi's built-in tools.
- Improvements adopted from `devin-auth`:
  - **AbortError guard**: `unhandledRejection` handler swallows
    `DOMException [AbortError]` rejections from cancelled agent runs.
    Non-abort rejections are re-emitted. Removed on `session_shutdown`.
  - **Session-replacement discipline**: `session_shutdown` clears
    module-level `_pi` and removes the rejection handler so jiti-cached
    modules don't survive across sessions with stale references.
  - **`/xai-status` command**: Quick auth diagnostics.
- Credentials, tokens, and provider secrets remain machine-local.
- Never commit `auth.json`, OAuth tokens, or generated credential files.

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
