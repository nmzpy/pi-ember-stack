# pi-ember-stack AGENTS.md

2026

## Scope

- `pi-ember-stack` is the single Ember-owned Pi package and repository.
- It is a cross-platform TypeScript package for Pi on Windows, macOS, and Linux.
- The Ember application lives in the separate `Ember` repository and consumes this
  package through its project-local `.pi/settings.json`.
- The user is the sole maintainer and decision-maker.

## Pi Architecture: Absolute Renderer Boundary

- **Never add an Ember renderer.** Pi's existing renderer, differential
  rendering state, terminal writer, cursor bookkeeping, viewport placement,
  overlay compositor, and render scheduler are authoritative. Pi is a large,
  mature codebase; Ember plugins integrate with that architecture rather than
  reimplementing any part of it.
- **Never replace or monkey-patch `TUI.doRender()` or `TUI.requestRender()`.**
  Never create a parallel render loop, render scheduler, frame pipeline,
  viewport painter, scrollback interceptor, or terminal compositor.
- **Never touch Pi's private render state.** Do not read or write
  `previousLines`, viewport offsets, cursor rows, Kitty image state, render
  timers, `renderRequested`, or equivalent differential bookkeeping. Do not
  call `tui.render()` as a substitute for Pi's render cycle.
- **Never write directly to the live terminal from a plugin UI path.** No
  `tui.terminal.write()`, ANSI row painting, cursor repositioning, clear-screen
  workaround, or in-place repaint loop. Pi alone writes terminal frames.
- **Integrate through Pi's public seams:** lifecycle events, the canonical
  `request_render()` intent, component invalidation, `setHeader`, `setFooter`,
  `setWidget`, `setEditorComponent`, and `ctx.ui.custom()` overlays. The
  `plugins/pi-ember-ui/render-intent.ts` module is the single native render
  request path. Feature code must import `request_render` directly; it must
  never invoke `.requestRender()` or call a TUI render method. The only
  `.requestRender()` expressions permitted outside that module are the
  binding-only callbacks in the excluded `pi-ember-ui/index.ts` bridge, which
  supply Pi's live callback to the intent slot and do not constitute a second
  render path. A plugin may intercept or wrap a specific component only when
  it preserves the native owner, delegates to the original behavior, returns
  width-safe rows, and does not request rendering from a render closure.
- **Overlays are overlays.** Quiz, picker, subagent, and transient UI belong in
  Pi's overlay/component architecture. They must not become a second TUI or
  transcript renderer. Structural changes update the component tree and issue
  one ordinary public render request; Pi owns shrink, cursor, viewport, and
  differential behavior.
- **Animation is component state, not terminal painting.** Shared clocks may
  update component data and request one normal Pi render per tick. Off-screen
  animation must be disabled or static. Cosmetic requirements never justify a
  private renderer or differential-state mutation.
- **Fail the gate if this boundary is violated.** Renderer-authority tests must
  guard against TUI render monkey patches, direct terminal writes, private
  differential-state mutation, manual `tui.render()` calls, and duplicate
  render schedulers.

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
  - Grouping keys (`WORK_GROUP_KEY` / `BROWSER_GROUP_KEY` / `groupKey`), the
    groupable tool sets (`GROUPABLE_TOOLS`), the browser-family predicate
    (`is_browser_tool_name`) and the lifecycle gate
    (`is_compact_groupable_tool`) are defined once in `renderer.ts` — never
    duplicate the membership check. Every native/groupable tool shares one
    work-bundle key (`__work__`); every `browser_*` tool shares the one
    `Browser` key (`__browser__`). Both groups keep their newest five child
    rows; older calls fold into the header until a hard boundary (visible
    answer text, visible thinking, user message, a different group key,
    `session_compact`, or a non-groupable tool) folds the group to
    header-only.
  - Compact bullet-color logic (`statusBulletColor`,
    `groupBulletColorFromFlags`) is defined once in
    `pi-compact-tools/renderer.ts` — never duplicate it in another plugin.
    There is no PulseManager or compact-tool pulse timer. Tool bullets never
    pulse: `statusBulletColor` is static `muted` while running, `success` when
    done, and `error` on failure; running state is shown by gradient child
    verbs (Searching, Reading, Running, …). Compact and subagent renderers
    subscribe to the one shared gradient clock (see Animation Compliance).
  - Terminal gradient rendering (Gaussian sweep, RGB interpolation, Chalk
    colorization, semantic presets, and the 20 FPS shared clock) lives once
    in `pi-ember-ui/gradient.ts` — never duplicate gradient math, animation
    timing, or color constants in other files.
  - Subagent Thinking suppression lives in
    `pi-ember-ui/mode-colors.ts` `isSubagentDelegationActive()` with one live
    tool-call-id set (`markSubagentDelegationStarted` /
    `markSubagentDelegationEnded`). `isLatestSubagentRunning` remains the
    editor-border/session-scan state, not a Thinking suppression input; never
    add a second activity counter, delegating set, or session scan.
  - The output-limit auto-continue flag (`isPlanAutoContinuing`/
    `setPlanAutoContinuing`) lives in `pi-ember-ui/mode-colors.ts` — never
    duplicate the output-limit suppression logic that sets it. The flag
    suppresses the length-error row during auto-continue recovery in all
    modes, not only plan mode.
  - The quiz-active flag (`isQuizActive`/
    `setQuizActive`) lives in `pi-ember-ui/mode-colors.ts` — never
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

- **Native render ownership:** Pi owns scrollback, line-count shrink, cursor
  placement, viewport anchoring, and differential output. Ember never adds a
  snap renderer or terminal workaround. When a component tree changes, call
  the public native render request and let Pi handle the resulting frame.
- **Render-intent SSOT:** `plugins/pi-ember-ui/render-intent.ts` owns the
  session-safe `request_render()` entry point and its live callback binding.
  Every explicit Ember-owned render request must import and call that
  function directly. Direct `.requestRender()` calls, `tui.render()`,
  `tui.invalidate()`, terminal writes, cursor/clear escapes, private TUI
  state, plugin-owned render timers, and parallel render schedulers are
  prohibited. The one shared gradient clock is the sole animation timer; it
  stages component state and emits through `request_render()` only. The
  excluded `pi-ember-ui/index.ts` contains only the binding bridge that hands
  Pi's callback to the intent slot; feature code must not copy that pattern.
  Component-local `invalidate()` methods remain valid Pi Component contract
  methods when they only invalidate their own component cache.
- **Token-First Theming:** All UI colors must flow through theme tokens (`theme.fg`,
  `theme.bg`) or the shared `mode-colors.ts` helpers. Never embed raw hex or ANSI
  escape sequences directly in renderer or component code. The live accent color is
  the single authority for mode-derived visuals. Dim chrome is the one fixed
  exception with its own SSOT: `DIM_CHROME_COLOR` in `mode-colors.ts` (DIM_COLOR
  at `DIM_CHROME_OPACITY` = 40% over `PAGE_BG`) is painted through
  `paint_tree_pipe()` for every tree pipe (`│`) and `chatboxBorderColor()` for
  the chatbox horizontal rules and editor border — one value, so rules, borders,
  and pipes read at exactly the same weight. Tree pipes deliberately do NOT use
  `theme.fg("dim")`: the dim token is the muted-label grey (#666666) and reads
  as bright as the tool-call header (#808080) beside it.
- **Compact Rendering Is Authoritative:** Tool call rows are single-line, bullet-led,
  and never dump raw content. Both standalone and grouped call rows use the
  `CompactGroupText` component (ANSI-aware `truncateToWidth` at the TUI's
  supplied available width) so a long bash command, file path, or result line
  never wraps to multiple rows — it ellipsizes to one row. Match counts, diff
  stats, and status labels append inline to the existing call row — never on a
  separate line below. Group headers (`Exploring`/`Explored`) summarize;
  child rows stay compact. Every tool row returns its `CompactGroupText`
  component directly from the render slot — no wrapping `Box(1, 0, …)` shell — so
  the bullet/pipe starts in column 0 with every other row and the line is never
  padded with leading or trailing spaces. Row padding belongs in the row text as
  an explicit indent (`  ` continuation), never as a container inset.
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
  full-width horizontal rules (`──`) on top and bottom at 50% opacity of
  `DIM_COLOR` over `PAGE_BG`, no side pipes, no rounded corners. The editor
  content has no base inner padding (`INNER_PAD = 0`; user-bash streaming adds
  one temporary column per side) plus a 2-col gutter on the left.
  The gutter shows a `> ` prompt glyph on the first editor body row and a
  `  ` (two-space) gutter on subsequent rows; the glyph stays `> ` in shell
  mode (the footer "shell" label is the mode indicator) and flips to `! `
  only while a user `!` bash command is actually running. The `innerWidth` passed to Pi's original
  render subtracts `INSET * 2 + 2 + INNER_PAD * 2` from the terminal width
  (the `+ 2` is the gutter, not pipe columns). Body rows render at exactly
  `innerWidth` (Pi pads every editor row to its content width), and the
  wrapper adds ONLY the 1-col prompt glyph on the first row or the 2-col
  gutter on continuation rows — never any extra side padding. Any added
  side columns overflow the reserved width and `truncateToWidth()` tacks a
  `...` onto every wrapped chatbox line (2026-08-09 regression: a
  `subsequentSidePad` made wrapped rows 123 wide at a 121-col terminal,
  truncating the end of every continuation line; removed). While the agent is running
  (`agentRunPending`, from `agent_start` to `agent_settled`) or in shell mode,
  the prompt glyph uses `MUTED_COLOR` instead of `TEXT_COLOR`, giving the
  chatbox a dimmed appearance while the agent is running. The middle separator
  and slash separator use the same 50%-opacity `DIM_COLOR` rule as the
  edge-to-edge top and bottom lines; `SLASH_MIDDLE_INSET = 0`, with no
  junction glyph. Pi's native TUI render path is
  left unpatched — content flows top-down and scrolls when it exceeds the
  terminal height. The `recompute_latest_subagent_running()` helper
  scans `sessionCtx.sessionManager` entries and writes the result to the
  shared `isLatestSubagentRunning()`/`setLatestSubagentRunning()` flag in
  `pi-ember-ui/mode-colors.ts`. It is called only from lifecycle and stale-
  blocker reconciliation handlers — never from the render path. Live
  subagent Thinking suppression uses only the matching tool-call-id set; the
  scan is editor-border state. Never duplicate either state source or call
  the scan from a render closure. The
  Thinking gradient label is NO LONGER rendered inside the editor border or
  above the chatbox — it lives inside the latest assistant message in the
  transcript (see Thinking/Summarizing status below). Pi owns the editor fake
  cursor, hardware cursor visibility, and cursor blink timing.
  The `Editor.prototype.render` override strips `\x1b[7m...\x1b[0m` from all
  rendered lines when `cursorVisible` is false, leaving the zero-width
  `CURSOR_MARKER` intact so IME positioning still works. The blink timer is
  started in `session_start` (TUI mode) and cleared in `session_shutdown`.
- **Per-Frame Render Budget:** No render closure (editor render, header render,
  footer render, tool renderCall/renderResult, or gradient subscriber) may call
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
  timer-driven by one deadline-based `setTimeout` clock at 20 FPS
  (`GRADIENT_TICK_MS` = 50) in `gradient.ts`. It computes phase from monotonic
  elapsed time (`performance.now()`), not incremental frame steps, so lag does
  not slow the sweep. Subscribers stage component state and mark the shared
  clock dirty; the clock dispatches one `request_render()` through
  `render-intent.ts` after a changed tick. No subscriber invokes Pi's public
  request method, writes terminal rows, mutates differential state, or creates
  a parallel renderer. When no animated component is visible, the clock stops
  completely and emits no periodic `request_render()` calls.
  **Binding a Thinking host (`bind_thinking_widget_host`) must not subscribe the
  clock** — only `sync_thinking_gradient_clock()` → `sync_thinking_status_tick()`
  may subscribe/unsubscribe. `render_thinking_status_lines` has a safety net
  that activates the gradient reason and subscribes the tick if the host
  resolves while the clock is stopped (race recovery — idempotent, O(1)). The
  external Thinking row (widget + in-message) reads its gradient text from a
  shared `CompactGroupText` cache in `thinking-status-tick.ts`; the 20 FPS tick
  callback (`dispatch_thinking_status_tick`) builds `leftPad +
  render_thinking_gradient_label() + elapsed + rightPad` via the bound
  `build_thinking_status_row_text` builder and stages it in the cache before
  invalidating the host, so Pi's `render()` only truncates the pre-baked ANSI
  string — the same pattern as the in-group `│ Thinking` lane writing into a
  group's `CompactGroupText`. The external host repaints at the shared 20 FPS
  clock cadence (`EXTERNAL_THINKING_RENDER_INTERVAL_MS` = `GRADIENT_TICK_MS` =
  50 ms), matching the in-group `│ Thinking` lane and compact group child
  verbs so standalone/widget/in-message Thinking animates as smoothly as the
  in-group lane. The tick skips `host.invalidate()` when the staged text is
  identical to the last frame (clock stopped / no phase change) so no redundant
  `request_render()` is queued. Trackpad scroll uses terminal scrollback; Ember
  must not intercept scroll input or repaint the live viewport while the user
  reads history. Do not re-anchor on slash/autocomplete exit or idle lifecycle
  events. **Sticky startup header across session replacement:** the ember
  startup logo header (`installStartupHeader`) is kept live across
  `/resume`/`/new`/`/fork`/`/reload` via `install_header_persistence_patch`
  (`pi-ember-ui/header-persistence.ts`, SSOT). Pi's `resetExtensionUI` restore
  of the built-in header at the top of the buffer would force a
  scrollback-clearing full redraw (`\x1b[2J` + `\x1b[3J` — jump-to-top +
  scroll lock); the patch skips that restore while the ember header is active
  and the `session_start` re-install renders byte-identical rows, so the
  top-of-buffer header never changes during a session switch. Never re-install
  a tall header at the top of the buffer on session lifecycle events — only the
  inherent transcript rebuild may redraw. Structural changes (show/hide
  Thinking, group settle/collapse,
  mode switch) update the component tree and use the same normal native
  request. Off-screen startup visuals are static. The
  sweep cycle is `GRADIENT_DURATION_MS` = 1600 ms. It uses an
  offscreen-to-offscreen Gaussian center (`compute_sweep_center`) with unified
  edge padding (`EDGE_PADDING` = `Math.ceil(3 * GRADIENT_SIGMA)` = 9 cells)
  for all presets, so the Gaussian fully exits before the phase wraps and
  short labels do not snap. There is no circular wrap. The accent palette is a
  3-stop RGB-space blend (DIM_COLOR base → 50% toward accent → accent peak)
  with a per-generation RGB cache. The thinking palette uses the same shape
  with TEXT_COLOR as its peak. Semantic presets (`thinking`, `working`,
  `exploringGroup`, `actionGroup`, `subagent`) reference the shared palettes;
  `renderLiveGradient(text, preset)` drives Thinking/Summarizing, running
  subagent labels, and compact child rows. The transient subagent status rows
  (`Delegating` pre-delegation wait and hidden-mode `Finishing`) use the
  `thinking` preset — the accent preset peaks at MUTED_COLOR and renders
  barely visible. The Pi logo is static because it
  can sit above the live viewport: a stable 2-stop vertical gradient with a
  box-drawing drop-shadow contour. Startup has no logo animation or logo timer;
  a static header is installed once per session and remains byte-stable across
  replacement through `header-persistence.ts`. `session_shutdown` is the
  safety floor. The subagent renderer subscribes to the shared gradient clock
  via `subscribe_gradient_tick`/`unsubscribe_gradient_tick` from `gradient.ts`.
  The clock dispatches a stable snapshot of subscribers each tick — callbacks
  added or removed during dispatch are not visited until the next tick,
  preventing same-tick re-addition loops.
- **Thinking/Summarizing Status & Tool Group Precedence:** The live
  gradient `Thinking` label uses a dual host via `resolve_thinking_status_host()`
  (mutually exclusive — never widget + in-message together): the in-message
  `ThinkingStatusComponent` under the latest assistant message owns the pre-tool
  wait directly below the user row once the assistant bubble exists; the
  above-editor `ember-thinking` widget owns post-tool inter-run gaps. Both
  external hosts are inset by `THINKING_STATUS_INSET_COLUMNS` = 1 column on
  each side (`build_thinking_status_row_text` SSOT); the in-group `│ Thinking`
  lane is owned by the compact renderer (tree-branch prefix) and does not use
  this inset. `thinking_status_terminal_layout` (SSOT) keeps both external
  hosts rendering `[blank][Thinking][blank]` in the same terminal rows so the
  widget → in-message switch never moves the label: the in-message host pads
  one blank above inside the transcript (the empty widget container's own
  spacer supplies the blank below), while the widget host relies on Pi's
  widget-container leading `Spacer(1)` for the blank above and pads one blank
  below instead — it never adds a second blank above, which would render the
  pre-tool header one row lower and visibly jump up when the assistant bubble
  mounts. There is
  no `Working` label. `installAssistantMessagePatch` creates a
  `ThinkingStatusComponent` per assistant message and binds it to the message's
  timestamp. A module-level `latestAssistantMessageTimestamp` is updated from
  `message_start`, `message_update`, and `message_end` (and from the patched
  `updateContent`) so only the most recent assistant message renders the
  in-message label. The render path is O(1): it reads `thinkingActive`,
  `agentRunPending`, `isThinkingBlocksHidden()`,
  `isQuizActive()`, `isToolGroupActive()`, and
  `isSubagentDelegationActive()`.
  It is suppressed when a quiz overlay is active, when a compact tool group
  has a **running** member (`isToolGroupActive()` — lingering completed
  children alone no longer suppress), when a delegated subagent tool call is
  active, when a visible thinking block is actively streaming (`thinkingActive`
  with `!isThinkingBlocksHidden()` — the transcript owns reasoning), or when
  in-group `│ Thinking` owns the slot (`isGroupThinkingChildActive()`). The
  `groupThinkingChildActive` flag is **O(1) counter-backed and globalThis-stored**
  (`Symbol.for("pi-ember-ui:group-thinking-child-active")`, same pattern as
  `isThinkingBlocksHidden`/`agentRunPending` — jiti module duplication across
  importer chains must never split the writer from the reader or the external
  header paints beside the in-group lane): `sync_compact_group_flags` sets it
  from `CompactRenderer.hasAnyGroupThinkingChild()`, which reads an O(1)
  `thinkingLaneCount` maintained by `setThinkingChild()` at every arm/clear
  site (any armed/painted lane across all renderer groups, including a painted
  lane that outlives the `currentGroup` pointer). The render path
  (`thinking_status_should_show()` / `resolve_thinking_status_host()` /
  `compact_thinking_lane_owns_status()`) ALSO queries the live renderer
  `hasAnyGroupThinkingChild()` directly BEFORE the synced flag — O(1), immune
  to stale flag syncs — so with blocks hidden a painted in-group lane
  unconditionally suppresses the external widget AND in-message host, never a
  duplicate Thinking row. The
  `Thinking` placeholder still appears in the pre-token wait and in-message
  pre-output wait while blocks are visible, until the model begins emitting
  visible text or a thinking stream. Nested
  subagent `│ Thinking` rows are separate (`render.ts`) and still paint while
  blocks are visible. Bare
  `text_start` and empty `text_delta` never suppress via
  `should_suppress_thinking_header_for_stream_event()`. The SSOT wait predicate `is_agent_thinking_wait()` in
  `mode-colors.ts` (requires `agentRunPending` or active thinking stream, and
  `userTurnCommitted` when not `agentRunPending` — so compact-and-continue
  sub-runs still qualify after `agent_settled` clears the user flag; no
  tool/subagent in flight) gates all Thinking hosts;
  `reconcile_thinking_wait_ui()` in `thinking-wait.ts` is the single arming
  SSOT — it optionally runs `clear_stale_thinking_wait_blockers()` (resets
  leaked `toolExecutionInFlight`, resyncs subagent flags from the session
  branch, clears stale in-group Thinking lane + header suppression) then arms
  either the settled compact group's in-group lane or the external in-message /
  above-editor host via `arm_pre_token_thinking_status()`.
  `clear_blockers` runs on visible user `message_start`, `session_compact`,
  and `compaction_end` transcript rebuild (`reconcile_thinking_after_transcript_rebuild()`).
  In-group `│ Thinking` is painted ONLY by a real thinking stream
  (`message_update` → `apply_assistant_stream_boundary` in
  `assistant-stream-boundary.ts`, SSOT → `noteHiddenThinking()`); the wait arm
  never paints it prematurely. During a post-tool wait with NO thinking stream,
  `arm_pre_token_thinking_status()` calls `renderer.holdToolLane()` instead
  (and `tool_execution_end` re-arms it while the agent is pending, covering the
  first-batch post-tool gap where no group existed at user-send): the group
  keeps its tool lane with the VISIBLE children of the current wave in their
  gradient `-ing` verbs (Reading/Searching/Finding/Listing/Running) while
  completed
  mutations snap to past tense (Edited/Wrote/Patched) — the lane appends after
  lingering tool rows without folding them, and only appears once the model is
  actually emitting reasoning. The hold applies in BOTH block-visibility modes
  (with blocks visible the transcript owns reasoning once it starts, but the
  pre-thinking wait still reads as ongoing work); `settleGroups` keeps the
  hold's 20 FPS gradient tick alive through `agent_end` so the `-ing` verbs
  keep animating until a thinking stream or `agent_settled` takes over. Active
  compact group child rows follow ONE branch rule (`format_compact_group_child_prefix`
  in `pi-compact-tools/renderer.ts` is its SSOT): every visible child row —
  running `-ing` verb, tool-lane hold, in-group Thinking lane, a completed row,
  and the group's terminal row — carries the bare `│` continuation with no
  connector-width trailing pad so its body sits flush against the pipe. The `└`
  corner and the `├` tee are never drawn anywhere in the tree (a settled `Ran`/
  `Read` row keeps exactly the same gutter as the wave that is still running).
  No horizontal `─` connector anywhere. The pipe is painted with
  `paint_tree_pipe()` from `pi-ember-ui/mode-colors.ts` — the shared dim chrome
  (`DIM_CHROME_COLOR`) that the chatbox horizontal rules and the editor border
  also use, never `theme.fg("dim")` (the dim token is the muted-label grey and
  reads as bright as the tool-call header beside the pipe). When the in-group
  `│ Thinking` lane arms,
  horizontal `─` connector anywhere. When the in-group `│ Thinking` lane arms,
  the prior tool child collapses (the lane replaces it instead of sitting
  beside it); earlier completed children, when present, stay as bare `│`
  continuations.
  `format_compact_group_child_prefix` in `pi-compact-tools/renderer.ts` is the
  one owner for both main and nested-subagent work-group prefixes. Inter-run planning
  `text_delta` holds the lane the same way (no fake Thinking).
  When the last subagent finishes (`tool_execution_end` for `subagent` with no
  remaining delegated subagent call), `reconcile_thinking_wait_ui()` runs so the
  parent-agent inter-run gap shows gradient `Thinking` before the model streams
  again — same post-tool feedback as other tools.
  The **pre-tool gap** (`is_pre_tool_thinking_gap()` — `agentRunPending` and
  no tool rows yet) shows gradient `Thinking` as send feedback when thinking
  blocks are hidden; when blocks are visible the transcript owns reasoning and
  the external header stays off. `assistantThinkingHostReady` is set on
  assistant `message_start` (and on `updateContent` only for current-turn
  assistants via `userTurnAnchorTimestamp`) so the in-message host can paint
  immediately without stale pre-compaction bubbles hijacking the slot.
  `session_compact` and `compaction_end` clear stale wait blockers and
  re-arm Thinking when the user turn or agent run is still active.
  `agent_start` sets
  `agentRunPending` and activates the thinking gradient so Thinking appears
  immediately before model tokens. External Thinking hosts use the same
  gradient-tick pattern as compact tool verbs: `refresh_thinking_status_text()`
  updates a shared `CompactGroupText` cache on each `subscribe_gradient_tick`
  callback; `dispatch_gradient_tick` issues one public render. The assistant
  message body is render-cached between ticks so markdown is not rebuilt at
  20 FPS. The `agentRunPending` flag (SSOT in
  `pi-ember-ui/mode-colors.ts` via `isAgentRunPending()`/`setAgentRunPending()`,
  stored on `globalThis` via `Symbol.for` so jiti module duplication cannot
  desync wait state — same pattern as `userTurnCommitted`,
  `userTurnAnchorTimestamp`, and `toolExecutionInFlight`;
  never duplicated) bridges the inter-run gap:
  `agent_end` fires between each low-level run, but Pi may auto-retry,
  auto-compact and retry, or continue with queued follow-ups — only
  `agent_settled` means Pi will not run again automatically.
  `agent_start` sets it true; `agent_settled` (and `session_shutdown`, the
  safety floor) clear it. While it is true the label shows `Thinking` and the
  editor border stays muted, so the header state is never lost during
  compaction/retry/follow-up gaps. **Post-tool / inter-run Thinking:** while
  tools are idle and the SSOT wait predicate holds with NO thinking stream, a
  settled work group HOLDS the tool lane — the visible children of the current
  wave keep their
  gradient `-ing` verbs (Reading/Searching/…) and edit/write snap to
  Edited/Wrote; the in-group `│ Thinking` lane is NOT painted (a premature lane
  would claim the slot while the model is not emitting reasoning). When a real
  thinking or inter-run planning stream arrives (blocks hidden),
  `noteThinking()`/`noteHiddenThinking()` paints the lane from the hold and
  suppresses the external widget. Without a
  work group, the in-message component or above-editor widget shows gradient
  `Thinking` during the wait.
  `resolve_thinking_status_host()` prefers in-message whenever
  `assistantThinkingHostReady`, not only during the pre-tool gap. Child rows
  COLLAPSE under the header: the newest five groupable tool calls keep their
  rows and every older one is absorbed into the header
  (`childAbsorbBefore = records.length - MAX_VISIBLE_GROUP_CHILDREN` in
  `appendToGroup`), while the aggregate header retains the full history for its
  counts. A hard
  boundary (visible assistant text, visible thinking, user message, a
  different group key, or a non-groupable tool) folds the whole group to its
  summary header via `fold_group_child_rows()` and freezes it. **Same-file diff identity remains SSOT:**
  `merge_group_child_rows` and `merged_child_diff_stats` retain normalized
  same-file merge behavior for the shared child formatter and subagent live
  waves, so repeated edits/writes/patches to one file show as ONE accumulated
  child row instead of a stack. Thinking uses the latest child slot instead of
  appending beside retained tool rows.
  Same-key batches reopen the latest
  settled group (`findReopenableGroup`) instead of spawning another
  `Explored`/`Edited`/… header. The elapsed suffix is ONE shared turn pass
  timer (`thinkingPassStartedAt`, armed idempotently by
  `arm_thinking_pass_timer()` on user `message_start` / `arm_pre_token_thinking_status`
  / `startThinkingAnimation` / `resume_thinking_header_for_think_stream`,
  cleared only by `clear_thinking_pass_timer()` at hard boundaries: visible
  text, visible thinking, `agent_settled`, and session shutdown) read by the
  widget, the in-message host, AND the in-group `│ Thinking` lane — SSOT,
  never reset per pass or when the thinking stream arrives; total turn time
  still notifies once on `agent_settled`. Tool boundaries
  (`tool_call`, `tool_execution_start`, `toolcall_start`) suppress the
  header but do NOT clear the timer — the pass continues through tools.
  `message_end` and `agent_end` (inter-run events) also do NOT clear the
  timer; only `agent_settled` (the true end of the user's task) clears it.
  When Pi is compacting context (manual
  `/compact`, threshold, or overflow recovery), `installCompactionStatusPatch`
  replaces Pi's `CompactionStatusIndicator` with a compact tool row: muted
  bullet + gradient `Compacting` (same `thinking` preset and shared 20 FPS
  gradient clock as the Thinking header). The stock
  spinner is stopped; `bind_compaction_status_indicator()` in
  `compaction-render.ts` wires the live indicator's `invalidate` to the same
  gradient tick (no separate timer). On completion,
  `CompactionSummaryMessageComponent` renders the same compact bullet style:
  success bullet + `Compacted {tokensBefore} tokens into ~{estimatedSummaryTokens}.`
  (estimate = `Math.ceil(summary.length / 4)`). Collapsed rows append a dim
  `ctrl+o to expand` hint; expanded rows show the summary Markdown below.
  Compaction rows never use chatbox horizontal rules. **Transcript placement:**
  `build_transcript_entries()` in `pi-ember-ui/transcript-entries.ts` (SSOT) drives
  `rebuildChatFromMessages` and `renderInitialMessages` instead of Pi's
  `buildContextEntries()` — the full branch is kept in chronological order so
  compaction is appended at its branch position (not hoisted to the top) without
  deleting upstream plan, assistant, or tool rows. `installCompactionTranscriptPatch`
  also handles successful
  `compaction_end` without Pi's redundant `addMessageToChat(compactionSummary)`
  append (rebuild already paints the row). Escape-to-cancel remains
  wired by Pi's `compaction_start` editor handler. Never clear
  `thinkingActive`/`agentRunPending` from `agent_end` alone and expect the status
  to stay — `agent_end` is not the end of the user's task. A HARD boundary
  (visible user-facing text, a visible thinking stream, a non-group or
  different-group tool, a user message, or `session_compact`) folds every child
  row into the summary header; `agent_end`/`agent_settled` only flip the header
  to past tense and KEEP the visible rows, because the next same-key wave may
  still append to the same group. A visible thinking stream is a hard chronological boundary: it
  calls `noteVisibleThinking()` and the following tool wave always starts a
  new header below the transcript reasoning, including during an inter-run
  gap. Hidden thinking uses `noteHiddenThinking()` to paint the in-group
  `│ Thinking` lane and keeps the group reopenable — hidden reasoning is NOT
  a separate transcript block, so the next tool wave (different tool name)
  appends another child row under the same header instead of spawning
  a fresh `Explored`/`Edited`/… row. **Any visible (non-empty) `text_delta`
  is a hard boundary** — `apply_assistant_stream_boundary` in
  `assistant-stream-boundary.ts` collapses the work group to header-only via
  `noteVisibleText()` → `hardExitGroup()`, whether the text is inter-run
  narration (OpenAI/Codex commentary between batches) or the final answer, and
  whether the agent is still pending. Streamed text owns the transcript slot: a
  stale in-group `│ Thinking` lane with a running elapsed timer never lingers
  over it, and `should_suppress_thinking_header_for_stream_event()` suppresses
  the external Thinking header for every non-empty `text_delta`. The next tool
  wave starts a fresh header below the streamed text — there is no
  `planning_text` soft boundary and no `armInGroupThinkingForPlanning`. **Every visible non-empty `thinking_delta`**
  hard-exits the work group (`noteVisibleThinking()`), including during an
  inter-run gap, so the next tool wave cannot update a header above visible
  reasoning. Bare `thinking_start` or empty `thinking_delta` without reasoning output does not split. Hidden reasoning uses `noteHiddenThinking()` for the in-group
  lane and stays reopenable (hidden reasoning is not a transcript block) — never `reopenClosed`.
  The
  `isToolGroupActive`/`setToolGroupActive` flag
  lives in `pi-ember-ui/mode-colors.ts` (SSOT), written from `pi-compact-tools`
  lifecycle handlers (`tool_call`, `tool_execution_end`, `turn_end`,
  `session_start`) via `CompactRenderer.hasActiveGroups()` — never from a
  render closure. The `latestAssistantMessageTimestamp` and
  `thinkingActive`/`workingActive`/`agentRunPending` state
  are cleared on `session_shutdown`. `isInterRunGap()` and
  `isToolExecutionInFlight()` (incremented on `tool_execution_start`,
  decremented on `tool_execution_end`) live in `mode-colors.ts` — never duplicate
  the inter-run classifier. `suppress_thinking_header_for_work()` on
  `text_delta` runs for every non-empty delta regardless of the inter-run gap
  (`should_suppress_thinking_header_for_stream_event`), so gradient Thinking
  never lingers while the agent streams visible text or tools. `thinkingBlocksHidden` syncs from session settings
  on `session_start` and from `setHideThinkingBlock` (Ctrl+T) before the first
  assistant `updateContent`. `Ctrl+T` (show/hide thinking blocks)
  rebuilds the chat and can change the transcript line count — see the Running
  / newest-child bullet in the `pi-compact-tools` grouping contract for
  how group child rows collapse and linger independently of that toggle.
  **Visible→hidden toggle merges reasoning-only splits:** a Ctrl+T while the
  turn is settled rebuilds the branch, and the flag flip happens while Pi
  constructs the first replayed assistant message — before that turn's tool
  components replay. `apply_thinking_blocks_hidden()` in `pi-ember-ui/index.ts`
  is the single transition observer (called from the patched
  `AssistantMessageComponent.updateContent` and `setHideThinkingBlock`, the only
  two writers of the live component value). It runs
  `handle_thinking_blocks_visibility_change()` synchronously — so
  `mergeVisibleThinkingHardExits()` folds work groups that were split only by a
  visible reasoning block before the rebuilt components render (absorbed
  members render zero rows, never a stale standalone row) — then re-paints and
  releases the boundary suppression in a deferred microtask. The result matches
  hiding thinking blocks for the whole turn. Never register a global visibility
  listener for this: its lifetime outlives the session and it would react to
  unrelated renderer instances. Session-start settings sync writes the flag
  directly (the renderer starts empty, nothing to reconcile).
  SSOT note (2026-08-07): Thinking now shows ONLY on user send (pre-tool wait)
  or a real thinking stream — `agent_start`/`agent_end`/`tool_execution_end`
  never re-arm (post-tool feedback stays with compact tool `-ing` verbs via
  `holdToolLane`), non-empty non-thinking text always suppresses (no pre-tool /
  inter-run exemption), and the pass timer starts on the user-send pre-token
  arm and CONTINUES seamlessly through hidden reasoning — `thinking_start` /
  repeated `thinking_delta` never reset `thinkingPassStartedAt` (the idempotent
  `arm_thinking_pass_timer()` only sets when zero, so repeated arms preserve
  the live timestamp). A visible-text / visible-thinking / `agent_settled`
  boundary ends the pass and zeroes the timer via `clear_thinking_pass_timer()`,
  so the next re-show starts fresh. Tool boundaries suppress the header but do
  NOT zero the timer; `message_end`/`agent_end` (inter-run events) also do NOT
  zero it.
- **Message/Row Background Token:** The `MUTED_MESSAGE_BG` constant in
  `mode-colors.ts` (`desaturateHex(blendToHex("#ffffff", PAGE_BG, 0.05), 1)` —
  white at 5% opacity over `PAGE_BG`, desaturated to a pure neutral grey =
  `#262626` so the PAGE_BG blue bias does not bleed through) is the single
  source for the subagent-row and custom/compaction-message backgrounds.
  It is mode-independent: no orange/purple/green/yellow accent tint bleeds
  into message backgrounds. `buildThemeBgColors` assigns the same constant
  to `subagentBg` and `customMessageBg`; the static `ember.json` seed mirrors
  it (`subagentBg`/`customMsgBg` = `#262626`). Never inline a hex value for
  these backgrounds and never re-derive them from the accent. Subagent rows
  no longer use a background at all — the transcript renders per-agent
  blocks transparently (no `subagentBg` Box), so `MUTED_MESSAGE_BG` applies
  only to custom/compaction message backgrounds where the chatbox rule style
  has not been applied.
- **User-message / quiz / compaction / bash border style:**
  `UserMessageComponent` renders as prompt-glyph-led markdown: the patched
  `rebuild` builds a `Markdown` wrapped by `PromptGlyphContent` (exported
  from `pi-ember-ui/index.ts`), which prepends a live-accent `❭` glyph to
  the first rendered row with exactly 1 col of space after it
  (`PROMPT_GLYPH_LEFT_PAD`), so the glyph + left pad occupy 2 visible
  columns total. `PromptGlyphContent` renders its child at
  `width - 2 - USER_MESSAGE_RIGHT_PAD(2)` so there are always 2 cols of
  right padding on every user-message row, and re-truncates the glyph row
  as a safety net, so the prefixed first row never exceeds the terminal
  width (Pi's TUI throws on any rendered line wider than the terminal —
  2026-08-09 crash: the glyph was prepended to a row already at the Box
  content width, making it 122 wide at a 121-col terminal). It ALWAYS
  returns a fresh array (`[fitted, ...rows.slice(1)]`) and never mutates
  the child's output: pi-tui components (Markdown, Box) cache their render
  result and return the same array reference every call, so writing
  `rows[0]` in place made the `❭ ` accumulate by one glyph per TUI frame
  into an infinite spam line. Never mutate a child's cached render output
  in a wrapping component — build a new array instead. OSC133 zone markers
  are preserved by `UserMessageComponent.render` wrapping the rendered
  block.
  The quiz `renderCall`/`renderResult`,
  `CompactionSummaryMessageComponent`, the finished-bash transcript rules
  (`format_ember_bash_transcript_lines`), and the slash-command / model-picker
  middle separator all use chatbox-style horizontal rules (`──`) colored by
  the single `chatboxBorderColor(text)` helper in `pi-ember-ui/index.ts`,
  which paints `DIM_CHROME_COLOR` (SSOT in `mode-colors.ts`). The finished-bash
  output tree uses `paint_tree_pipe()` for the same color: every output row
  carries `│` (running and completed alike — no `└` corner), and status hints
  (`... N more lines (ctrl+o to expand)`, exit codes, cancellation) are indented
  with no glyph at all; the `running` parameter is retained for call-site
  compatibility and no longer changes the tree. No call site
  uses `TEXT_COLOR`, `colorWithOpacity`, or a per-site hex for these rules.
  The `chatboxBorderContainer(content, paddingX)` helper wraps content with a
  top and bottom `DynamicBorder` (using `chatboxBorderColor`) and a
  `Box(paddingX, 0, undefined)` for left/right inset, with no background fill.
  This replaces the previous `userMessageBg`/`customMessageBg` block
  backgrounds for those rows.
  Compaction summaries render as compact tool rows (no chatbox rules): running
  `• Compacting` (gradient verb, muted bullet) via the patched status
  indicator; completed `• Compacted {tokensBefore} tokens into
  ~{estimatedSummaryTokens}.` via `CompactionSummaryMessageComponent` (SSOT in
  `pi-ember-ui/compaction-render.ts`). Collapsed completed rows append a dim
  `ctrl+o to expand` hint; expanded rows show the summary Markdown below the
  stats line. The background is transparent; only
  `MUTED_MESSAGE_BG` still applies to subagent-row and custom/compaction
  message backgrounds where the chatbox rule style has not been applied.
  OSC133 zone markers are preserved by `UserMessageComponent.render` wrapping
  the rendered block (see the User-message border style bullet above).
- **Mode-switch tool-access reminder:** When `apply_mode` switches between two
  different modes, it injects a hidden `pi-agents-tool-access` custom message
  (`display: false`, same channel as `pi-agents-auto-continue` and
  `pi-agents-loop-retry`) telling the model which tools it lost, which it
  gained, and its current tool set. This steers the next turn without
  cluttering the transcript. Never duplicate this reminder in other plugins.
  **Deferred mode switch while an agent run is in flight:** a manual switch
  (`/plan`/`/code`/`/orchestrate`, Tab cycle) during a running agent is
  UI-only — `setActiveMode` + the live `mode-change` event + the powerbar
  flip immediately, but the logical switch (`currentMode`, `setActiveTools`,
  the hidden tool-access reminder, the bound-model restore) is deferred
  (`deferred_mode_id`, flushed by `flush_deferred_mode_switch`) until
  `agent_settled`, so it never mutates the ongoing stream (mid-run
  `setModel`/tool-set/reminder injection) and never dismisses a pending Plan
  Review (`agent_settled` gates the review on `currentMode === "plan"` — the
  review still opens and resolves before the deferred switch applies).
  `should_defer_mode_switch` in `mode-switch.ts` is the SSOT predicate
  (defer only on a real mode change while `isAgentRunPending()`); same-mode
  re-applies and settled switches stay immediate. Post-settle decisions
  bypass the predicate with `force=true`: the Plan Review `Implement Plan`
  switch (`handlePlanImplement`) and the `agent_settled` flush itself apply
  immediately even though the shared `agentRunPending` flag is still set
  (pi-ember-ui's own `agent_settled` listener clears it only after
  pi-custom-agents' handler has run), so the implement follow-up turn starts
  in the selected mode with its full tool set instead of the stale plan
  mode — never defer the review-chosen switch or re-defer inside the flush.
  Tab cycling resolves from
  `pending_mode_id ?? deferred_mode_id ?? currentMode` so the visible mode is
  the cycle anchor. `session_shutdown` clears the deferred switch and persists
  it (`deferred_mode_id ?? currentMode`) so the next session resumes in the
  mode the user actually selected.
- **Frozen code-accent visuals:** The startup animated Pi header logo gradient
  and the startup header bullet (`•`) follow the live mode accent via
  `getActiveModeColor()`. Once the logo settles to static gray (after the user's
  first visible message or at shutdown), the bullet switches to `dim` and no
  longer tracks the accent. The Markdown token `mdLink` follows the live accent
  (90% blend from `buildThemeFgColors`). `mdHeading` and `mdListBullet` (ordered
  `1.` / unordered `-` markers) use `MUTED_COLOR` — never the live or code accent.
  Compact-tool match counts (`N matches`) also use `muted`. The header render
  closure in `pi-ember-ui/index.ts` calls `getActiveModeColor()` for the animated
  logo bullet; the static branch stays muted. Pi's startup update notices
  (`pi update` / changelog URL / "What's New") are suppressed in
  `installUpdateNotificationPatch`; no update summary is shown on startup, so
  the normal context/skills/extensions/themes summary is the only startup
  content. Everything else (footer mode label, thinking/summarizing
  gradient, borders, tool titles, `customMessageLabel`) continues to follow the
  live mode accent.
- **Select-list / extension-selector theme patch:** `select-list-theme.ts` patches
  Pi's `ctx.ui.select` (ExtensionSelector) and SelectList rows so selected → `text`
  (bright) and unselected → `dim` (never accent/white inversion). Its
  `resolve_coding_agent_dist_dir()` resolution order is: (1) the running pi entry
  script `process.argv[1]` (dist/cli.js or dist/rpc-entry.js → dirname → verify
  `modes/interactive/components/extension-selector.js` — targets the actual runtime
  regardless of layout), (2) bare specifier
  `req.resolve('@earendil-works/pi-coding-agent')`, (3) the `dist/index.js` and
  `dist/cli.js` subpath attempts, (4) the pi-tui sibling path. Never reorder the
  strategies or drop the `verify()` guard — the exports map exposes only `.` and
  `./rpc-entry`, so subpath resolves throw and only the argv[1] entry reliably
  lands on the running runtime's dist dir.
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
    ├── plugins/pi-ember-applypatch/
    │   └── Codex-style apply_patch tool (openai-codex provider only)
    ├── plugins/pi-ember-images/
    │   └── Cross-platform clipboard/path image attachments and compact previews
    ├── plugins/pi-ember-sessions/
    │   ├── session catalog (SSOT for /resume) + on-disk index cache
    │   └── background conversation fleet (/fleet)
    ├── plugins/pi-custom-agents/
    │   ├── primary modes, plans, quiz
    │   ├── hierarchical AGENTS.md auto-loader (agents-md.ts)
    │   └── subagent implementation and bundled agent definitions
    ├── plugins/devin-auth/
    │   └── Devin provider, OAuth, catalog, and streaming
    ├── plugins/pi-crof-auth/
    │   └── CrofAI OpenAI-compatible provider, API-key login, and model catalog
    ├── plugins/pi-cursor-auth/
    │   └── Cursor subscription auth, model discovery, and Pi-native streaming
    ├── plugins/pi-novita-auth/
    │   └── Novita OpenAI-compatible provider, API-key login, and model catalog
    ├── plugins/pi-ember-fff/
    │   └── FFF-powered grep/find with external allowlist
    ├── plugins/pi-ember-hashedit/
    │   └── Hash-anchored read/replace/undo tools with stable line anchors
    ├── plugins/pi-ember-screen/
    │   └── Windows/macOS window listing and screenshots (Bun FFI helper) for visual verification
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
- `edit` remains registered here for all providers. Code mode and the Coder
  subagent use `edit` for non-`openai-codex` providers and `apply_patch` from
  `pi-ember-applypatch` only for `openai-codex` (see `edit-tools.ts` SSOT).
- Every standalone tool-call row uses the compact bullet prefix: `• ` via
  `statusBulletColor` (SSOT): static `muted` while running, `success` when
  done without error, `error` on failure. Running animation lives in gradient
  child verbs, not the bullet. Font weight is swapped: tool rows and group
  headers carry the REGULAR face (`paint_compact_tool_label` and the group
  header painters never apply `theme.bold`), while the Thinking gradient
  label carries the BOLD face via `render_gradient(..., { bold: true })` —
  one bold wrapper composed over the active colorizer in `gradient.ts`
  (`GradientRenderOptions.bold`), consumed by `render_thinking_gradient_label`
  so every Thinking surface (external host, in-message, in-group lane,
  subagent tray) inherits it. Never re-bold tool rows or re-thin Thinking.
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
- Standalone running edit/write verb: a single-member work group (the first
  edit/write in a burst, before a second member joins) shows the gradient
  present-tense verb (`Editing`/`Writing`) via `formatGroupChildGradientVerb`,
  not the static `Edit`/`Write` label. `renderCallInner` subscribes the
  shared 20 FPS gradient tick (`subscribeStandaloneTick`) so the verb
  animates; `renderResultInner` drops the tick and snaps to the muted
  past-tense label on completion. When a second member joins the group
  (`appendToGroup`), the standalone tick is dropped in favor of the group
  tick. `hardExitGroup` and `resetForSession` also clear it. This matches the
  group child row path so the verb is identical whether the call is
  standalone or grouped.
- Edit matching ladder ownership: Pi core `edit-diff.ts` (resolved from the
  installed `@earendil-works/pi-coding-agent` package) owns the canonical edit
  matching ladder. The pipeline is rung 1 exact `indexOf`, rung 2 LF
  normalization of file content and edit args (`normalizeToLF`), rung 3
  `normalizeForFuzzyMatch` (NFKC, strip trailing whitespace per line, smart
  quotes/dashes/special Unicode spaces → ASCII), ambiguous rejection via
  `countOccurrences` (throws a duplicate-context error when >1 match), and
  distinct errors for empty oldText, not found, no change, and overlap.
  Successful fuzzy matches apply through `applyReplacementsPreservingUnchangedLines`
  so unchanged line blocks keep their original bytes. `pi-cursor-auth`
  `normalize_tool_arguments` remaps Cursor-style arg names back to Pi schema
  names (`old_string`/`new_string` → `oldText`/`newText`, `search_term` →
  `query`, `response_id` → `responseId`, plus `file_path` → `path`) for every
  tool whose outbound name is renamed in `PI_TO_CURSOR_ARG_NAMES` (`read`,
  `write`, `edit`, `ls`, `grep`, `find`, `web_search`, `fetch_content`,
  `get_search_content`) and must not do its own whitespace normalization;
  `pi-compact-tools` only renders live counts and must not touch matching. Per the override-delegation rule, any future
  indentation-insensitive rung, candidate-location reporting on failure, or
  line-range/hash/stable-context anchors belong upstream in pi-mono, not as a
  pi-ember-stack edit override.
- Consecutive groupable tool calls (`read`, `grep`, `find`, `ls`, bash
  `grep`, `edit`, `write`, non-grep `bash`, `apply_patch`) fold into one
  unified work-bundle header until a hard boundary. The header summarizes all
  completed work in one comma-separated line, e.g. `Edited 4 files, Explored 2
  files, 3 searches, ran 1 command +148 -47` (`formatUnifiedWorkHeader` /
  `format_unified_work_segments` SSOT in `renderer.ts`). Aggregate `+N -N` on
  the header uses bright success/error tokens; grouped child edit/write rows use
  muted `+N -N` via `formatGroupChildEditWriteStats`. Only the header carries
  the bullet. Bash grep calls count as searches and join the same bundle.
  A pure run of at least two `apply_patch` calls uses a collapsible `Patching`
  header with per-file children; any mixed patch/read/edit/search run remains in
  this unified public work bundle so patches contribute to `Edited`/`Explored`
  summaries.
  Grouped child rows show path/details only plus muted diff stats; grouped read
  children include offset/line limit. Bash `grep` child rows always carry the
  same `Search` label as `grep` tool rows (`formatCallBodyVerb` SSOT) — never an
  empty verb leaving a bare `pattern in path` row with no tool name. Final
  counts use distinct tool-call target paths for files; searches and bash
  commands count call entries. Every
  group header and child is one ANSI-aware, width-truncated terminal row. The
  grouping contract is:
  - **First-member ownership:** The first call that creates a group
    anchors the group header (`renderOwner`) and keeps it for the
    rest of the group's lifetime. Ownership never migrates to later calls.
    New same-type calls append as child rows under the existing header.
  - **Single live group:** The renderer tracks one `currentGroup` at a
    time. All native groupable tools share `WORK_GROUP_KEY` (`__work__`), so
    discovery, edit, write, bash, and patch calls in one burst accumulate
    under one header instead of splitting by tool family; `browser_*` tools
    share the one `BROWSER_GROUP_KEY` (`__browser__`) group. Switching
    between the two keys is a hard boundary: the previous group folds to its
    summary and is frozen (`hardExited`) so it can never be reopened above the
    intervening block. A non-groupable
    tool or hard boundary settles/clears the group. Soft settles (hidden
    thinking via `noteThinking`, `agent_end` via `settleAllGroups`) keep
    `currentGroup` so a later groupable call reopens via `appendToGroup`
    (flips `settled` back to false). Hard settles (visible assistant text,
    visible thinking, user message) clear `currentGroup` so the next burst
    cannot paint above an intervening transcript block — groups stay
    chronological.
  - **Cross-turn grouping:** Discovery and action groups persist across
    consecutive turns. `beginTurn()`/`endTurn()` do not reset the active
    group, so sequential read/grep/find/ls, edit, write, or bash calls
    fold into a single `Exploring`/`Editing`/`Writing`/`Bashing` header
    until the agent writes visible user-facing text, the user sends a
    message, a non-groupable tool runs, or the group key changes.
    `agent_end` soft-settles (`settleAllGroups` flips past tense but does
    not clear `currentGroup`) so completed runs show
    `Explored`/`Edited`/`Wrote`/`Bashed` and the next same-key batch
    reopens that header. The `settled` flag lives on `DiscoveryGroup`;
    `settleGroup`/`settleGroups`/`settleAllGroups`/`noteThinking` are the
    soft setters; `noteVisibleText`/`noteUserMessage` are the hard
    boundaries. Settled same-key groups reopen when a new call arrives
    while `currentGroup` is still held. When thinking blocks are hidden, inter-run
    inter-run gaps (`isInterRunGap()`), and real thinking/reasoning streams
    (`message_update` → `noteThinking()`) enter the thinking lane: gradient
    `Thinking` replaces the newest child row (earlier rows stay listed up to the
    five-row cap). Same-key batches reopen via `findReopenableGroup` when
    `currentGroup` was lost so another `Explored` header is not spawned.
    **Any visible (non-empty) `text_delta` is a hard boundary**
    (`apply_assistant_stream_boundary` → `noteVisibleText()` →
    `hardExitGroup()`), including OpenAI/Codex narration between batches and the
    final answer — streamed text never renders below an open work group or a
    stale `│ Thinking` lane. **Final answer text**
    (`text_delta` after the agent is no longer pending), user message, different
    group key, or hard non-groupable tool
    (`subagent`, `quiz`, … via `noteInterveningToolCall`) →
    `hardExitGroup()` (header-only, drop reopen, `hardExited` set);
    same-key
    `tool_call` → reopen tool lane (recovers frozen group via
    `findReopenableGroup` if `currentGroup` was lost without a hard exit);
    every visible non-empty `thinking_delta` hard-exits via
    `noteVisibleThinking()`, including inter-run reasoning, so the next
    same-key batch gets a fresh header downstream. Bare `thinking_start` or empty `thinking_delta` without reasoning output does not split. Hidden reasoning uses
    `noteHiddenThinking()` for its in-group lane and stays reopenable (hidden
    reasoning is not a transcript block) — never `reopenClosed`. Hard group splits on visible text use non-empty `text_delta` only — bare
    `text_start` must not split.
  - **Collapsing work-group rendering:** Under the unified work header
    (`• Edited N files, explored M files, … +N -N`), the aggregate record list
    retains every call for counts, results, rebuilds, and completion state, but
    only the newest `MAX_VISIBLE_GROUP_CHILDREN` (5) records render as child
    rows — every older call is absorbed into the header
    (`childAbsorbBefore = records.length - 5` set in `appendToGroup`). The
    five-row window is what keeps a long tool burst from growing a wall of
    rows the user has to scroll past while still showing the in-flight wave.
    Because the window is positional, a parallel burst of N running calls
    shows all N rows until the cap pushes the oldest into the header; rows
    fold on the cap, NOT on completion, and `groupVisibleChildren` is a plain
    slice (`groupVisibleChildren` → `selectGroupVisibleChildren`). The whole
    group folds to its summary header only at a HARD boundary: visible
    assistant text, visible thinking, a user message, a non-groupable tool,
    a call in a different group key, or `session_compact` (compaction rebuilds
    the transcript, so the pre-compaction group must never be reopened above
    the new summary — the next tool wave starts a fresh header)
    (`fold_group_child_rows` + `freezeGroup` / `hardExitGroup`;
    `hardExited` short-circuits `groupVisibleChildren` to header-only,
    absorbing even a running row caught by the boundary).
    `agent_end`/`agent_settled` keep the visible rows. An error row colors the
    header bullet only while the failed call is still visible — once absorbed
    the failure is historical and the bullet returns to `success`. Thinking
    streams preserve the unified header and replace the newest tool child with
    in-group `│ Thinking`; the next tool call restores that slot. The subagent
    live tray deliberately diverges: it is a capped preview, so it sets
    `childAbsorbBefore = records.length - 1` and shows only the newest call
    even while earlier burst members are still in flight.
  - **Browser compat group:** Every `browser_*` tool (pi-browser family,
    detected by `is_browser_tool_name`) shares one `BROWSER_GROUP_KEY`
    (`__browser__`) group instead of rendering as a standalone foreign row.
    The live header reads `◇Browser`; once the group collapses the header reads
    `◇Browser: Navigated N times, Took N screenshots, Interacted once, Resized
    N times, …` (`formatBrowserGroupHeader` /
    `format_browser_group_segments` SSOT). Browser rows use the `◇` diamond
    marker with NO trailing space (`BROWSER_BULLET` in `compact-text.ts`,
    painted by `standaloneCallBulletColor` / `groupHeaderBullet` — same
    color ladder as `statusBulletColor`), so the label sits one column left
    of every `• ` bullet row. Child verbs come from
    `BROWSER_TOOL_LABELS` (`Navigating`/`Navigated`, `Interacting`/`Interacted`,
    `Resize`/`Resized`, `Screenshot` with no `-ing` form for
    `browser_take_screenshot`, …); an unlisted browser tool falls back to the
    `browser_`-stripped tool name for both states. `browser_navigate` shows its
    URL, `browser_resize` shows `WxH`, and `browser_evaluate` /
    `browser_take_screenshot` show no argument detail.
  - **Foreign-tool rows delegate, they never block grouping:** the
    `foreign-tool-row.ts` patch substitutes only Pi's fallback renderer for
    tools that define neither `renderCall` nor `renderResult`; it calls the
    shared `CompactRenderer` entry points, so a foreign tool that is browser-
    or work-groupable joins the same group machinery.
  - **Group child gradient tick:** While visible child rows render, the
    owner's `invalidate` is subscribed to the shared gradient tick via
    `subscribeGradientTick`/`unsubscribeGradientTick`
    (exported from `pi-ember-ui/index.ts`, backed by the single 20 FPS
    clock in `gradient.ts`). Child verbs use `render_gradient` with the
    muted→text `actionGroup` preset at the same `GRADIENT_TICK_MS` cadence
    as the Thinking widget. The tick is dropped when its last visible child
    completes and the lane/hold ends (agent settle, fold at a hard boundary,
    or session reset). Subscriptions
    callback identity with a mutable invalidate target so Pi rebuilds (which
    provide fresh invalidate closures) rebind the target without churning the
    subscriber Set. **The tick rebuilds only the dynamic lane:** the group's
    header + child rows are cached as `group.staticText` (refreshed by every
    full `formatGroup` call and invalidated by `fold_group_child_rows`/
    `appendToGroup`), so `refreshActiveGroupText` re-bakes just the
    `│ Thinking` lane (gradient label + elapsed suffix) per 50 ms tick —
    never the whole block. `hasAnyGroupThinkingChild()` is O(1) (a
    `thinkingLaneCount` counter maintained by `setThinkingChild()`), so the
    20 FPS render path can query it live without an O(calls) scan.
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
    existing `toolCallId` rebinds the live component's gradient subscriber,
    so destroyed owners cannot hijack `record.invalidate` back to dead
    components. The subagent renderer
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
  equivalent `rg` (ripgrep) invocations via `pi-compact-tools/bash-grep.ts`
  (SSOT). Combined short flags (`-rn`,
  `-rin`), `--include`/`--exclude`/`--exclude-dir`, context flags (`-A`,
  `-B`, `-C`), and `cd <dir> &&` prefixes are translated. Unknown flags
  cause a safe bail (original grep runs unchanged).
- **Shared rendering primitives:** `renderer.ts` exports the canonical
  `statusBulletColor`, `groupBulletColorFromFlags`, and `BULLET` for reuse by
  other plugins (notably the subagent renderer). There is no pulse timer or
  `PulseManager`; never duplicate bullet-color logic, and import it from
  `renderer.ts`. `renderer.ts` also exports `hasActiveGroups()` on
  `CompactRenderer` and imports `renderLiveGradient` from
  `pi-ember-ui/index.ts` to render a muted/text gradient sweep on the
  compact group header while any member is running, the in-group Thinking lane
  is painted, or the group is not yet settled (reverting to plain bold final
  summaries when all complete and settled). Lingering completed child rows alone
  do not make `hasActiveGroups()` true. The `isToolGroupActive` flag in
  flag in `pi-ember-ui/mode-colors.ts` is driven from this plugin's
  lifecycle handlers via `hasActiveGroups()`.
- **Foreign-tool compact rows:** `foreign-tool-row.ts` (SSOT) installs one
  `ToolExecutionComponent.prototype` patch that routes any tool defining
  NEITHER `renderCall` NOR `renderResult` through the shared `CompactRenderer`
  — Pi's raw fallback (bold tool name + full result dump in a colored shell)
  is what third-party tools rendered, e.g. pi-browser's `browser_*` rows.
  They now render as the same bullet-led, single-row, `ctrl+o`-expandable
  rows as every Ember tool call (`◇browser_navigate url <target>`), via the
  renderer's SSOT bullet helpers (browser rows get the `◇` diamond, the rest
  keep `statusBulletColor`), its standalone row formatter, and
  the `self` render shell (no fallback background box). The substituted
  renderers delegate to Pi's original getters for every tool that defines
  either renderer, never request a render, never write terminal output, and
  never mutate Pi's differential state. The foreign tool keeps its owner:
  the extension still owns the schema, execution, and result; only the
  fallback presentation changes. The one-line argument summary for such
  tools lives in `renderer.ts` (`foreign_arg_summary` /
  `FOREIGN_ARG_SUMMARY_MAX_CHARS`) — never add a second foreign-tool name map
  or a per-extension renderer.

### `pi-ember-images`

- Owns clipboard and pasted-path image attachments for the parent TUI.
- Clipboard reads prefer the pi runtime's native clipboard module
  (`@mariozechner/clipboard` via `dist/utils/clipboard-native.js`, resolved
  through the shared `resolve_coding_agent_dist_dir` SSOT) — in-process,
  instant, zero subprocess spawns, so a clipboard read can never hang or time
  out. When the native module is unavailable (WSL/headless), Windows falls
  back to an async STA PowerShell `System.Windows.Forms`/`System.Drawing`
  read and macOS to `osascript`; both fallbacks run through the shared
  `runCaptured` helper with a hard timeout and process-tree kill so a hung
  clipboard owner can never freeze the TUI. Windows file paths from
  bracketed terminal paste are recognized before they reach the normal editor.
- Image placeholders use the single `[image N]` format in the editor. On submit,
  the input handler removes placeholders from prompt text and attaches native
  Pi `ImageContent` parts.
- **Fallback capability SSOT:** `isImageFallbackMode()` in
  `image-utils.ts` is the single predicate — true exactly when
  `getCapabilities().images === null` (no supported inline-image protocol).
  Both the input handler (`index.ts`) and the preview component (`preview.ts`)
  read this one predicate; never inline a second `getCapabilities().images`
  check or a parallel capability cache.
- **Fallback path (unsupported protocol):** on submit, the input handler
  replaces each attachment placeholder with its fallback label
  (`[image N: WxH]`, via the SSOT `format_image_fallback_label` in
  `types.ts`) inside the originating user-message text at that transcript
  position (`replaceImagePlaceholdersWithFallbackLabels` in
  `image-utils.ts`). Separate preview custom messages
  (`pi-ember-images-preview`) are NOT injected — `pendingPreview` is never
  set on the fallback path, so `before_agent_start` has nothing to inject.
  Native `ImageContent` parts are still attached for the model in both paths.
- **Supported-protocol path (unchanged):** the transcript renders compact
  inline previews through Pi TUI's public `Image` component in the
  `pi-ember-images-preview` custom message (idle deferral or
  `deliverAs: "followUp"`); placeholders are stripped from the prompt text.
- **Fallback tradeoff / public-seam rationale:** replacing the placeholder
  with the dimensioned label inside the originating user text keeps the
  image reference at its transcript position and readable on terminals that
  cannot display inline images, at the cost of making the label model-visible
  in the user message (the model sees `[image N: WxH]` instead of nothing).
  The `input` transform + `sendMessage`/`before_agent_start` public seams are
  the only integration points — this plugin never writes terminal frames or
  maintains a parallel renderer.
- The placeholder line and terminal fallback text are rendered with the
  `text` token, not `dim`, so the label is readable in terminals that cannot
  display inline images (e.g. Windows Terminal).
- The `compressAttachment` function in `pi-ember-images/compress.ts` is the
  SSOT for image compression: PNG/JPEG attachments are re-encoded to lossy
  WebP (quality `ATTACHMENT_WEBP_QUALITY` = 80) and capped at
  `ATTACHMENT_MAX_DIMENSION_PX` = 2000 px on any edge; GIF and already-WebP
  inputs are skipped; the smaller of the original or WebP bytes is kept;
  any encode failure silently preserves the original bytes.
- `sharp` is the canonical image-processing dependency for encoding and
  resizing. JPEG XL and AVIF are intentionally not used because major vision
  model providers and the terminal do not accept them, and Pi's own image
  normalizer would silently drop such formats.
- The extension loads before `pi-custom-agents` so the existing editor wrapper
  composes around the image-aware editor instead of being replaced.
- **Deterministic paste scan budget:** `MAX_IMAGE_PATH_SCAN_CHARS` (2000) in
  `image-utils.ts` is the SSOT cap for the synchronous path→image transform
  (`replaceImagePathsInText`). Text beyond the budget is returned unchanged
  before tokenize + synchronous fs probes ever run, so copy-pasting a large
  text block can never block the TUI on `existsSync`/`statSync`/`readFileSync`
  per path-like token. Every call site (editor bracketed paste, per-keystroke
  rescan, submit-time `input` transform) shares this one cap — never add a
  second scan threshold. The editor's `transformPastedPathAlreadyInEditor`
  additionally only rescans when the current input chunk carries a path
  separator/drive-colon (`/`, `\`, `:`) at most `MAX_SINGLE_PATH_CHUNK_LEN`
  (256) chars, or when the cursor sits inside an already path-like token
  (`isTypingPathTail`, bounded to the current line only), killing the
  per-character full-text rescan on non-bracketed fast pastes while still
  completing typed/pasted paths live. Large pastes flow through Pi's native
  bracketed-paste path (collapsed to an expandable `[paste #N +N lines]`
  marker) instantly and deterministically.
- Attachment state is session-local and held by one `AttachmentStore`; it is
  cleared on `session_start` and `session_shutdown`.

### `pi-custom-agents`

- **Quiz for material uncertainty:** All parent modes (`plan`, `code`,
  `orchestrate`) tell the model to ask clarifying questions via the `quiz` tool
  when uncertain about a materially important requirement, tradeoff, or
  interpretation. Trivial or low-risk decisions remain autonomous. The canonical
  guidance text lives once in `QUIZ_UNCERTAINTY_GUIDANCE` in `index.ts` and is
  injected into each parent mode prompt. Quiz is registered exactly once
  (`registerQuizTool`), is explicitly present in the canonical `ORCHESTRATE_TOOLS`
  allowlist (which both advertises and permits it via
  `mode_tools_for_provider`), and the Orchestrate prompt consumes the one
  `QUIZ_UNCERTAINTY_GUIDANCE` constant. These invariants are pinned by
  `test/orchestrate-quiz.test.ts` — never fork the guidance text or the
  allowlist.
- **Provider-aware patch tool selection:** `edit-tools.ts` is the SSOT for
  choosing `apply_patch` vs `edit` vs `replace` (hashedit ownership flag),
  `SUBAGENT_DELEGATION_TOOLS`
  (`subagent` / `subagent_resume`), and `without_subagent_delegation_tools()`.
  Code mode (`build_full_tools`) has no subagent tools — delegation lives in
  plan (Scout-only) and orchestrate via `READONLY_DELEGATING_TOOLS` / `ORCHESTRATE_TOOLS`.
  Subagent child tool lists expose `apply_patch` only when the active model
  provider is `openai-codex`; all other providers get `edit` instead (children
  never load hashedit, so `with_provider_patch_tool` ignores the ownership
  flag). Parent mode lists use `resolve_parent_editing_tool_name()`: `replace`
  when pi-ember-hashedit is loaded, otherwise the provider patch tool.
  `setActiveTools`, mode prompts, and the `tool_call` guard all flow through
  these helpers — never hardcode both tools into a mode allowlist. Switching models in code mode
  refreshes the active tool set and sends a hidden `pi-agents-tool-access`
  reminder when the patch tool changes.
- **Visual verification is a tool, not a script:** `edit-tools.ts` `VISUAL_TOOLS` is
  the SSOT for "an agent can look at a rendered UI" — `window_list` +
  `window_screenshot` (pi-ember-screen) plus `browser_navigate`,
  `browser_snapshot`, `browser_take_screenshot`, `browser_measure`,
  `browser_scroll`, `browser_focus`, `browser_console_messages` (pi-browser). It
  is spread into code mode, `ORCHESTRATE_TOOLS` (the orchestrator verifies what it
  delegates, with no editing tool), and `DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS`;
  `coder.md` also lists it explicitly. `scout.md` stays read-only without it.
  Subagent child sessions load `pi-ember-screen` (repo-relative) and the optional
  user-local `pi-browser` extension discovered from `getAgentDir()`
  (`visual_extension_paths()` in `subagent/extensions/runner.ts`) — never a
  hardcoded user path — so a delegated Coder can measure a page instead of writing
  a throwaway CDP/screenshot script. An agent must never respond to a visual
  question by writing a screenshot script; it uses these tools or says it cannot.
- **One browser tab per agent:** the subagent runner names every child session
  after its agent (`sessionManager.appendSessionInfo(agentName)` immediately
  after the session is created, which is the lettered label in parallel/chain
  mode). Pi hands that name to every extension context of the session, and
  pi-browser keys tab ownership on the session id while titling the tab with the
  name, so a delegated Coder tests in its own tab instead of navigating the page
  the parent (or a sibling Coder) is measuring. Never drop the name — agent tabs
  become anonymous — and never move the call after the first prompt.
- **Runtime context is the delivery mechanism, not the README:** a model only learns
  a tool exists from the prompt it is sent. Three layers, each with one owner:
  (1) `VISUAL_VERIFICATION_GUIDANCE` in `index.ts` is the SSOT text injected into
  every mode prompt whose tool set contains `VISUAL_TOOLS` (code, orchestrate, and
  the orchestrate→code exit) via `mode_reminder`/`exit_mode_reminder` — never
  duplicate this text in another prompt; (2) each tool registration owns its
  model-visible `description`, `promptSnippet` (the only way a tool appears in the
  system prompt's Available tools list) and `promptGuidelines` (flat bullets that
  must name their tool, since they are appended with no prefix); (3) `coder.md`
  carries the subagent equivalent. A tool description that duplicates text living
  in `src/tools/*.ts` is drift — import the module's exported `*_DESCRIPTION`
  constant into the registration instead of restating it.
- **Prompt Style:** `OUTPUT_STYLE_DIRECTIVE` in `pi-custom-agents/index.ts` is the
  single output-style SSOT appended to every parent mode prompt — there is no
  separate plan-mode style constant. Interim and progress replies stay in plain
  dense labeled lines; the final summary/answer message and the Plan-mode plan
  may use markdown structure (`##`/`###` headings, bold, lists). Plan mode
  requires concrete single-approach plans (quiz unresolved forks first; no
  Option A/B inside the plan; no `Open Questions:` section). Subagent
  definitions instruct agents not to narrate their process and to return
  results concisely.
- **Host process safety guidance:** `pi-custom-agents/host-process-safety.ts`
  exports `HOST_PROCESS_SAFETY_GUIDANCE` (SSOT) — the "do not use any command
  to kill node, that is the process we are talking through" rule. It is
  appended to every parent mode system prompt in `index.ts`
  `build_system_prompt` and every subagent system prompt in
  `subagent/extensions/runner.ts` `fullSystemPrompt`, so no agent can kill
  the host Node process that runs the session. Never duplicate this text in
  another plugin or another prompt builder.
- Owns the plan-review flow, quiz tool, mode cycling, and
  `/subagent-model`. Registers the mode-id → label resolver
  (`setModeLabelResolver`) so the `pi-ember-ui` footer can render the active
  mode label without duplicating the `MODES` map. The `/subagent-model` agent
  picker shows each agent's active model + effort as the row's description
  column (`build_subagent_selector_options` → `set_extension_selector_options`,
  rendered by the patched ExtensionSelector `updateList`). The pending options
  state lives on `globalThis` (`Symbol.for`) in `select-list-theme.ts` so jiti
  module duplication can't split the writer from the patched reader.
- **Quiz "None" option:** Every question rendered by the
  quiz tool automatically appends a user-only "None" option
  (value `__none__`, description "Specify the proper answer") that is not
  part of the tool schema or model-supplied options. Selecting it replaces
  the description with an inline multiline `Editor` (from `@earendil-works/pi-tui`)
  so the user can type a custom answer. Enter commits the typed text as the
  answer (`wasCustom: true`); Escape returns to the option list. The typed
  text flows to the model as the answer value/label. While the quiz overlay
  is active, the compact `Quiz N questions` call row is hidden (redundant
  with the overlay title); `renderResult` restores the header plus answer
  rows once complete (`should_hide_quiz_call_row` SSOT in `quiz-tool.ts`).
- **Quiz cancel aborts the run:** Escape on the quiz tool's overlay is a
  cancellation of the agent operation, not an answer — `registerQuizTool`
  calls `ctx.abort()` (Pi's documented "abort the current agent operation",
  identical to Pi's own Escape: interactive mode restores queued messages and
  aborts the agent) when `askQuiz` reports `cancelled`. The tool result still
  lands, so the transcript keeps the `• Quiz cancelled` row and the model
  never receives a "cancelled" answer that would let it keep working after the
  user stopped it. Never swap this for a model-visible cancel result. The
  loop-recovery quiz is unaffected (Escape already maps to `End stream`), and
  the bash-rule `ask` quiz keeps its deny semantics (the run continues with the
  command refused), while plan review runs on a settled agent where the abort
  is a no-op.
- **Plan review:** Every completed plan turn, including turns where the model
  invoked and received a quiz answer, opens the canonical
  `showPlanReview()` quiz (`build_plan_review_questions` /
  `resolve_plan_review_answer` SSOT in `plan-review.ts`). Options:
  `Implement Plan` (same-session code/orchestrate follow-up; embeds
  `latest_plan_text` in the hidden `pi-agents-plan-implement` message via
  `build_plan_implement_message_content` in `plan-implement.ts` so compaction
  cannot reduce the approved plan to the short summary),
  `Implement with fresh context` first opens the same `Implement via` picker;
  then creates a pre-seeded session file containing the target mode's bound
  model, thinking level, one-shot mode marker, and plan user message before
  calling the captured native `switchSession()` seam. This ensures Pi restores
  the selected model and all configured package extensions before the
  replacement runtime is created. The one-shot marker overrides the persisted
  Plan mode during replacement startup, is superseded after the new session
  binds, and the selected mode is persisted for later resume.
  `Copy Plan`, plus the automatic custom `None` option for typed refinements.
  The `Implement via` picker is built once in `plan-review.ts` and uses the
  quiz renderer (not `ctx.ui.select`) so its dim chatbox borders stay out of
  the live plan accent; the selected option uses `text` color like every other
  quiz screen. Its hidden implementation directive is mode-specific: Code
  executes, while Orchestrate delegates to Coder subagents without claiming
  edit access.
- **Absolute auto-compaction ceiling (300k):** `plugins/pi-custom-agents/auto-compact.ts`
  is the single owner of `AUTO_COMPACT_CONTEXT_TOKENS` (300_000). Pi's own
  threshold is purely relative (`contextTokens > contextWindow - reserveTokens`),
  so a 1M-token model would grow to ~983k before anything is summarized. Two
  delivery paths, one constant:
  - **Children (subagent runner + fleet factory):**
    `auto_compact_reserve_tokens(contextWindow)` returns
    `max(window - 300k, DEFAULT_COMPACTION_SETTINGS.reserveTokens)` and
    `build_subagent_settings(model)` puts it into the child's in-memory
    `SettingsManager`, so Pi's NATIVE threshold fires at the ceiling inside
    `session.prompt()` and the run continues (no abort, no re-prompt). Windows
    at or below `300k + Pi's default reserve` keep Pi's own reserve: Ember never
    shrinks the room left for the response and never duplicates Pi's `16384`
    default (read from `DEFAULT_COMPACTION_SETTINGS`). The runner and
    `session-factory.ts` pass their resolved model so the reserve always
    matches that session's window.
  - **Parent session:** Pi owns its settings and its only public trigger
    (`ctx.compact()`) aborts the current agent operation and never continues the
    interrupted turn, so `install_auto_compact(pi)` reads
    `ctx.getContextUsage()` at `agent_settled` and compacts BETWEEN turns.
    `maybe_auto_compact(ctx)` defers one macrotask (every `agent_settled` handler
    has run by then, so an overlay that just opened is visible), then skips when
    a quiz/Plan Review overlay is active (`isQuizActive`), output-limit recovery
    is running (`isPlanAutoContinuing`), an agent run is pending
    (`isAgentRunPending`), the session is not idle, or the session has no UI
    (print/JSON runs have no next turn). One compaction at a time
    (`compact_in_flight`, cleared by Pi's always-invoked `onComplete`/`onError`,
    `session_compact`, and `session_shutdown`). A dismissed Plan Review with no
    follow-up turn re-arms the check (after `showPlanReview` returns
    `undefined`/`copy`) because the overlay suppressed the settle check. Never
    trigger it mid-run, never call it from a render closure, and never add a
    second threshold check or a competing reserve constant.
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
  on compact success. Ember-owned compaction (`compaction-prompts.ts`,
  `stack-compaction.ts`, `compaction-wiring.ts` SSOT) runs on every
  `session_before_compact` (parent + subagent) and produces the structured
  checkpoint (`## Goal`, `## Progress`, `## Next Steps`,
  `<read-files>` / `<modified-files>`). Pi injects that checkpoint into LLM
  context after compact(). **Uncapped summarizer:** Ember never sends an output
  cap of its own: `summarization_max_output_tokens` in `stack-compaction.ts`
  returns the model's own output limit, or `undefined` (the field is omitted
  from the request) when the model declares none — never Pi's
  `min(0.8 * reserveTokens, model.maxTokens)` formula, which stopped generation
  mid-checkpoint (the checkpoint lost `## Next Steps` / `## Critical Context`).
  `summarization_output_reserve_tokens` keeps that allowance for input
  budgeting only, so the summarizer still sees the full discarded history.
  A `length` stop — the provider's own generation ceiling, which Ember cannot
  raise and which Codex never even receives as a request field — is resumed
  instead of failing `/compact`: `generate_history_summary` appends the partial
  text and re-prompts with `SUMMARIZATION_CONTINUE_PROMPT` (up to
  `SUMMARIZATION_CONTINUE_MAX` passes, each sending only the partial checkpoint
  rather than the discarded history, so the continuation keeps the largest
  available output room) until generation ends naturally. `summarization_failure`
  remains the single owner of the failure message and is consulted only after
  the continuation budget is exhausted or a pass adds no text, so a truncated
  summary is still never persisted as a session checkpoint. **No split-turn pass:** Pi's native
  split-turn
  concept (a second LLM call emitting a `**Turn Context (split turn):**` /
  `## Original Request` / `## Early Progress` block when the cut point falls
  mid-turn) is deleted from the Ember path. `run_stack_compaction` folds any
  `turnPrefixMessages` into the single main `messagesToSummarize` pass — one
  Ember summary covers everything, the checkpoint's `## Progress` / `## Next
  Steps` already tells the model what's left to do, and `compaction-wiring.ts`
  fail-soft must never let Pi's native `compact()` run or that garbage block
  is emitted. The wiring skips Ember compaction only when
  `modelRegistry.getApiKeyAndHeaders` returns `ok: false` — a headers-only
  result (env/command-configured key, no `apiKey`) still runs Ember's
  summarizer, because the canonical runtime resolves the key itself and Pi's
  native path would add the split-turn block and throw on a `length` stop.
  is emitted. Never reintroduce a `TURN_PREFIX_SUMMARIZATION_PROMPT` or a
  second summarization call. The continue message is a short non-duplicating
  resume directive built by `build_auto_continue_content` (SSOT) — it does NOT
  re-paste the compaction summary; it tells the model to resume from
  `## Next Steps` and not redo `### Done`. Never duplicate the suppression
  flag, the resume logic, the compaction prompts/runner, or the continue-content
  builder in other plugins. Pure helpers SSOT:
  `plugins/pi-custom-agents/auto-continue.ts`.
- **Bash safety rules:** `pi-custom-agents` reads `bashRules` from
  `~/.pi/agent/settings.json` (global) with optional project override in
  `.pi/settings.json` when the project is trusted. Each entry is
  `"<pattern>: ask|allow|deny"` (e.g. `"git checkout: ask"`). On `tool_call`
  for `bash`, the first matching pattern wins; `deny` blocks immediately.
  `ask` opens the shared `askQuiz` menu from `quiz-tool.ts` (same Plan
  Review overlay): `Execution` (run once), `Allow` (run and stop asking for
  that pattern this session), `Deny`, plus the automatic custom `None`
  option. Parser, matcher, and quiz wiring live in
  `plugins/pi-custom-agents/bash-rules.ts` — never duplicate this logic
  elsewhere.
- **Bash default timeout:** `plugins/pi-custom-agents/bash-timeout.ts` sets
  `bash` `tool_call` timeout via `resolve_bash_timeout_seconds` (SSOT):
  missing/invalid → `DEFAULT_BASH_TIMEOUT_SECONDS` (1200s / 20 min);
  legacy `600` is upgraded to 1200; other explicit values are preserved.
  Never duplicate bash timeout injection elsewhere.
- **Repeated tool-call guard:** `pi-custom-agents` tracks consecutive identical
  tool name/argument signatures across turns. After three repetitions it aborts
  the stream and auto-retries once by injecting the hidden `pi-agents-loop-retry`
  message ("Stop looping. Call a different tool and continue."). If the loop
  persists after auto-retry, it notifies the user with the active model name and
  uses the shared quiz UI with `End stream`, `Retry`, and the automatic custom
  `None` option. A manual Retry injects the same hidden message; a custom None
  answer is injected as hidden guidance. Tracking resets at each agent run, on
  normal completion, and session shutdown.
- **Hierarchical AGENTS.md auto-loader:** `agents-md.ts` (SSOT, wired from
  `index.ts`) discovers nested `AGENTS.md` files under the session cwd as tools
  touch their directories and appends their instructions to the model's context
  EXACTLY ONCE at discovery time via a persisted hidden `sendMessage`
  (`customType: "pi-agents-md-instructions"`, `display: false`). The message
  participates in session history and LLM context without re-injection on
  subsequent user messages or new requests. Per-path content-hash
  `delivered`-set tracking ensures each file is sent once; content changes
  trigger exactly one re-delivery with the new hash. `session_start` seeds
  the delivered set from existing session history so a resumed session does
  not re-deliver files already present. Pi natively loads the project-root
  AGENTS.md, so the root file is never re-injected; the loader only activates
  files below it. Activation is shallow → deep per directory walk with a
  deterministic first-activation order per session, so directory-local
  precedence comes from ordering (deeper files append after shallower ones)
  and parent instructions remain active after the model changes modules. Paths
  derive from `read`/`edit`/`write`/`grep`/`find`/`ls` (`path`, `file_path`,
  `filePath` aliases), bash (heuristic `cd <dir>` / `cd -- <dir>` plus
  absolute/dot-relative operands only), and `apply_patch` (shared `parse_patch`
  envelope parser). Resolution is filesystem-real: relative paths resolve
  against the canonical root, `..` is normalized, symlinks are realpath'd
  (existing symlinks cannot escape; a nonexistent create target is judged
  through its nearest existing ancestor), and outside-root targets are
  rejected. Content is cached by stat signature (mtime:size) with a content
  hash; `tool_execution_end` rescans the touched dirs, updates/drops edited,
  created, or deleted files, and delivers new or changed files; a
  prune-missing safety net drops files removed by any means. Each block is
  delimited as
  `<agents_md path="relative/posix/path">
...
</agents_md>`, one
  `sendMessage` per file in activation order. `session_start` captures
  `ctx.cwd` and seeds delivered state from history; `session_shutdown` clears
  all loader state under Pi jiti semantics. Tests:
  `test/agents-md.test.ts` (temp-dir fixtures covering root exclusion,
  hierarchy order, `..`/outside rejection, multi-path, symlink escape,
  create-parent resolution, reload/delete, append-once delivery,
  content-change re-delivery, resume seeding, and no-context-handler
  contract).
- Thinking blocks are shown/hidden through the built-in thinking-toggle
  keybinding, preserving Pi's native behavior.
- `/model` and `/resume` picking is owned by `pi-ember-ui/model-picker.ts`: it
  intercepts the editor `handleInput` / `submitValue` / keybindings
  **without** `registerCommand` (registering a built-in name like
  `resume`/`model` conflicts and surfaces under Extension issues). Bare
  `/model`, `app.model.select`, and `pickModelInEditor()` open the Switch
  Model UI (`model-selector.ts`) as a **bottom-anchored** full-width overlay
  on the chatbox region (not screen-center; editor-replacement races Pi
  submit/clear and collapses the chatbox): same-provider baked effort variants
  collapse into one family (`model-families.ts` / `model-variants.ts` SSOT)
  with an Effort slider (`low`/`medium`/`high`/`xhigh`). Hybrid apply —
  sibling catalog id when variants are separate entries, otherwise
  `pi.setThinkingLevel()` when the base model exposes `thinkingLevelMap` or
  reasoning capability via `getSupportedThinkingLevels`.
  Exact `/model provider/id` still calls `pi.setModel()` immediately.
  `/resume` (and `app.session.resume`) stays chat-pill autocomplete with a
  sticky `switchSession` capture from `ExtensionRunner.bindCommandContext`
  (`pi-ember-ui/command-context-capture.ts` SSOT — also captures `newSession`
  and is reused by plan-fresh-session; unbind does not clear prior handlers).
  Each
  `session_start` re-binds from the live runner's `createCommandContext()`.
  **`/resume` session catalog is built off the picker path and answered from
  memory** (`pi-ember-sessions/session-index.ts`, SSOT; `model-picker.ts` owns
  only the `(cwd, sessionDir)` key and the picker UI): reading every session
  file in the project dir with Pi's parser costs ≈0.85 s of main-thread work and
  keeps ~5 MB of conversation text (340 sessions / 304 MB here), so the catalog
  is warmed in the background at `session_start` (`bind_model_picker_session`
  primes; the scan never blocks startup), revived from the compact
  per-project `PI_HOME/cache/sessions/` cache for instant cold starts, and
  re-read only past the bytes it has already consumed (a cold pass over 340
  sessions costs ≈0.18 s of background read and every later pass ≈2 ms plus the
  turns you appended). Every hit — opening `/resume`, typing in its search
  box, submitting
  `/resume <ref>` — is answered immediately from memory or the index and NEVER
  awaits the scan, not even the first one of a process; the picker repaints when
  a background scan publishes (`subscribe_session_catalog`), and the catalog is
  keyed by `(cwd, sessionDir)`, so a switch into another project never serves
  the old dir's list. It stays warm across session replacement and is never
  reset on `session_shutdown`. Never reintroduce a forced re-list, an awaited
  rebuild, or a second parser on the picker path; the per-session
  fuzzy-search corpus is memoized in a WeakMap for the same reason.
  When capture is temporarily missing, `/resume` falls back to the editor's
  native `submitValue` (per-instance, not the slash intercept). Session
  completions via `ctx.ui.addAutocompleteProvider`. Selection with
  Enter or Tab commits immediately; a slash command with an argument
  auto-submits, while bare `/model`/`/resume` Tab-picks open the chatbox UI or
  resume argument picker. Directory completions ending in `/` or `"/` are
  skipped so path expansion can continue. Without `pi-ember-ui`, Pi's
  built-in overlay selectors still work. `/subagent-model` reuses
  `pickModelInEditor()` with the same Effort slider as `/model`; picker
  effort is SSOT for subagent `thinking:` frontmatter (no separate
  thinking-level select menu).
 - **Structural UI updates:** Slash/autocomplete collapse, thinking-block
   toggles, and compact-group settling update Pi's component tree and issue a
   normal public render request after the mutation. No Ember helper renders
   synchronously, paints rows, clears the screen, or maintains viewport/high-
   water bookkeeping. Pi's own differential path handles all resulting line
   growth and shrink.
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
  exits and clears the editor; backspace on empty exits. Enter on empty command
  exits shell mode without submitting. Enter on a non-empty command calls
  `submit_shell_command_from_editor()` (SSOT in `shell-mode.ts`): prepends `!`,
  runs `submitValue()` (Pi's built-in `!` bash handler), clears the editor, and
  consumes Enter so the chatbox empties while bash runs. The `isShellMode`/
  `setShellMode` flag lives in
  `pi-ember-ui/mode-colors.ts` (SSOT, stored on `globalThis` via
  `Symbol.for("pi-ember-ui:shell-mode")` so it survives jiti module
  duplication); the footer reads it (and `isUserBashRunning()`) to display
  "shell", and the editor border uses `MUTED_COLOR` while shell mode or agent
  runs are pending. While user `!` bash is **running** (`isUserBashRunning`/
  `setUserBashRunning` in `mode-colors.ts`, driven from `installBashExecutionPatch`
  in `pi-ember-ui/index.ts`), the chatbox integrates with the bash block:
  editor border is 50% dimmer (blend toward `PAGE_BG`), inner pad gains +1 col
  per side, the editor bottom horizontal rule is hidden, and the bash transcript
  drops its bottom rule with content indented to align (`format_ember_bash_transcript_lines`
  SSOT). On completion/error/cancel the bordered “pop out” layout returns.
  **Instant Running + message queue (`pi-ember-ui/bash-queue.ts` SSOT):** the
  patched `InteractiveMode.handleBashCommand` creates the `BashExecutionComponent`
  and paints the gradient `• Running` synchronously on submit — before the
  `user_bash` extension hook resolves — so the row never waits behind async
  handlers (Pi's original awaits `emitUserBash` before creating the row). The
  reimplementation mirrors Pi's flow with component creation reordered; it
  cannot delegate to the original because the original constructs a second
  component after the await. While `isUserBashRunning()`, a TUI input listener
  (`install_bash_queue_input_listener`, installed per `session_start` alongside
  the shell listener) intercepts submit on a plain message — non-`!`, non-`/`
  (`should_queue_bash_message` SSOT) — and queues it via
  `queue_bash_message` (editor clears, history records, a dim
  “Queued message for after bash finishes” status row appears, `{ consume: true }`
  so the editor never submits). `!` submits fall through to Pi's
  already-running warning; `/` slash commands run immediately (UI actions, not
  chat). On bash completion (success/error/cancel/replacement result)
  `flush_bash_queue` drains the queue through Pi's normal submit path
  (`onInputCallback` when the agent loop awaits input, otherwise
  `pendingUserInputs`). The queue lives on `globalThis` via `Symbol.for`
  (jiti-safe) and is cleared in `session_shutdown`. Never duplicate the
  queue predicate, the drain, or the instant-row reimplementation in other
  plugins.
- Resolves bundled definitions from `import.meta.url`; never use an absolute user
  home path or a Windows-only source path.
- Contains the vendored subagent implementation and bundled `.md` agent definitions.
- Agent requests resolve through the single `subagent/extensions/agents.ts`
  `resolveAgent()` helper; names are case-insensitive and surrounding whitespace
  is ignored, while the resolved frontmatter name is used for display and threads.
- **Subagent rendering:** The `subagent` tool uses `renderShell: "self"` and
  renders every agent as a **direct per-agent block** — there is no visual
  `Subagents`/`Delegating` group header and no cross-call batching. Every
  single-mode call, and every member of a native parallel/chain call, renders
  through the one `buildSubagentLayoutComponent`/`renderSubagentLayout` path
  (`render.ts`): bullet + name + status suffix + frozen elapsed, then the
  agent's nested latest-tool / Thinking / live-output tray rows. Running agent
  names use `theme.fg("text", …)`; completed and failed agent names use
  `theme.fg("dim", …)`. Completed agents use green bullets and failed agents
  use red bullets (SSOT `statusBulletColor` from `pi-compact-tools`).
  **Spacing contract:** exactly one blank terminal row separates visible
  agent blocks — the string renderer joins blocks with one `\n\n`, and the
  component builder inserts one `Spacer(1)` between members with no extra
  top/trailing padding inside the multi-member component. Separate subagent
  tool calls each retain Pi's one native leading separator (the
  `subagent-render-spacing.ts` separator-stripping patch is gone — every call
  is its own owner, so Pi's self-shell padding applies uniformly). Pending
  chain members remain hidden until they start.
  **Per-agent elapsed time:** each done agent (single mode, and every
  terminal member of a parallel/chain call) appends a dim frozen elapsed
  suffix (` 12s`, ` 2m 26s`) after its ✓/✗ so the user can see how long each
  subagent took. The value is the member's own tool-call duration frozen at
  `markSubagentTerminal` (SSOT in `subagent-timing.ts`, same
  `formatElapsed`/1s threshold as Thinking); running and delegating members
  never show a live timer, and there is no batch-max suffix (no header).
  Per-row placement is gated at the call site
  (`addAgentBlockToContainer`/`renderAgentBlockString` pass `elapsedMs` only
  for terminal rows; `renderAgentLabel` never renders it for running rows) —
  never render a live ticking elapsed on subagent rows.
  Parallel/chain mode renders each task/step as its own direct block (no
  `Subagents` header, no nested child rows). No
  `⏳`, `[scope]`, or `parallel (N tasks)` labels. Chain mode only shows
  running + completed steps (pending steps hidden until they start).
  `subagent-group.ts` `SubagentGroupRenderer` is now a **per-call record
  store** (SSOT): `register()` keeps one `SubagentCallRecord` per
  `toolCallId` (args, live results, display name, invalidate target) and
  never groups or batches calls; `seed_subagent_renderer_from_branch`
  restores those records before Pi rebuilds. Never reintroduce cross-call
  batching or a shared header in providers.
  The completed/failed bullet logic reuses `statusBulletColor` from
  `pi-compact-tools/renderer.ts` — never duplicate it. Failed rows append
  the real failure reason inline next to the agent name in `theme.fg("error", …)`
  (single ANSI-aware, width-truncated row); the reason is resolved once by
  `resolve_failure_message` in `runner.ts` (SSOT) from the most specific
  `errorMessage` across the top-level result and the last assistant message
  (a specific provider/transport reason always beats a generic
  parser/abort message regardless of arrival order via `merge_failure_message`
  — never overwrite a specific error with a later generic one), then
  `stderr`, or the last assistant text output. pi-ai's generic
  stream-parser failures (`Stream ended without finish_reason`, `<provider>
  stream ended without a terminal event`, …) carry no underlying
  cause/status/body and are retained verbatim with the explicit
  `PARSER_STREAM_ERROR_LIMITATION_SUFFIX` note (never replaced by a
  fallback, never silently dropped); `extractFailureMessage` walks the
  Error.cause chain root-first so a specific error buried under a parser
  wrapper still surfaces. The runner's post-run
  finalization only rewrites the message on actual failures
  (`isFailedResult`); a successful stop with no `errorMessage` is never
  force-marked failed. Provider errors that arrive on `agent_end`/`turn_end`
  (not a normal `message_end`) have their `stopReason`/non-generic
  `errorMessage` pulled into the result so they are never dropped. When a
  failed run has no resolvable reason the finalization always sets a concrete
  stopReason-based message (`Subagent timed out after Ns`, `Subagent aborted`,
  `Output limit reached`, `Subagent failed`) — a failed result must never
  leave the TUI row as a bare `✗` or degrade the orchestrator tool result to
  an unhelpful `(no output)`. Timeout and parent-abort keep their specialized
  strings. Never duplicate failure-message resolution or the generic-abort
  guard in other plugins. Model-visible tool-result `content` (orchestrator
  context) uses `format_agent_tool_result_text` / `format_agent_tool_result_batch`
  in `runner.ts` (SSOT): `### [Coder A] completed\n\n<body>`. Chain
  `{previous}` substitution still uses raw `getFinalOutput()` — no label wrapper.
  TUI rows use `details` + `render.ts` separately. The subagent
  renderer uses the shared gradient clock via
  `subscribe_gradient_tick`/`unsubscribe_gradient_tick`
  with a stable per-`toolCallId` callback record (see Rebuild-safe
  invalidate rebind above). The runner owns completion through
  `session.prompt()` and disposes
  only after that promise settles; never race `agent_end` against disposal.
  **`subagent_resume`:** Continues a prior single-mode subagent by lettered
  display name (`Coder A`, `Scout B`). Checkpoint SSOT lives in
  `subagent/extensions/resume-store.ts` (`~/.pi/agent/subagent-sessions/<parentSessionId>/<originToolCallId>/`).
  `runSubAgent()` opens the persisted child `SessionManager` via
  `SessionManager.open()` and calls `session.prompt()` for true continuation.
  Resume is unavailable for parallel/chain batches and is stripped from child
  tool lists alongside `subagent`. `resolve_resume_target()` scans the parent
  branch for the lettered name and requires an on-disk checkpoint.
  **Deterministic run-record dir guarantee:** the SDK `SessionManager` writes
  its `<timestamp>_<childSessionId>.jsonl` run-record lazily on the first
  assistant message via `openSync(..., "wx")` — not at construction. If a
  concurrent `prune_foreign_checkpoints()` (foreign session shutdown) deletes
  the checkpoint dir in that window, the write throws `ENOENT` and fails the
  whole subagent run with any provider. The runner bootstraps the dir
  synchronously via `subagent_sessions_dir_for()` AND holds a live mark
  (`mark_checkpoint_dir_live`/`unmark_checkpoint_dir_live` in `resume-store.ts`)
  for the entire run. The live mark is DURABLE on disk:
  `mark_checkpoint_dir_live()` writes a `.live` marker (pid/start metadata +
  `updatedAt`) into each checkpoint dir synchronously after the dir exists and
  before the first async boundary (direct synchronous write, no rename — on
  Windows/Bun a rename over a concurrently-read marker can fail with a
  transient EPERM sharing violation), so `prune_foreign_checkpoints()` skips
  any parent whose child contains a FRESH `.live` marker even when the pruning
  process has no in-memory mark (foreign Pi process or duplicated module
  instance). The runner refreshes the marker before every `session.prompt()`
  and persists `meta.json`/`index.json` in `finally` BEFORE dropping the
  marker, so a foreign prune can never observe an unprotected incomplete
  checkpoint. Stale crashed-run markers do not leak forever:
  `is_live_marker_fresh()` treats a marker older than `LIVE_MARKER_TTL_MS`
  (6 h) as stale, the prune reaps it, and the parent becomes disposable.
  Unparseable/empty markers (a crashed mid-write) fall back to file mtime and
  are treated as live while fresh — never prune a dir whose marker cannot be
  read — then reaped once stale. Never remove the live-mark logic or weaken
  the prune guard — it is the deterministic fix for the historical
  `ENOENT ... subagent-sessions/...` failure.
  The subagent runs **in-process** on the main thread — not in a
  `worker_thread`. The runner accepts the parent's extension-facing
  `ModelRegistry` and crosses to its canonical `ModelRuntime` in
  `model-runtime-bridge.ts` (SSOT — `resolve_parent_model_runtime` /
  `is_legacy_model_registry` / `resolve_runtime_stream_simple`, shared with
  `compaction-wiring.ts`); child sessions receive that same runtime, so every
  registered provider, credential source, header, runtime override, and custom
  `models.json` entry is available without copying auth or re-registering
  providers. Never recreate child auth storage in `index.ts` or `service.ts`.
  `session.prompt()` is async and does not block the TUI
  render loop. Child sessions load a minimal extension set via
  `discoverAndLoadExtensions()`: shared Ember compaction wiring
  (`plugins/pi-custom-agents/compaction-wiring.ts` on `session_before_compact`,
  same prompts as parent via `stack-compaction.ts`). `build_subagent_settings(model)`
  enables Pi compaction (`compaction.enabled: true`), carries Ember's absolute
  auto-compaction ceiling into `reserveTokens` for the child's window, and disables
  retry, making Pi AgentSession the
  **sole overflow recovery owner**: its canonical overflow check classifies the
  resolved Codex overflow form (`stopReason: "error"` + `errorMessage` matching
  `isContextOverflow`) and runs bounded overflow compaction plus continuation
  inside `session.prompt()`, using Ember's structured stack summary through the
  loaded `compaction-wiring.ts` hook (reason `overflow`, split-turn semantics).
  The runner never catches overflow and re-prompts the task; it only keeps a
  proactive token-estimate pre-prompt guard. **Bounded WebSocket retry owns
  transient transport death** (`decide_pre_response_websocket_retry` /
  `decide_midstream_websocket_continuation` in `runner.ts`, shared
  `MAX_SUBAGENT_WEBSOCKET_RETRIES` = 5 budget and abortable [2s, 5s, 10s, 30s, 60s]
  backoff): a drop BEFORE any output rolls back to the pre-prompt anchor and
  replays the same task; a drop AFTER visible output/tool activity (mid-stream)
  NEVER rewinds the session anchor — it drops only the dead trailing failed
  assistant, resyncs the agent transcript, waits out the backoff, and re-prompts
  once with `SUBAGENT_CONTINUE_PROMPT` so a minute of completed work is never
  thrown away and the stream is never terminated on a transient socket error.
  The SSOT retry-eligibility predicate is `is_transient_transport_death` in
  `runner.ts`: it covers WebSocket-class errors (socket reset / hang up /
  websocket diagnostic), parser stream closures (`is_parser_stream_error` —
  "Stream ended without finish_reason", provider closed the SSE stream before
  a terminal event), AND explicit abort phrases (`isGenericAbortMessage` —
  "request was aborted", "request aborted", "operation was aborted", …), AND
  provider-side internal errors (`is_provider_internal_error` —
  "an internal error occurred (trace ID: …)", a transient 500-class failure
  from Cognition/Devin and similar providers), AND pi-ai's resolved
  OpenAI-compatible `network_error` finish reason ("Provider finish_reason:
  network_error"), AND aggregator/gateway upstream-outage envelopes
  (`"type":"server_error"` + "Upstream request failed" — transient even when
  the gateway wraps it in an HTTP 400 body; ordinary client-side 400s never
  match). The enriched permission-denied
  form produced by `devin-auth` ("Cognition denied this request …") is
  intentionally NOT matched — that is a permanent tier/permission error, never
  retried. The abort class is safe because both retry decision functions gate
  on the `aborted` flag FIRST — by the time the predicate classifies, neither
  the parent signal nor the idle timeout fired, so the abort came from the
  provider/network, not the user or a timeout. Never duplicate this policy in
  other plugins or widen it beyond transient transport-death patterns. Never
  hardcode model or provider names in the subagent runner — resolve the
  model from the parent context and let the inherited registry provide
  the API provider.
  All agent blocks (running, completed, failed — single and every
  parallel/chain member) are transparent — no `subagentBg` background and no
  group header row. Completed/failed agent
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
  When thinking blocks are visible (`!isThinkingBlocksHidden()`), a running
  subagent renders its live child activity directly below the agent name via
  `SubagentLiveOutputText` (a multi-line `Component` defined in `render.ts`),
  replacing the single latest-tool / `│ Thinking` preview row. Visible child
  reasoning is a chronological Markdown sibling of compact tool bursts, built
  only through `create_live_thinking_markdown` in `pi-ember-ui/index.ts`
  (the canonical CachedMarkdown/live-theme/thinking-style pipeline): never
  split it manually, render it as Text, or create a per-subagent Markdown
  theme patch. Adjacent visible thinking items coalesce as Markdown paragraphs
  only until a tool or text boundary. Empty thinking markers never gain a tree prefix; internal Markdown
  paragraph blanks stay on the tree as `treePrefix + │` pipe continuation rows
  so the vertical branch never visually breaks mid-segment (only trailing
  blanks past the last visible header remain unprefixed). When blocks
  are hidden, a running subagent shows only ONE single row below the agent
  header: the latest tool call row (`  │[Tool]`), the gradient Thinking row
  (`  │Thinking [elapsed]`), or the transient gradient Finishing row
  (`  │Finishing`). `childPrefix()` in `render.ts` is their SSOT (flush
  1-column `  │`, no trailing space) and they are painted with
  `paint_tree_pipe()` like every other tree pipe. Child `agent_end` sets the transient `SubAgentResult.isFinishing`
  state; `agent_start`/`turn_start` clear it for retries and follow-ups;
  `agent_settled` clears it authoritatively. It is status-only, not a
  `liveItems` entry, so retained explicit child thinking cannot be evicted;
  visible parent thinking blocks never render Finishing.
  The tray reuses the main agent's `pi-compact-tools` row formatters and
  `WORK_GROUP_KEY` grouping state, but keeps its own BOUNDED wave folding: the
  chronological `liveItems` buffer splits at visible assistant text and, in
  visible-thinking mode, at visible reasoning (each is a hard transcript
  boundary, like the main agent's `noteVisibleText()`). Each compact tool
  burst renders a unified header via the SSOT `formatUnifiedWorkHeader`
  (past-tense `Edited N files, Explored M files, …
  +N -N` summary once any member completed, present-tense
  Exploring/Editing/… while everything is still running) with the shared
  `groupBulletColorFromFlags` bullet — but ONLY when the current wave has
  2+ tool rows. A single search/edit/read/write/bash/patch is a bare
  standalone compact row via `formatStandaloneCallRow` (same
  `records.length > 1` threshold as the main conversation's
  `renderCallInner`), with the leading `•` bullet stripped because the outer
  tray branch already marks the block: no `Explored 1 file` header for one
  call. The tray is a live preview capped at
  `SUBAGENT_LIVE_OUTPUT_MAX_ROWS`, so within a multi-call burst only the
  latest child remains visible and each new call absorbs the previous child
  into the aggregate header (`currentWaveRows` retains the full record history
  for stats and rebuilds). The main transcript uses the same rule — each new
  call absorbs the previous child into the aggregate header — so the tray and
  the main renderer stay consistent.
  Child rows reuse the SSOT
  `merge_group_child_rows` + `formatGroupChildRows` formatters (gradient
  verbs while running, muted past-tense when done, merged same-file
  `edit`/`write`/`apply_patch` rows with accumulated `+N -N`). Only
  hidden-thinking mode paints the in-group `│ Thinking` lane (shared 20 FPS
  gradient clock) after the child's latest tool wave; visible reasoning is
  never a compact tool child. The lane is in-flight reasoning and keeps the
  bare vertical pipe; a grouped tray child row keeps that same `│` whether it
  is running or completed (the shared `format_compact_group_child_prefix`
  pipe-only SSOT — there is no `└` corner). When the in-group lane is painted under a tray
  work segment, the prior tool child collapses (the lane replaces it) and any
  earlier completed children stay as bare `│` continuations. The tray sets `group.thinkingChild` before
  `buildGroupStaticText` so the SSOT show_thinking path derives those
  prefixes exactly like the main renderer (production keeps
  `isThinkingBlocksHidden()` true whenever the tray is in hidden mode). Streamed assistant messages
  (narration between tools or the streaming answer) render as plain
  `theme.fg("text", …)` lines, ANSI-aware truncated via `truncateToWidth`,
  capped at `LIVE_TEXT_MAX_LINES` (6) per block and
  `SUBAGENT_LIVE_TEXT_MAX_CHARS` (400) per block. There are no unprefixed
  synthetic spacer rows: in visible-thinking mode, every pair of adjacent
  rendered segments gets exactly one `treePrefix + │` pipe-padding row between
  them, added after empty segments are filtered, so the outer tree stays
  connected through visible thinking/text boundaries and released text never
  touches the tool rows on either side. Padding never dangles at the end, and
  hidden-thinking mode retains the compact shape above without this padding.
  A work burst closed by a hard boundary (a following visible text or
  thinking segment) folds to its summary header — `childAbsorbBefore =
  records.length`, the tray equivalent of `fold_group_child_rows` — so a
  released `│Ran …` child never lingers as a stale pipe row beside the new
  content (a single-tool burst is already its collapsed standalone row).
  Internal visible-Markdown paragraph blanks render as pipe continuation rows
  (`│`, not bare blanks) and count toward the 15-line budget; empty markers and blank-only Markdown results are omitted.
  The tray's branch glyph marks the terminal row of the LAST chronological
  segment: a trailing multi-row work block marks its group header (its child
  rows keep their own inner prefix), every other trailing segment marks its
  last visible row. Anchoring on the last group header of the whole tray instead
  stripped the pipe — and the branch line — from every row of a later segment:
  visible reasoning after a tool burst rendered as unpiped text with bare blank
  gaps, and a trailing single-tool row lost its branch glyph (2026-08-10
  regression). Every tray row up to and including that terminal row keeps the
  one vertical pipe — running and settled alike; there is no `└` terminator
  (`SUBAGENT_TRAY_LAST` is gone) and the bottom `──` rule below
  is the only completion marker. No top horizontal rule; a bottom `──` rule (via
  `chatboxBorderColor`) appears only
  when the agent settles. When more than one subagent is shown, the agent blocks
  stay continuous (`│` only) and no extra horizontal rule is inserted
  between consecutive agent blocks. The live buffer
  (`SubAgentResult.liveItems`, `SubagentLiveItem[]` — one `tool` item per
  child call keyed by its `toolCallId` so running rows complete in place
  instead of stacking a running row AND a completed duplicate, retained
  `thinking` items, plus `text` items for assistant messages) is accumulated in
  `apply_subagent_stream_event` (`runner.ts` SSOT) from child
  `tool_execution_start`/`tool_execution_update`/`tool_execution_end`,
  `text_start`, and `text_delta` events; it is bounded to the last
  `SUBAGENT_LIVE_OUTPUT_MAX_ROWS` (15) items and cleared at session start.
  The tray is gated by thinking-block
  visibility and only appears for running agents; completed / failed agents
  collapse back to the normal row. It reuses the shared 20 FPS gradient clock
  for invalidation (no new timer) and never writes directly to the terminal
  or mutates Pi's private render state. Never duplicate the live-item
  buffer, the 15-item cap, the compact-row rendering, the wave-fold rule,
  or the border logic in
  other plugins.
  The subagent extension delegates Pi's native `ToolExecutionComponent.render`
  and keeps its native leading separator for every `subagent` and
  `subagent_resume` call, so each per-agent block gets the same 1-row
  padding above as every other tool row and never sits flush against the
  previous transcript block. There is no separator-stripping patch
  (`subagent-render-spacing.ts` was removed): every call is its own owner, so
  Pi's self-shell separator applies uniformly and multi-member
  (parallel/chain) components add exactly one `Spacer(1)` between blocks
  with no extra top/trailing padding — nothing touches Pi's render scheduler
  or differential state.
- Keep read-only modes read-only through their active-tool allowlists.
  Plan and orchestrate include `SUBAGENT_DELEGATION_TOOLS`; code mode does
  not. Plan mode is Scout-only for exploration (`subagent-policy.ts` SSOT:
  `validate_plan_mode_subagent` blocks Coder and other agents in `tool_call`;
  `PLAN_SUBAGENT_AWARENESS_PROMPT` in `index.ts`).
- Owns per-mode model memory. The persisted `pi-ember-stack.json` state is the
  SSOT for the active `mode` and the `modeModels` map
  (`Partial<Record<modeId, { provider, modelId, thinkingLevel?, openRouterProvider? }>>`). Each mode
  remembers its own last user-selected model and effort variant (`thinkingLevel`
  from `/model` Effort slider or thinking-level cycle); unbound modes have no
  entry and keep the live model on switch. The legacy top-level `model` field is
  migrated once into `modeModels[persistedMode || "code"]` and deleted on write,
  so `modeModels` is the sole authority — never write a parallel global `model`.
  The optional `openRouterProvider` field stores the OpenRouter upstream provider
  slug (e.g. `anthropic`, `amazon-bedrock/us`) the user pinned via the model
  picker's second step; it is only meaningful for `provider === "openrouter"`
  bindings and is stripped by `canonical_model_identity` for any other provider
  and for the `OPENROUTER_PROVIDER_AUTO` sentinel.
- **OpenRouter upstream provider picker:** OpenRouter is a marketplace, not a
  single provider — one model id is served by multiple upstreams (Anthropic,
  Google Vertex, Azure, Amazon Bedrock, …). When the user confirms an
  OpenRouter model in the Switch Model picker, `apply_model_selection` in
  `pi-ember-ui/model-picker.ts` runs a second `ctx.ui.select` step
  (`pick_openrouter_provider`) that fetches the live upstream list from
  OpenRouter's `/api/v1/models/{author}/{slug}/endpoints` endpoint and offers
  `Auto (let OpenRouter route)` plus each upstream with its pricing and
  quantization. The chosen upstream is baked into a clone of the registry
  `Model` via `apply_openrouter_routing` (`compat.openRouterRouting = { only:
  [tag], allow_fallbacks: false }`) before `pi.setModel`, because Pi sends
  `model.compat.openRouterRouting` as-is in the request body and there is no
  per-request routing argument on `setModel`. The choice is remembered per mode
  through `ModelIdentity.openRouterProvider` and re-applied on mode restore
  (`apply_bound_model` re-bakes the routing even when the model id is unchanged
  but the upstream differs). The SSOT for path parsing, the endpoints fetch,
  routing-config construction, model cloning, live-routing extraction
  (`live_openrouter_provider`), and the per-mode preference read lives in
  `plugins/pi-ember-ui/openrouter-routing.ts` — never duplicate OpenRouter
  routing logic in other plugins. Network failures and empty endpoint lists
  fall back to Auto so the model still switches. `Ctrl+P` cycle does not run the
  provider step (it uses the registry model directly); only `/model` and the
  Switch Model overlay do.
- Binds a model to the active mode only on explicit user picks: `model_select`
  events whose `source` is `"set"` (`/model`) or `"cycle"` (`Ctrl+P`), and
  `thinking_level_select` when the user changes effort. Restore and unknown
  sources are ignored, and programmatic mode-switch `setModel`/`setThinkingLevel`
  is suppressed via the `applying_mode_model` / `applying_mode_thinking_level`
  flags so it never creates a false binding for a previously unbound mode.
  `session_shutdown` snapshots the active mode and the current `modeModels` only
  — it never binds the live model onto the current mode.
- Mode switches and `session_start` restore a mode's bound model and
  `thinkingLevel` when present and auth-configured (`modelRegistry.find` +
  `hasConfiguredAuth`, then `setThinkingLevel` for non-baked-variant models);
  unauthenticated bindings leave the live model unchanged (fail soft, no throw).
  A `mode_apply_generation` counter aborts stale async restores when a newer
  switch starts. Pi core still writes the selected model to `settings.json`
  (`defaultProvider`/`defaultModel`) and the session (`model_change` entry) on
  every `/model`, `Ctrl+P`, and `pi.setModel()`; `pi-ember-stack.json` is the
  per-mode memory on top of that.
- **`/compact-model` — custom summarizer model:** the same `pi-ember-stack.json`
  persisted state carries an optional top-level `compactModel` ModelIdentity
  (separate from `modeModels`; `writePersistedState` preserves it when the field
  is omitted and deletes it on `null`). `/compact-model` opens the Switch Model
  picker (`pickModelInEditor` + the OpenRouter upstream second step, same as
  `/model`) and binds that model — plus its effort/`thinkingLevel` and pinned
  OpenRouter upstream — to compaction instead of the session model.
  `/compact-model clear` (or `default`/`off`/`reset`) removes the override.
  `compaction-wiring.ts` owns the session-bound `set_compact_model`/
  `get_compact_model` state (re-read from persisted state on `session_start`,
  cleared on `session_shutdown`) and resolves the identity through
  `modelRegistry.find` + `hasConfiguredAuth` + `apply_openrouter_routing` inside
  `session_before_compact`; an unset, uncatalogued, or unauthenticated binding
  falls back to `ctx.model` so compaction always runs. The bound
  `thinkingLevel` is forwarded to `run_stack_compaction` as the summarizer's
  reasoning level.

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

### `pi-crof-auth`

- Owns the `crof` provider for CrofAI, a fully OpenAI-compatible API at
  `https://crof.ai/v1`. It uses the built-in `openai-completions` stream
  (`CROF_API_IDENTIFIER` in `src/constants.ts`) — no custom `streamSimple` —
  so chat, tool calls, structured outputs, and extended reasoning
  (`reasoning_content`) are handled natively by Pi. Auth is a plain API key
  resolved to `Authorization: Bearer <key>`.
- **API-key `/login`:** The provider is registered with an `oauth` block whose
  `login()` collects the key via `callbacks.onPrompt` and returns it as
  `OAuthCredentials.access`; `getApiKey` returns the same key and
  `refreshToken` is a no-op (keys don't expire). This gives `/login crof`
  without a real OAuth flow. `login_crof` (`src/cli.ts`) reuses any existing
  key from `CROF_API_KEY`/`CROFAI_API_KEY` env var or an `api_key`-type
  `crof` credential in `~/.pi/agent/auth.json` before prompting. Never
  duplicate the key-resolution order (`env` → `api_key` credential → prompt).
- **Model discovery SSOT:** `discover_crof_models` (`src/catalog.ts`) hits the
  public `/v1/models` endpoint (passing the bearer token when available) and
  caches the result; `clear_cached_crof_models()` resets it on login/refresh/
  logout. `build_crof_models` (`src/models.ts`) is the single mapping from the
  catalog → `ProviderModelConfig`: `context_length` → `contextWindow`,
  `max_completion_tokens` → `maxTokens`, `reasoning_effort`/`custom_reasoning`
  → `reasoning`, and per-million-token `pricing` (`prompt`/`completion`/
  `cache_prompt`) → `cost`. Reasoning models get `thinkingLevelMap`
  (`CROF_REASONING_EFFORT_MAP`: `off→none`, `minimal/low→low`, `medium→medium`,
  `high/xhigh/max→high`) and `compat` (`supportsReasoningEffort: true`,
  `maxTokensField: "max_tokens"` — CrofAI lists `max_tokens`, not
  `max_completion_tokens`). Never duplicate the catalog fetch or the model
  mapping in other plugins.
- Commands: `/login crof`, `/crof-status` (auth + catalog + usage probe),
  `/crof-usage` (`/usage_api/` → requests left + credit balance),
  `/crof-refresh-models`, `/crof-logout`. The extension re-primes the catalog
  on `session_start` (covering `/login` and catalog-TTL expiry) and clears the
  cache + `active_pi` on `session_shutdown`. Credentials stay machine-local;
  never commit `auth.json`, API keys, or generated credential files.

### `pi-novita-auth`

- Owns the `novita` provider for Novita, a fully OpenAI-compatible API at
  `https://api.novita.ai/v3/openai`. It uses the built-in `openai-completions`
  stream (`NOVITA_API_IDENTIFIER` in `src/constants.ts`) — no custom
  `streamSimple` — so chat, tool calls, structured outputs, and extended
  reasoning (`reasoning_content`) are handled natively by Pi. Auth is a plain
  API key resolved to `Authorization: Bearer <key>`.
- **API-key `/login`:** The provider is registered with an `oauth` block whose
  `login()` collects the key via `callbacks.onPrompt` and returns it as
  `OAuthCredentials.access`; `getApiKey` returns the same key and
  `refreshToken` is a no-op (keys don't expire). This gives `/login novita`
  without a real OAuth flow. `login_novita` (`src/cli.ts`) reuses any existing
  key from the `NOVITA_API_KEY` env var or an `api_key`-type `novita`
  credential in `~/.pi/agent/auth.json` before prompting. Never duplicate the
  key-resolution order (`env` → `api_key` credential → prompt).
- **Model discovery SSOT:** `discover_novita_models` (`src/catalog.ts`) hits the
  OpenAI-compatible `/v3/openai/models` endpoint (passing the bearer token when
  available) and caches the result; `clear_cached_novita_models()` resets it on
  login/refresh/logout. `build_novita_models` (`src/models.ts`) is the single
  mapping from the catalog → `ProviderModelConfig`: `context_size` →
  `contextWindow`, `title` → display name, and per-million-token integer prices
  (`input_token_price_per_m` / `output_token_price_per_m`, in 1/10,000 USD via
  `NOVITA_PRICE_UNIT`) → `cost`. Reasoning models — detected by id markers
  (`NOVITA_REASONING_ID_MARKERS`: `r1`, `qwq`, `qvq`, `qwen3`, `thinking`,
  `glm-z1`, `hunyuan`) in `build_novita_models` — get a `thinkingLevelMap`
  (`NOVITA_REASONING_EFFORT_MAP`: `off→none`, `minimal/low→low`, `medium→medium`,
  `high/xhigh/max→high`) and `compat` (`supportsReasoningEffort: true`,
  `maxTokensField: "max_tokens"`). Never duplicate the catalog fetch or the
  model mapping in other plugins.
- Commands: `/login novita`, `/novita-status` (auth + catalog probe),
  `/novita-refresh-models`, `/novita-logout`. The extension re-primes the
  catalog on `session_start` (covering `/login` and catalog-TTL expiry) and
  clears the cache + `active_pi` on `session_shutdown`. Credentials stay
  machine-local; never commit `auth.json`, API keys, or generated credential
  files.

### `pi-cursor-auth`

- Owns the `cursor` provider via **cloud-direct Connect-RPC** to
  `api2.cursor.sh` (`agent.v1.AgentService/Run`). No `cursor-agent` subprocess
  on the default path. HTTP/2 uses an isolated Node `h2-bridge.mjs` child
  (`src/cloud-direct/transport.ts`) because Bun's `node:http2` is unreliable
  against Cursor's API (Windows-safe).
- Architecture mirrors `pi-devin-auth`: `src/cloud-direct/` (wire, auth, chat,
  catalog, request, session, transport, **history**), `src/context-map.ts` (Pi
  `Context` → Cursor request), `src/stream.ts` (`streamSimple` native `text_*` /
  `thinking_*` / `toolcall_*` events). **Pi owns the tool loop** — Cursor native
  read/write/shell tools are rejected; Pi tools are registered via MCP exec.
  **pi-compact-tools** renders tool rows through normal Pi `tool_call`
  lifecycle (no `pi-cursor-tool` observer layer).
- Factory load registers the provider with an empty catalog first, then primes
  from stored OAuth credentials when present. Missing auth must not throw during
  extension load.
- `/login cursor` uses PKCE browser OAuth (`src/cloud-direct/auth.ts`) — not
  `cursor-agent login`. Pi stores OAuth `access` / `refresh` in `auth.json`.
  `/cursor-status`, `/cursor-refresh-models`, `/cursor-logout` own diagnostics,
  `GetUsableModels` catalog refresh, and coordinated logout + checkpoint clear.
- **Full Pi context** each turn via `map_context_to_cursor()` — messages (with
  assistant `toolCall` parts and hidden-injection filtering from `context.ts`),
  tool results, system prompt, and outbound tool schemas. **User-message SSOT:**
  `context-map.ts` uses `is_non_ask_user_message` / `extract_user_message_text`
  from `context.ts` (same rules as `build_cursor_user_prompt()`). **History
  encoding SSOT:** `src/cloud-direct/history.ts` rebuilds completed turns as
  `McpToolCall` `ConversationStep` protobuf bytes via `build_tool_call_step_bytes`
  (not native `ReadToolCall`/`ShellToolCall`). **Tool-result wire format SSOT:**
  `format_tool_results_for_cursor()` in `request.ts` wraps each pending result as
  `<tool_result tool_call_id="...">...</tool_result>` in `effective_user_text`.
  Conversation checkpoints persist per **Pi session id**
  (`ctx.sessionManager.getSessionId()`, fallback `cwd` → `"default"`) in
  `src/cloud-direct/session.ts` — never key by `cwd` alone. `/resume` resets
  mode directives but **does not** `clear_all_conversation_states()`; only
  `new`/`fork`/`startup` do. `session_shutdown` clears only the active session via
  `clear_conversation_state(get_cursor_session_key())`. **Blob SSOT:**
  `src/cloud-direct/blobs.ts` (`blob_id_to_store_key`, `store_blob`,
  `store_cursor_blob`, `lookup_blob`, `assert_conversation_blobs_present`) —
  request build and KV `getBlob` lookup must share the same hex key; never
  duplicate blob-key logic. `build_cursor_request` in `request.ts` always
  rebuilds `rootPromptMessagesJson` and `turns` from mapped Pi history:
  every `ConversationTurnStructure`, nested `userMessage`, and `steps[]`
  entry is a sha256 blob id stored in the per-session `blob_store` (never
  inline serialized protobuf bytes). `rootPromptMessagesJson` carries system
  plus prior user/assistant/tool-result JSON history blobs — Cursor uses this
  field (not `turns[]`) to build the model prompt.
  Drop stale checkpoints when referenced blobs are missing locally and **rotate
  `conversation_id`** so Cursor does not reuse server-side state for a dead
  conversation. Persist checkpoint + `blob_store` **only after a successful
  stream**; failed runs must not poison the next turn. `default` is the Cursor
  API model id for Auto routing; legacy `auto` ids map to `default` via
  `resolve_cursor_model_id` in `request.ts`. `bridge.end()` in `transport.ts` is idempotent and swallows
  `EPIPE` when the h2 child has already exited.
  **MCP exec channel deadlock prevention:** Cursor's AgentService/Run is a
  bidirectional Connect-RPC stream. When the server sends an `mcpArgs`
  ExecServerMessage, the client MUST respond with an `mcpResult`
  ExecClientMessage. After receiving `mcpArgs` and pushing tool-call events
  to Pi's queue, `handle_exec_message` in `chat.ts` sends a placeholder
  `McpResult` (`McpSuccess` with an explicit deferred-execution message,
  `isError: false`) back to
  Cursor via `send_exec_result` to unblock the exec channel. Pi owns the
  tool loop — the real result is sent in the next turn's history blobs
  (`build_tool_call_step_bytes` in `history.ts`). Every other exec case
  (`readArgs`, `lsArgs`, `grepArgs`, `writeArgs`, `shellArgs`, etc.) already
  sends a rejection; only `mcpArgs` was missing a response.
  **turnEnded handling:** when Cursor signals `turnEnded` via an
  `interactionUpdate`, the stream is finalized and closed immediately via
  `mark_stream_done` (passed as `on_turn_ended` through `process_server_message`
  to `handle_interaction_update`).
  **Debounce fallback:** if no new events arrive within `MCP_IDLE_CLOSE_MS`
  (1000ms) after tool calls and the stream is not yet done, the stream is
  closed proactively. This covers cases where `turnEnded` does not arrive.
  The `on_mcp_exec` callback has a `done` guard to ignore late tool calls
  that arrive after the stream has been finalized.
  **Native tool-call interaction updates:** Cursor also announces native tool
  calls through `InteractionUpdate` `toolCallStarted`/`toolCallDelta`/
  `toolCallCompleted`/`partialToolCall`. Pi owns the tool loop — these are
  never routed to Pi or executed (canonical tools arrive via `mcpArgs` and
  route through `resolve_pi_tool_name`/`normalize_tool_arguments` in
  `stream.ts`). `handle_interaction_update` marks them via
  `on_native_tool_call` so `saw_native_tool_call` keeps the idle-close guard
  active; the idle close now also calls `bridge.end()` so `close_promise`
  resolves and a native-only turn (e.g. native `UpdateTodos`/`ReadTodos`)
  cannot hang waiting for a result the client never sends.
- **Outbound tool schema SSOT:** `PI_TO_CURSOR_TOOL_NAME` and
  `PI_TO_CURSOR_ARG_NAMES` in `src/context.ts` (`cursor_serialize_tool`;
  covers core tools plus `apply_patch`, `subagent`, `quiz`, `task`,
  web tools, `compress`). Outbound MCP names are namespaced with `pi_ember_`
  (e.g. `pi_ember_grep`, `pi_ember_glob`) so they never collide with Cursor's
  native Read/Grep/Glob/LS/Shell tools, which are intentionally rejected.
  **Inbound mapping SSOT:** `CURSOR_TO_PI_TOOL_NAME`, `TOOL_ALIASES` +
  `normalize_tool_arguments` + `resolve_pi_tool_name` at the `stream.ts` tool-call
  boundary only — never duplicate these maps. `normalize_tool_arguments` is the
  inbound inverse of `PI_TO_CURSOR_ARG_NAMES` for every renamed tool (`read`,
  `write`, `edit`, `ls`, `grep`, `find`, `web_search`, `fetch_content`,
  `get_search_content`); without it Pi schema validation strips the Cursor wire
  name (e.g. `search_term`, `response_id`) and the tool executes with empty
  args. **Final arg normalization SSOT:**
  `finalize_cursor_tool_arguments()` in `stream.ts` (used on both streaming deltas
  and `close_tool_call`) — never parse final JSON without normalization.
- **MCP routing instructions:** `request.ts` populates Cursor's
  `mcpInstructions` with a server-level instruction reminding the model to use
  only `pi_ember_*` MCP tools. The provider identifier `pi-ember-stack` is
  centralized in `EMBER_MCP_PROVIDER_IDENTIFIER` and reused by `history.ts`.
- Mode directives prepend to the system prompt on the first turn and after Pi
  mode changes (`stream.ts`; `plan` / `code` / `orchestrate`).
- **Reasoning models:** `CURSOR_REASONING_MODEL_PATTERNS` in `src/constants.ts`;
  cloud `thinkingDelta` events forward as native `thinking_*` stream events.
- Protobuf schemas vendored from
  [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
  (`src/cloud-direct/proto/agent_pb.ts`, BSD-3-Clause, see `LICENSE`).

### `pi-ember-fff`

- Owns the Ember-owned `grep` and `find` tool registrations (override mode),
  backed by the vendored `@ff-labs/fff-node` file finder.
- Delegates compact rendering to the shared `CompactRenderer` from
  `pi-compact-tools` via `getSharedRenderer()` so the TUI stays consistent
  across all discovery tools.
- When enabled, native `grep`/`find` are excluded from `pi-compact-tools`
  registration (`excludeTools` in `plugins/index.ts`); this plugin owns
  those tool names.
- Bash `grep` commands are intercepted in `tool_call` and rewritten to
  equivalent `rg` (ripgrep) invocations via `pi-compact-tools/bash-grep.ts`
  (SSOT — `bashGrepInfo` for detection/grouping, `rewriteGrepToRg` for
  translation).
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

### `pi-ember-hashedit`

- Owns the hash-anchored `read` override, `replace`, and `undo_last_replace`
  tools. The vendored MIT license and attribution remain in the plugin directory.
- Delegates `read` and `replace` rendering to the shared `CompactRenderer` via
  `getSharedRenderer()`. `replace` is an editing member of the unified compact
  work group and shows live/final line-diff statistics when available.
- `undo_last_replace` uses a direct compact self-rendered row.
- **Parent editing-tool ownership:** the factory body calls
  `set_hashedit_owns_editing(true)` (jiti-safe `Symbol.for` flag SSOT in
  `pi-custom-agents/edit-tools.ts`) BEFORE any `session_start` fires, so every
  parent-mode `setActiveTools` — session restore, `/model` switches, mode
  switches, deferred flushes — exposes `replace` instead of `edit` via
  `resolve_parent_editing_tool_name()`. Never re-add a strip-only
  `session_start` edit filter: `setActiveTools` is an absolute replacement, so
  a strip gets clobbered by the next mode/model switch and leaves code mode
  with no editing tool. Subagent child sessions never load hashedit and keep
  native `edit` because `with_provider_patch_tool()` deliberately stays on
  `resolve_patch_tool_name()`.
- **`endpoint_only` mode (large contiguous deletions):** `replace` accepts an optional `endpoint_only: boolean` field. When true, `execPipeline` passes `skipRangeServed` to `applyEdit`, which skips `assertRangeServed` (the interior served-range stale check) and trusts only the two endpoint hashes — which are still validated for existence and uniqueness by `valEdit`. This fixes `E_RANGE_STALE` false positives on large block deletes (50+ lines) where the model has read the endpoints but not every interior line; the default served check requires every interior hash to have been shown, so it rejects such deletes even when both endpoints are correct. The `RangeStaleError` message is trimmed to the two fresh endpoint hashes + a retry hint (re-read for interior anchors OR set `endpoint_only=true`) instead of the old 100-row dump. `lastChangedLine` in `changedRange` reports the last line that differed in the ORIGINAL file (not the result), so a pure 560-line delete correctly reports `Lines 11–570 changed` instead of collapsing to the deletion point. Never use `endpoint_only` for small surgical edits where the full range was shown — the interior check catches real drift there.
- Hash computation, anchor validation, replace semantics, and undo behavior stay
  owned by the hashedit implementation; the Ember adaptation changes only its
  registration and TUI rendering seams.
- **Prefix-strip safety (`stripBarePrefixes` in `hashline/resolve.ts`):**
  `replacement_lines` must never contain a `HASH│` prefix — pass bare content
  only. The strip is the safety net for pasted read rows. An exact 3-char
  `HASH│` prefix that matches a real current file hash is stripped SILENTLY
  (the intended, safe path — warning on every edit was noise). A 3-char run
  that does NOT match a file hash is stripped with an `E_BARE_HASH_PREFIX`
  warning (risky — could be literal content). A near-miss prefix (a 2-4 char
  alphanumeric run + `│` that the exact `{3}` regex misses, e.g. a 4-char
  `P9n2│`) is also stripped + warned so a literal `│` can never leak into the
  file (the historical SyntaxError cause). `HL_FUZZY_PREFIX_RE` in
  `hashline/hash.ts` is the single near-miss regex; never duplicate prefix
  stripping in another plugin. The `replace-guidelines.md` prompt states the
  bare-content contract explicitly.
- **Quiet output defaults:** auto-read is OFF by default (`DEFAULT_CONFIG.autoRead = false` in `config.ts`, mirrored by the module-level `autoRead = false` in `index.ts`). A successful `replace` returns one confirmation line — `Successfully replaced in {path}. Added N line(s), removed M line(s). Lines X–Y changed.` — and nothing else; the model calls `read` explicitly (with offset/limit) when it needs fresh anchors. The `/toggle-auto-read` command still flips it live for sessions that want the post-edit delta diff. When auto-read IS enabled, the post-edit diff is delta-only (`genDiff` context 0): just the changed `+/-` rows with hashes, no surrounding context block and no `...` ellipsis — a two-line change returns two rows, not 40. The `RangeStaleError` and undo diff use the same delta-only mode. Never re-enable auto-read by default or restore the full-context post-edit diff — the noise was the top friction report.

### `pi-ember-sessions`

- **Session catalog SSOT:** `session-index.ts` is the only place that scans a
  session dir (through `session-record.ts`; Pi's `SessionManager.list` is the
  parity oracle in tests, never the reader on the catalog path). Consumers
  (`/resume` in `pi-ember-ui/model-picker.ts`, the fleet view, future session
  browsers) call `get_session_catalog` / `prime_session_catalog` /
  `refresh_session_catalog` / `peek_session_catalog` and share one catalog per
  `(cwd, sessionDir)` key.
- **A hit never awaits a scan.** A cold scan of a busy project (340 sessions /
  304 MB) costs ≈0.18 s in the background and every later one is a readdir +
  one stat per file (≈2 ms) plus the bytes appended since, so
  `get_session_catalog` answers in O(1) from the resident catalog, else from
  the compact on-disk index, else with an empty list while
  the scan runs behind it — it never returns the scan promise. The picker
  repaints when the scan publishes (`subscribe_session_catalog` in
  `bind_resume_catalog_repaint`), so a cold start fills its rows in place
  instead of freezing the TUI. Never reintroduce an await on the build path:
  a hit landing inside the startup parse was a measured 550 ms stall and the
  whole reason the catalog exists.
- **Per-file size/mtime decides what to re-read** (`session-record.ts`).
  session files are append-only, so a grown file is read from its stored
  `consumedSize` cursor to EOF and its record is updated in place (count, name,
  checkpoint, recent text); an unchanged file returns the very same record
  object, so a warm scan publishes nothing and the catalog keeps its array
  identity. A shrunk or same-size-rewritten file is re-read whole. Never go
  back to a dir-wide signature gate: one appended line in the session you are
  in used to invalidate every file in the project.
  `prime_session_catalog` (session start) ignores the hit-path
  `CATALOG_VALIDATE_TTL_MS` gate — a session start is exactly when a file
  changed.
- **The search corpus is bounded on purpose** (`CORPUS_MAX_CHARS` in
  `session-record.ts`): opening request + a spread sample of EARLIER USER
  PROMPTS + newest compaction checkpoints + the most recent turns, ≈0.7 MB for
  340 sessions instead of 4.8 MB of whole conversations. A compaction
  checkpoint already summarizes everything older, which is why dropping the
  pre-checkpoint bulk costs almost no searchability — measured against Pi's
  full corpus, the top hit agrees on **11 of 12** real queries, and the last
  miss ranks the oracle's top row **#2** (it was #108 before the prompt
  sample). Never parse conversation lines into the corpus: the streaming pass
  counts entries and reads only the lines that carry list data, the opening
  request is decoded inside that same pass (the line is already in hand — no
  second read), and the recent text comes from a bounded tail window parsed
  NEWEST-FIRST so it stops as soon as the window is full instead of parsing
  every chat line it contains.
- **Earlier-prompt sampling is the recall lever** (`SpreadSample` in
  `session-record.ts`). User prompts are the highest-signal searchable text —
  1.4 MB across the same 340 sessions, against 304 MB of file bytes — and they
  are the part a session list is searched for. The sampler pushes every
  candidate up to `EARLIER_USER_SLOTS` (16) and then THINS the kept set (drop
  every second item, double the stride) instead of evicting the oldest, so the
  sample keeps spanning the conversation rather than collapsing onto its end
  (which the tail window already covers). Only lines up to
  `USER_LINE_PARSE_MAX_BYTES` (16 KB) are parsed: a bigger user line is a paste
  or an image payload, and parsing them (190 of 1110 real lines, 118 MB, 1.1 MB
  of text) costs far more than their text is worth. The sample lands in
  `SessionRecord.earlierUserText`, is persisted, and is appended to the corpus
  by `build_corpus` — one owner, no second search path.
- **Pi's activity rule is duplicated exactly, never approximated**:
  `activity_timestamp()` in `session-record.ts` prefers the numeric
  `message.timestamp` (written when the message streamed) and falls back to the
  entry's ISO timestamp, because Pi's `buildSessionInfo` does. The two differ
  by seconds on long turns; using the entry stamp alone made every row's
  `modified` drift from Pi's own list (measured: 3.7-11 s across 340 sessions).
  Same for the first user message: Pi takes the first user message that HAS
  text, so an empty one keeps looking.
- **The scan core stays string-based.** One `readFile`-style chunk decode plus
  a line walk, with the entry checks as `startsWith`/`includes` on the decoded
  line. A byte-level rewrite (one `indexOf` over the raw buffer for
  `{"type":"`, `Buffer.compare` per match, `subarray` windows for role and
  timestamp) was implemented and MEASURED SLOWER — 478 ms against 261 ms for
  the same 340 files — because the needle also matches every nested typed
  object (168 k matches against 57 k entries), and per-match memcmp plus window
  allocation costs more than Bun's SIMD UTF-8 decode and per-LINE string
  checks. Do not "optimize" the reader to byte-level indexOf without
  re-measuring it end to end on a real session dir.
- **Only complete lines are applied.** A section is scanned up to its last
  newline, a trailing partial line (a write in flight) stays unconsumed so the
  next scan reads it exactly once, and a line longer than the 1 MB window grows
  the window (up to `MAX_LINE_BYTES`, 16 MB) instead of being split. A torn
  mid-line read must never be counted: the parity tests pin count/consumedSize
  across the torn-then-completed sequence.
- **Startup cache, one file per project.** `PI_HOME/cache/sessions/<hash>.json`
  holds one dir's records (row fields + the `consumedSize` cursor + the bounded
  search text), ~1.2 MB for a 340-session project, never whole conversations:
  persisting `allMessagesText` produced a 22 MB file the picker had to read. A restart answers every project
  you have opened from its own file (measured 0.7-9 ms per project, five
  projects / 1.1 MB total) and then diffs it with a readdir + stat pass, so the
  only slow moment is a project's very first scan. Index version 5; a file over
  `INDEX_MAX_BYTES` is dropped without being read. Writes are temp-file +
  rename (a killed process cannot leave a torn cache; the rename-failure
  fallback covers Windows), only DIRTY dirs are rewritten (a publish in one
  project never rewrites the others' files), and writes are rate-limited to one
  per `INDEX_WRITE_MIN_INTERVAL_MS` (5 s) — the first write of a process is
  immediate, later publishes only mark the dir dirty, and `flush_session_cache`
  (awaited on `session_shutdown`) carries the rest. Rewriting a ~1 MB file on
  every turn was pure churn: the in-memory catalog is always current and only
  the startup read uses the file. `sweep_session_cache` runs once per process at
  the first prime: it drops files older than `CACHE_MAX_AGE_MS` (14 days), trims
  the dir to `CACHE_MAX_FILES` (16) newest — always keeping the current project
  — and deletes the superseded single-file `pi-ember-sessions.json` index. In
  memory at most `CATALOG_MAX_DIRS_IN_MEMORY` (4) record sets stay resident. An
  unreadable/missing dir never publishes (an empty catalog must not overwrite a
  good one), and the catalog is NOT reset on `session_shutdown` — it is inert
  session-dir data that the next session reuses while its dir check runs.
  Display helpers (`format_session_age`, `session_label`,
  `session_search_text`) live here too — never re-implement a session row's
  age, label, or search corpus in a consumer.
- **Fleet (background conversations):** `fleet.ts` is the registry,
  `session-factory.ts` is the production runtime factory (SDK). A fleet
  conversation is a normal Pi `AgentSession` running in-process on the main
  thread — same building blocks as a subagent (`load_subagent_extensions`,
  `build_subagent_settings`, `DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS`, the
  parent `ModelRuntime` through `model-runtime-bridge.ts`) — but long-lived and
  addressable by name. Its session file is a real project session, so `/resume`
  lists it and `switchSession` opens it. Commands: `/fleet`, `/fleet new
  <name> [message]`, `/fleet send <name> <message>`, `/fleet switch <name>`,
  `/fleet stop <name>`, `/fleet forget <name>`, `/fleet list`.
- **One writer per session file:** a conversation is owned by either the fleet
  or the TUI, never both. `release_fleet_session` aborts and disposes the fleet
  runtime before `ctx.switchSession` opens the file; a session that never ran
  has no file yet (Pi defers session-file creation to the first assistant
  message) and refuses to open. Never add a path that lets the TUI and a fleet
  handle write one session file.
- **The fleet outlives session replacement:** `session_shutdown` drops only the
  parent binding; running conversations keep streaming and the next
  `session_start` revives the list from `PI_HOME/fleet.json` (read-merge-write
  of the same file the plugin registry owns, never a second state file).
  `reset_fleet({ dispose: true })` exists for tests only.
- **Render boundary:** this plugin never paints and starts no timer. The fleet
  list goes through Pi's own `ctx.ui.select`; background status lands in the
  registry and notifies subscribers (no TUI writes, no render scheduler).
  Status text is one line per session (`format_fleet_row`) — activity clears on
  settle/error so a finished run never leaves a stale `sending…`/text row.
### `pi-ember-tps`

- Owns the live tokens-per-second metric. TPS color thresholds and alpha
  blending live in `pi-ember-ui/mode-colors.ts` (`tps_color_hex`); the footer
  only formats the row and reads the shared state on natural Pi renders.
- **No periodic render clock and no fade animation.** The plugin never calls
  `request_render()`, never subscribes the shared gradient clock, and never
  starts a timer. The meter is fully visible while streaming (read by the
  footer on the natural `message_update`/`message_end`/footer-stats renders)
  and disappears on the first post-stream render once `streaming` is false
  (`getLiveTpsOpacity` returns 0 when idle). A fade was removed because its
  50ms gradient-clock subscription kept issuing `request_render()` calls for ~5s
  after the agent settled, snapping terminal scrollback/text selection to the
  top on long sessions. While the agent is settled the plugin is inert — zero
  periodic renders, zero subscriptions — so terminal scrollback stays owned by
  Pi and the terminal.
- **Aux stream driver (compaction):** summarization emits no transcript
  `message_*` events, so `stack-compaction.ts` taps the summarizer stream
  directly through `begin_aux_stream()` / `note_aux_delta()` /
  `end_aux_stream()`. The caller MUST pass a `streamFn` — the non-streaming
  `completeSimple` path exposes no deltas and leaves the meter at zero (the
  historical `• Compacting` row with no live TPS). `compaction-wiring.ts`
  supplies it from `resolve_runtime_stream_simple()`
  (`plugins/pi-custom-agents/model-runtime-bridge.ts`, SSOT) so the
  summarizer streams through the canonical ModelRuntime — the global pi-ai
  dispatcher does not see extension-registered providers — and the footer
  paints the meter on the 20 FPS renders the compaction status row already
  issues. Never add a second meter driver, render clock, or subscription.

### `pi-ember-applypatch`

- Owns the Codex-style `apply_patch` tool (envelope parse, strict hunk apply,
  workspace-root path safety, compact TUI rows).
- **Exposed only for `openai-codex` models.** Code mode and the Coder subagent
  advertise `apply_patch` + `write` only when the active provider is
  `openai-codex`; all other providers use `edit` from `pi-compact-tools`
  instead (`edit-tools.ts` SSOT). Both tools stay registered for transcript
  rendering of historical sessions.
- Prompt description / snippet / guidelines live once in `prompt.ts` — never
  duplicate prefer-patch guidance in other plugins.
- Parser (`parse.ts`), safety (`safety.ts`), and apply (`apply.ts`) are the
  single sources for envelope grammar, path traversal rejection, and strict
  context matching (Invalid Context / Ambiguous Context; no fuzzy).
- Partial success returns `ok: false` with per-path results so the model can
  recover; `isError` is set only on parse failure or when every op fails.
- Does not own compact native-tool grouping, modes, or providers.

### `pi-ember-screen`

- Owns three cross-platform desktop tools for visual verification from inside pi:
  `window_list` (enumerate visible top-level windows with process, title, size,
  pid, and handle) and `window_screenshot` (capture one window to a PNG and
  return it as image content so the model inspects a real running UI instead of
  inferring it from source). Supported on Windows and macOS.
- Scope is window discovery and pixel capture only. It does not click, type,
  or drive the desktop, owns no harness, and is not a computer-use agent.
- Registered only when `process.platform` is `win32` or `darwin`, so other
  platforms never see tools they cannot fulfil.
- **Bun owns all native work.** `helper.ts` is a Bun program spawned by the
  plugin; `platform/win32.ts` (user32/gdi32/kernel32/shell32),
  `platform/win32-wgc.ts` (combase/d3d11 plus the COM/WinRT vtables) and
  `platform/darwin.ts` (CoreGraphics) bind native code through `bun:ffi`. pi itself runs on Node and Node has no FFI,
  so the helper is a child process by design: a wedged `PrintWindow` /
  CoreGraphics call must be killable, and a blocked thread is not. Bun is
  resolved from `PI_EMBER_SCREEN_BUN` / `BUN_BIN` (then `~/.bun/bin/bun.exe`,
  then PATH) and a missing Bun fails fast with an install hint instead of
  degrading. Never reintroduce a PowerShell or per-platform shell helper.
- `index.ts` owns tool schemas, argument shaping, the exec deadline, and the
  compact row (`render.ts`); `args.ts` is the argv contract shared with the
  helper. The helper writes exactly one JSON object to stdout and keeps
  diagnostics on stderr; failures return `ok: false` with a message.
- **Capture ladder (Windows).** `capture_surface` in `platform/win32.ts` walks
  three rungs, cheapest first, and reports which one produced the pixels as
  `method`:
  1. `printwindow` — `PrintWindow(PW_RENDERFULLCONTENT)`: the owning app paints
     itself. Fast and exact, but blank for a GPU-composited surface, and it has
     no timeout variant, so a window the shell already reports as hung skips it
     (it would never answer and the call would block).
  2. `wgc` — `Windows.Graphics.Capture` via `platform/win32-wgc.ts`, which owns
     the WinRT/D3D11 FFI. DWM hands over the window's own composition surface,
     so this rung works while the window is covered by another window, is drawn
     by DirectComposition/flip-model (Qt, Chromium, WinUI), or its app stopped
     pumping messages (the last composed frame is what is on screen).
  3. `screen-copy` — a screen-region `BitBlt` for the window rect, allowed only
     while the window is the foreground window or `visible_at_center` finds it at
     its own centre point; otherwise it would return whatever is on top of it, so
     it refuses instead of lying.
  `platform/win32-wgc.ts` is the single owner of the WGC IIDs (Windows Runtime
  IDL), the ABI vtable slots (Windows SDK headers), and the Win64 by-value
  packing (`pack_int32_pair`) — never re-derive them elsewhere. `WindowFromPoint`
  and `GraphicsCaptureItem::Size` both take an 8-byte value, not a pointer: the
  packing helper is what makes `visible_at_center` correct.
  On macOS pixels come from Apple's `screencapture -x -o -l <windowid>`, which
  owns the Screen Recording permission flow.
- Background capture has one hard Windows limit: while an *exclusive-fullscreen*
  application owns the display, Windows stops composing every other window, so
  neither PrintWindow nor the compositor has a frame to hand over. The tool
  detects it with `SHQueryUserNotificationState` (QUNS_BUSY /
  QUNS_RUNNING_D3D_FULL_SCREEN), names the blocking app, and `blocker_message`
  selects the message: fullscreen owner > minimized > not responding > covering
  window, appending the compositor's own failure reason when there is one. The
  fullscreen app itself and the desktop still capture normally. Never silently
  return a screen-region copy of a covered window — refusing is the correct
  behavior.
- A window that is not responding is capturable: the compositor rung needs no
  message pump, and if DWM has already swapped the window for a ghost bitmap the
  screen-copy rung reads the ghost while the window is on top. Only a minimized
  window is a hard stop (the compositor has no current surface for it, and its
  last frame would be stale pixels presented as the live UI).
- **Pid targeting:** `window_list {pid}` and `window_screenshot {pid}` take the pid of
  a process the caller started (`myapp & echo $!`), so a window is found without
  listing the desktop or matching a title. `--pid` is part of the `args.ts` helper
  contract; `resolve_target` on both platforms resolves handle → pid → substring and
  shares one largest-visible-window ranking between pid and substring targeting, so an
  app's real window beats the tool/helper windows it also owns. A pid with no visible
  window explains itself instead of guessing: the process may have exited, its window
  may belong to a child process it spawned (an app that forks a helper), or it may be
  console-only, whose window belongs to the terminal hosting it. Never fall back to the
  foreground window when a pid was given.
- **Screenshot timer:** `window_screenshot_timer` captures one window on a
  millisecond cadence and returns every frame as a single numbered contact
  sheet, so an agent can see motion instead of one still. `sequence.ts` is the
  SSOT for the cadence, the bounds, the grid math, the sheet, and the parent's
  deadline; the loop runs INSIDE the helper process, because a per-frame helper
  spawn costs more than the interval itself. Frames are captured at contact-sheet
  tile size (the capture takes `maxWidth` = cell width): on a 3000x2000 window that
  is the difference between a 1.3 s and a ~300 ms cadence, and it makes the tiles
  exact instead of resampled twice. The cadence is a fixed schedule, not
  capture-plus-sleep, so a slow frame eats its own slot and the reported
  `offset_ms` values are the truth about when each frame was taken. The tool sets
  `executionMode: "parallel"` on purpose: the burst belongs in the same batch as
  the interaction that drives the app, which is the whole point of a timer.
  `window_screenshot_timer` is in `SCREEN_TOOLS` (and therefore `VISUAL_TOOLS`,
  code mode, orchestrate, and `DEFAULT_SUBAGENT_IMPLEMENTATION_TOOLS`). Each tile
  is labelled with its frame number — reading a grid by position alone is where
  models miscount — and the per-frame files are listed in the tool result so a
  specific moment can be opened at tile size, with `window_screenshot` for full
  resolution.
- Minimized windows are attempted rather than refused (PrintWindow usually still
  paints them) but skip the compositor rung — a minimized window has no current
  composition surface — so a blank result reports a minimized-specific message. The
  `--include-minimized` helper flag backs the `include_minimized` tool parameter,
  which the helper would otherwise filter away before the tool could honor it.
- Retina/DPI: `SetProcessDPIAware` on Windows; macOS reports the backing-pixel
  size the capture actually produced.
- Image bytes are handed to pi as `{ type: "image", data, mimeType }`; pi's
  tool-result normalization owns provider resizing, so the plugin does not
  pre-resize unless the caller passes `max_width`/`scale`.
- Image encoding is one owner: `encode.ts` maps format → encoder, extension,
  and MIME type, and both platform backends use `encode_with`. The default is
  **webp, lossless**: measured on a real 2103x1537 window capture, PNG 195KB
  vs WebP lossless 49KB with byte-identical pixels, and JPEG q90 was worse than
  both (160KB, 0.82x PNG) while smearing UI text with ringing. `png` stays
  available for consumers that need the container (some inline-image terminal
  protocols are PNG-only; pi converts non-PNG for them asynchronously). JPEG is
  opt-in and only sensible for photographic content. Never reintroduce a
  hardcoded `.png` path or a second encoder choice.
- The result MIME type must match the encoding (`format_mime_type`); the row
  shows the format only when it is not the default.
- Never bind a native call in-process or on a worker thread: a blocked native
  call cannot be interrupted, so capture stays in the killable helper process.
- Both names must also be listed in `SCREEN_TOOLS` inside `build_full_tools`
  (`plugins/pi-custom-agents/edit-tools.ts`). Registering a tool only makes it
  visible to `pi.getAllTools()`; a name absent from the active mode list is
  silently deactivated, which is what the mode tool sets in `pi-custom-agents`
  do to every unlisted tool.
- Rows use the shared compact contract: `statusBulletColor` + `BULLET` +
  `CompactGroupText` from `pi-compact-tools/renderer.ts`, returned directly from
  the render slot like a native compact row — no wrapping shell, so the bullet
  starts in column 0 with every other tool row and the row is never padded with
  leading or trailing columns. One ANSI-truncated line, updated in place from the
  result slot. Expanded detail (window rows / saved file) is for Ctrl+O only.
- `BROWSER_TOOLS` in the same file is the matching curated activation list for
  the optional third-party `pi-browser` extension (navigate/snapshot/interact/
  screenshot/console/network core). The browser storage, cookie, route, and
  raw-coordinate mouse families are deliberately left inactive: widen that list
  when a task needs them instead of activating all 50 `browser_*` tools.
- Does not own clipboard images (`pi-ember-images`), browser pages
  (pi-browser's `browser_take_screenshot`), or compact row rendering.

### `pi-ember-webtools`

- Ember-owned web tools, vendored from `pi-web-access` by Nico Bailon (MIT
  License, see `plugins/pi-ember-webtools/LICENSE`). Original source:
  https://github.com/nicobailon/pi-web-access
- Provides `web_search`, `fetch_content`, and `get_search_content` tools,
  plus `/websearch`, `/curator`, `/google-account`, and `/search` commands.
- Supports multiple search providers: Exa, Brave, Parallel, Tavily,
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
- Web-tool call/result rows use `statusBulletColor` and `BULLET` from
  `pi-compact-tools/renderer.ts` and return the `CompactGroupText` row directly —
  no wrapping `Box`, so nothing pads a column in front of the bullet. The bullet
  is the sole success/running/error state indicator; do not restore
  `toolSuccessBg`/`toolErrorBg` blocks in web-tool renderers.
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
- **Natural, concise prompts:** Mode system prompts and subagent definitions
  give clear responsibility, tool awareness, and concise directives without
  forcing artificial plain-text or labeled-line templates. Plan mode requires
  a concrete approach (quiz unresolved forks first; no Option A/B inside the
  plan; no `Open Questions:` section). Subagent definitions direct agents
  to execute work directly without process narration.
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
  (timers, `ctx`, render-intent binding, `tuiRef`, `liveTheme`, renderer caches)
  MUST reset it in a `session_shutdown` handler and rebind it in
  `session_start`. The factory body must not call into session-bound state
  before `session_start` fires. There is no `session_switch` event — use
  `session_start` with `event.reason === "resume"` instead.
  The compact renderer additionally stamps every queued microtask render
  (`debouncedGroupRenderRequest`, `scheduleRecordShrinkSnap`) with a
  `renderGeneration` counter; `resetForSession()` bumps it so a render queued
  by the old session self-cancels instead of firing against the replaced
  session's TUI. Queued invalidation sets are cleared on reset. Never queue a
  render microtask across a session boundary without a generation guard.
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

For `pi-ember-screen` changes, also drive the helper directly — it is the only
place native calls happen, and the deadline/JSON contract must hold on both
platforms:

```text
bun run plugins/pi-ember-screen/helper.ts --diagnose   # platform, bun, permission state
bun run plugins/pi-ember-screen/helper.ts --list       # JSON window list
bun run plugins/pi-ember-screen/helper.ts --match <name> --max-width 700 --out /tmp/x.webp
```

A window whose app is not pumping messages must come back marked `hung` in the
list and must fail a capture in well under a second with a 'not responding'
message — never hang. Verify that with a blocked-window fixture (a window whose
UI thread sleeps) before trusting a capture change.

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
