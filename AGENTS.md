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
- **Integrate through Pi's public seams:** lifecycle events, the live TUI's
  public `requestRender()`, component invalidation, `setHeader`, `setFooter`,
  `setWidget`, `setEditorComponent`, and `ctx.ui.custom()` overlays. A plugin
  may intercept or wrap a specific component only when it preserves the native
  owner, delegates to the original behavior, returns width-safe rows, and does
  not request rendering from a render closure.
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
  - Grouping keys (`WORK_GROUP_KEY` / `groupKey`) and groupable tool sets
    (`GROUPABLE_TOOLS`) are defined once in `renderer.ts` — never duplicate
    the membership check. All groupable tools share one work-bundle key
    (`__work__`) until a hard boundary (visible answer text, user message,
    non-groupable tool).
  - Pulse timing (`PULSE_INTERVAL_MS`), bullet-color logic
    (`statusBulletColor`, `groupBulletColorFromFlags`), and the pulse timer
    (`PulseManager`) are defined once in `pi-compact-tools/renderer.ts` — never
    duplicate pulse timing or bullet-color logic in other plugins. Tool bullets
    never pulse: `statusBulletColor` is static `muted` while running, `success`
    when done, `error` on failure; running state is shown by gradient child
    verbs (Searching, Reading, Bashing, …). The subagent renderer no longer
    uses `PulseManager`; it subscribes to the
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
  (the `+ 2` is the gutter, not pipe columns). While the agent is running
  (`agentRunPending`, from `agent_start` to `agent_settled`) or in shell mode,
  the prompt glyph and the non-slash middle separator use `MUTED_COLOR` instead
  of `TEXT_COLOR`, giving the chatbox a dimmed appearance while the agent is
  running. The border color logic for those elements is
  `(isShellMode() || agentRunPending) ? MUTED_COLOR : TEXT_COLOR`. In slash-command
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
  Thinking gradient label is NO LONGER rendered inside the editor border or
  above the chatbox — it lives inside the latest assistant message in the
  transcript (see Thinking/Summarizing status below). Pi owns the editor fake
  cursor, hardware cursor visibility, and cursor blink timing.
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
  instead of slowing the animation. Each tick updates component state through
  stable subscribers; each subscriber owns its own `requestTuiRender()` /
  `invalidate()` — the clock never issues a blanket render after every tick. It
  never writes terminal rows, mutates differential state, or schedules a
  parallel renderer. When the agent is settled and no gradient animation is
  visible, the clock must stop entirely — zero periodic `requestRender` calls.
  **Binding a Thinking host (`bind_thinking_widget_host`) must not subscribe the
  clock** — only `sync_thinking_gradient_clock()` → `sync_thinking_status_tick()`
  may subscribe/unsubscribe. Trackpad scroll uses terminal scrollback; Ember
  must not intercept scroll input or repaint the live viewport while the user
  reads history. Do not re-anchor on slash/autocomplete exit or idle lifecycle
  events. Structural changes (show/hide Thinking, group settle/collapse,
  mode switch) update the component tree and use the same normal native
  request. Off-screen startup visuals are static. The
  sweep cycle is `GRADIENT_DURATION_MS` = 1600 ms (20%
  faster than the original 2 s); the logo round-trip is
  `LOGO_DURATION_MS` = 3200 ms. The sweep uses an offscreen-to-offscreen
  Gaussian center (`compute_sweep_center`) with unified edge padding
  (`EDGE_PADDING` = `Math.ceil(3 * GRADIENT_SIGMA)` = 9 cells) for all
  presets — no preset-specific padding branching — ensuring the Gaussian
  fully exits before the phase wraps, preventing visible snap-restart on
  short labels. No circular wrap. The accent palette is a 3-stop
  RGB-space blend (DIM_COLOR base → 50% toward accent → accent peak) with a
  per-generation RGB cache — no per-char hex parsing. The thinking palette is
  the same 3-stop shape with `TEXT_COLOR` as the peak (no live accent). Semantic presets
  (`thinking`, `working`, `exploringGroup`, `workingGroup`, `subagent`)
  reference shared base palette definitions; `thinking` uses the dim→text
  palette, `working`/`subagent` share the accent palette, `exploringGroup`/`workingGroup` share the
  muted→text palette. `renderLiveGradient(text, preset)` drives the
  Thinking/Summarizing status label, subagent running-agent labels, and
  compact group child rows. The Pi logo remains static because it may be above
  the live viewport; it renders as a static 2-stop vertical gradient
  (top muted `#808080`, bottom text `TEXT_COLOR` from `mode-colors.ts`) with
  a box-drawing drop-shadow contour (`─│┌┐└┘├┤┬┴┼` glyphs at 25% opacity,
  offset one cell down and right).
  `session_shutdown` is the safety floor. `PULSE_INTERVAL_MS` and
  `PulseManager` remain exported from `pi-compact-tools/renderer.ts` for
  rebuild-safe invalidate wiring; compact tool bullets do not pulse. The
  subagent renderer subscribes to the shared gradient clock via
  `subscribeGradientTick`/`unsubscribeGradientTick` from
  `pi-ember-ui/index.ts` (re-exported from `gradient.ts`). The clock
  dispatches a stable snapshot of subscribers each tick — callbacks added
  or removed during dispatch are not visited until the next tick, preventing
  same-tick re-addition loops.
- **Thinking/Summarizing Status & Tool Group Precedence:** The live
  gradient `Thinking` label uses a dual host via `resolve_thinking_status_host()`
  (mutually exclusive — never widget + in-message together): the in-message
  `ThinkingStatusComponent` under the latest assistant message owns the pre-tool
  wait directly below the user row once the assistant bubble exists; the
  above-editor `ember-thinking` widget owns post-tool inter-run gaps. There is
  no `Working` label. `installAssistantMessagePatch` creates a
  `ThinkingStatusComponent` per assistant message and binds it to the message's
  timestamp. A module-level `latestAssistantMessageTimestamp` is updated from
  `message_start`, `message_update`, and `message_end` (and from the patched
  `updateContent`) so only the most recent assistant message renders the
  in-message label. The render path is O(1): it reads `thinkingActive`,
  `agentRunPending`, `isThinkingBlocksHidden()`,
  `isQuizActive()`, `isToolGroupActive()`, and `isLatestSubagentRunning()`.
  It is suppressed when a quiz overlay is active, when a compact tool group
  has a **running** member (`isToolGroupActive()` — lingering completed
  children alone no longer suppress), when the latest tool call is a running
  subagent, when thinking blocks are **visible** (`!isThinkingBlocksHidden()` —
  the transcript owns reasoning; external header is always suppressed), or when
  in-group `└ Thinking` owns the slot (`isGroupThinkingChildActive()`). Nested
  subagent `└ Thinking` rows are separate (`render.ts`) and still paint while
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
  the external in-message / above-editor host via
  `arm_pre_token_thinking_status()` — it never folds compact child rows.
  `clear_blockers` runs on visible user `message_start`, `session_compact`,
  and `compaction_end` transcript rebuild (`reconcile_thinking_after_transcript_rebuild()`).
  In-group `└ Thinking` is painted via `noteThinking()` on a real
  thinking stream (`message_update` → `apply_assistant_stream_boundary` in
  `assistant-stream-boundary.ts`, SSOT) — it appends after lingering tool rows
  without folding them. Inter-run planning `text_delta` arms
  Thinking via `reconcile_thinking_wait_ui()` without folding children.
  When the last subagent finishes (`tool_execution_end` for `subagent` with no
  remaining subagent activity), `reconcile_thinking_wait_ui()` runs so the
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
  tools are idle and the SSOT wait predicate holds, the in-message component or
  above-editor widget shows gradient `Thinking` and lingering tool child rows
  stay visible. When a thinking or inter-run planning stream arrives (blocks
  hidden), `noteThinking()` appends in-group `└ Thinking` after lingering tool
  rows and suppresses the external widget.
  `resolve_thinking_status_host()` prefers in-message whenever
  `assistantThinkingHostReady`, not only during the pre-tool gap. Child rows
  are folded only via `fold_group_child_rows()` on a genuinely new tool wave
  (`appendToGroup`) or a hard boundary — never on thinking, todo, bare
  `tool_execution_end` / tool success, or Pi `turn_start`. Same-key batches reopen the latest
  settled group (`findReopenableGroup`) instead of spawning another
  `Explored`/`Edited`/… header. Each Thinking pass resets
  `thinkingPassStartedAt` and shows a dim live elapsed suffix after 1s (widget +
  in-group `└ Thinking`); total turn time still notifies once on `agent_settled`.
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
  to stay — `agent_end` is not the end of the user's task. When the group
  settles (visible user-facing text, a thinking stream, a non-group or
  different-group tool, a user message, or `agent_end`), child rows collapse to
  the header. Thinking streams always soft-settle the active group (collapse
  linger so the `Thinking` status can appear) even when thinking blocks are
  hidden; when blocks are hidden the live `currentGroup` is kept so the next
  same-key discovery/action call reopens that header instead of spawning
  another `Explored`/`Edited`/… row. **Inter-run planning text** (non-empty
  `text_delta` while `isInterRunGap()` — `agentRunPending`, no tool in flight,
  tools already on screen this turn, e.g. OpenAI/Codex between tool batches) is a
  **soft** boundary: inter-run planning `text_delta` arms Thinking without
  folding; inter-run non-planning text uses `noteVisibleText()`. **Final answer text**
  (`text_delta` outside the inter-run gap) remains a hard boundary
  (`noteVisibleText()`). **`thinking_delta` with blocks visible** hard-exits the
  work group (`noteVisibleThinking()`) so the next tool wave spawns a fresh
  header downstream; hidden blocks use in-group `└ Thinking` via `noteThinking()`.
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
  `text_delta` is skipped during the inter-run gap so gradient Thinking can show
  between Codex tool batches. `thinkingBlocksHidden` syncs from session settings
  on `session_start` and from `setHideThinkingBlock` (Ctrl+T) before the first
  assistant `updateContent`. `Ctrl+T` (show/hide thinking blocks)
  rebuilds the chat and can change the transcript line count — see the Running
  / lingering children bullet in the `pi-compact-tools` grouping contract for
  how group child rows absorb and linger independently of that toggle.
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
- **User-message / quiz / compaction border style:**
  `UserMessageComponent`, the quiz `renderCall`/`renderResult`, and
  `CompactionSummaryMessageComponent` use chatbox-style horizontal rules (`──`)
  at 50% opacity over `PAGE_BG`, sourced from `TEXT_COLOR` via
  `colorWithOpacity(..., 0.5)` in `pi-ember-ui/index.ts`. The
  `chatboxBorderContainer(content, paddingX)` helper wraps content with a top
  and bottom `DynamicBorder` and a `Box(paddingX, 0, undefined)` for
  left/right inset, with no background fill. This replaces the previous
  `userMessageBg`/`customMessageBg` block backgrounds for those rows.
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
  the rendered block.
- **Mode-switch tool-access reminder:** When `apply_mode` switches between two
  different modes, it injects a hidden `pi-agents-tool-access` custom message
  (`display: false`, same channel as `pi-agents-auto-continue` and
  `pi-agents-loop-retry`) telling the model which tools it lost, which it
  gained, and its current tool set. This steers the next turn without
  cluttering the transcript. Never duplicate this reminder in other plugins.
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
    ├── plugins/pi-custom-agents/
    │   ├── primary modes, plans, quiz
    │   └── subagent implementation and bundled agent definitions
    ├── plugins/devin-auth/
    │   └── Devin provider, OAuth, catalog, and streaming
    ├── plugins/pi-cursor-auth/
    │   └── Cursor subscription auth, model discovery, and Pi-native streaming
    ├── plugins/pi-ember-dcp/
    │   └── Dynamic context pruning, compress tool, /dcp controls
    ├── plugins/pi-ember-fff/
    │   └── FFF-powered grep/find with external allowlist
    ├── plugins/pi-ember-todo/
    │   └── Task list tool, /todos command, transcript rendering
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
  child verbs, not the bullet.
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
  `normalize_tool_arguments` only remaps Cursor-style arg names
  (`old_string`/`new_string` → `oldText`/`newText`) and must not do its own
  whitespace normalization; `pi-compact-tools` only renders live counts and
  must not touch matching. Per the override-delegation rule, any future
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
  Grouped child rows show path/details only plus muted diff stats; grouped read
  children include offset/line limit. Final counts use distinct tool-call
  target paths for files; searches and bash commands count call entries. Every
  group header and child is one ANSI-aware, width-truncated terminal row. The
  grouping contract is:
  - **First-member ownership:** The first call that creates a group
    anchors the group header (`renderOwner`) and keeps it for the
    rest of the group's lifetime. Ownership never migrates to later calls.
    New same-type calls append as child rows under the existing header.
  - **Single live group:** The renderer tracks one `currentGroup` at a
    time. All groupable tools share `WORK_GROUP_KEY` (`__work__`), so
    discovery, edit, write, bash, and patch calls in one burst accumulate
    under one header instead of splitting by tool family. A non-groupable
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
    `Thinking` replaces the lingering `Searching`/`Reading` child in the single
    `└` pipe row. Same-key batches reopen via `findReopenableGroup` when
    `currentGroup` was lost so another `Explored` header is not spawned.
    **Inter-run planning text** (`text_delta` while `isInterRunGap()`, including
    OpenAI/Codex narration between tool batches) is a soft boundary — groups
    stay reopenable; never `hardExitGroup()`. **Final answer text**
    (`text_delta` after the agent is no longer pending / outside the inter-run
    gap), user message, different group key, or hard non-groupable tool
    (`subagent`, `quiz`, … via `noteInterveningToolCall`) →
    `hardExitGroup()` (header-only, drop reopen, `hardExited` set);
    **`todo`** is a soft boundary (`WORK_GROUP_SOFT_BOUNDARY_TOOLS` /
    `noteSoftInterveningToolCall` in `renderer.ts`) — settles the work
    header without `hardExited` and **without** folding child rows (linger
    until thinking or a genuinely new tool wave); the
    transcript anchor **migrates** to the first post-`todo` groupable call
    (`migrateAnchorOnNextWave` on `appendToGroup`) so the unified header and
    Thinking lane render **below** the todo row, not above it; in-group
    `└ Thinking` is suppressed until that migration runs; same-key
    `tool_call` → reopen tool lane (recovers frozen group via
    `findReopenableGroup` if `currentGroup` was lost without a hard exit);
    `agent_settled` → collapse thinking lane (header-only, keep reopen pointer).
    `thinking_delta` with blocks visible hard-exits via `noteVisibleThinking()`
    so the next same-key batch spawns a fresh header downstream; hidden blocks
    use in-group `└ Thinking` via `noteThinking()`. Hard
    group splits on visible text use non-empty `text_delta` only — bare
    `text_start` must not split.
  - **Running / lingering children:** Under the unified work header
    (`• Edited N files, explored M files, … +N -N`), every member in the
    current Pi turn renders as a `├`/`└` child row (`childAbsorbBefore` = 0
    until fold). Sequential tool calls in the same turn stay listed through
    `turn_end`. Prior rows fold only on a **genuinely new tool wave**
    (`appendToGroup` when all prior members are complete and the incoming call
    is not a repeat of a visible same-signature call), or a **hard boundary**
    (`noteUserMessage`, `noteVisibleText`). Soft boundaries (`todo`) and thinking
    streams settle the header and may paint in-group `└ Thinking`, but they do
    **not** absorb lingering children. `noteThinking()` appends in-group
    `└ Thinking` after lingering tool rows and suppresses the external
    widget. A later tool call reopens the tool lane with only the new wave
    visible (prior wave absorbed on reopen). Hard boundaries still clear children.
  - **Group child gradient tick:** While visible child rows render, the
    owner's `invalidate` is subscribed to the shared gradient tick via
    `subscribeGradientTick`/`unsubscribeGradientTick`
    (exported from `pi-ember-ui/index.ts`, backed by the single 20 FPS
    clock in `gradient.ts`). Child verbs use `render_gradient` with the
    muted→text `actionGroup` preset at the same `GRADIENT_TICK_MS` cadence
    as the Thinking widget. The tick is dropped when child rows collapse
    (settle, soft/hard thinking handoff, or session reset). Subscriptions
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
  equivalent `rg` (ripgrep) invocations via `pi-compact-tools/bash-grep.ts`
  (SSOT). Combined short flags (`-rn`,
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
  compact group header while any member is running, the in-group Thinking lane
  is painted, or the group is not yet settled (reverting to plain bold final
  summaries when all complete and settled). Lingering completed child rows alone
  do not make `hasActiveGroups()` true. The `isToolGroupActive` flag in
  flag in `pi-ember-ui/mode-colors.ts` is driven from this plugin's
  lifecycle handlers via `hasActiveGroups()`.

### `pi-custom-agents`

- **Provider-aware patch tool selection:** `edit-tools.ts` is the SSOT for
  choosing `apply_patch` vs `edit`, `SUBAGENT_DELEGATION_TOOLS`
  (`subagent` / `subagent_resume`), and `without_subagent_delegation_tools()`.
  Code mode (`build_full_tools`) has no subagent tools — delegation lives in
  plan (Scout-only), debug, and orchestrate via `READONLY_DELEGATING_TOOLS`.
  Subagent child tool lists expose `apply_patch` only when the active model
  provider is `openai-codex`; all other providers get `edit` instead. `setActiveTools`,
  mode prompts, and the `tool_call` guard all flow through this helper — never
  hardcode both tools into a mode allowlist. Switching models in code mode
  refreshes the active tool set and sends a hidden `pi-agents-tool-access`
  reminder when the patch tool changes.
- **Plain-text output directive:** The `OUTPUT_STYLE_DIRECTIVE` constant in
  `index.ts` is injected into every mode prompt (`plan`, `code`, `debug`,
  `orchestrate`) and mode transitions (`exit_to_coder_prompt`,
  `plan_implement_prompt`).
  Plan mode's output contract uses labeled lines (`Task:`, `Investigation:`,
  `Summary:`, `Problems:`, `Behavior:`, `Module N:` with `Cleanup:`,
  `Persistence:`, `Interfaces:`, `Test Plan:`, `Non-Goals:`, `Assumptions:`,
  `Working Tree:`, multi-axis `Acceptance Criteria:`) instead of `##`/`###`
  markdown. The plan must pick one concrete approach (quiz unresolved forks
  first; no Option A/B inside the plan; no `Open Questions:` section).
  Bundled subagent `.md` definitions (`coder.md`, `scout.md`) inline the
  same directive. `pi-ember-ui` Markdown rendering remains display-only and works
  on plain text.
- Owns the plan-review flow, quiz tool, mode cycling, and
  `/subagent-model`. Registers the mode-id → label resolver
  (`setModeLabelResolver`) so the `pi-ember-ui` footer can render the active
  mode label without duplicating the `MODES` map.
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
- **Plan review:** Every completed plan turn, including turns where the model
  invoked and received a quiz answer, opens the canonical
  `showPlanReview()` quiz (`build_plan_review_questions` /
  `resolve_plan_review_answer` SSOT in `plan-review.ts`). Options:
  `Implement Plan` (same-session code/orchestrate follow-up; embeds
  `latest_plan_text` in the hidden `pi-agents-plan-implement` message via
  `build_plan_implement_message_content` in `plan-implement.ts` so compaction
  cannot reduce the approved plan to the short summary),
  `Implement with fresh context` (`ctx.newSession()` pastes the plan as the
  first user message, switches to code mode, and kicks implementation),
  `Copy Plan`, plus the automatic custom `None` option for typed refinements.
  The `Implement via` follow-up uses the quiz renderer (not `ctx.ui.select`)
  so its dim chatbox borders stay out of the live plan accent; the selected
  option uses `text` color like every other quiz screen.
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
  checkpoint (`## Goal`, `## Progress`, `## Next Steps`, split-turn prefix,
  `<read-files>` / `<modified-files>`). Pi injects that checkpoint into LLM
  context after compact(). The continue message is a short non-duplicating
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
  the stream, notifies the user with the active model name, and uses the shared
  quiz UI with `End stream`, `Retry`, and the automatic custom `None`
  option. Retry injects the hidden `pi-agents-loop-retry` message instructing the
  model to back off and use a different tool; a custom None answer is injected
  as hidden guidance. Tracking resets at each agent run and session shutdown.
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
  `pi.setThinkingLevel()` when the base model exposes `thinkingLevelMap`.
  Exact `/model provider/id` still calls `pi.setModel()` immediately.
  `/resume` (and `app.session.resume`) stays chat-pill autocomplete with a
  sticky `switchSession` capture from `ExtensionRunner.bindCommandContext`
  (`pi-ember-ui/command-context-capture.ts` SSOT — also captures `newSession`
  for plan-fresh-session; unbind does not clear prior handlers). Each
  `session_start` re-binds from the live runner's `createCommandContext()`.
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
- Resolves bundled definitions from `import.meta.url`; never use an absolute user
  home path or a Windows-only source path.
- Contains the vendored subagent implementation and bundled `.md` agent definitions.
- Agent requests resolve through the single `subagent/extensions/agents.ts`
  `resolveAgent()` helper; names are case-insensitive and surrounding whitespace
  is ignored, while the resolved frontmatter name is used for display and threads.
- **Subagent rendering:** The `subagent` tool uses `renderShell: "self"` and
  renders a compact, Exploring-style grouped layout. Running agent names use
  `theme.fg("text", …)`; completed and failed agent names use `theme.fg("dim", …)`.
  Completed agents use green bullets and failed agents use red bullets.
  Parallel/chain mode shows a
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
  guard in other plugins. Model-visible tool-result `content` (orchestrator
  context) uses `format_agent_tool_result_text` / `format_agent_tool_result_batch`
  in `runner.ts` (SSOT): `### [Coder A] completed\n\n<body>`. Chain
  `{previous}` substitution still uses raw `getFinalOutput()` — no label wrapper.
  TUI rows use `details` + `render.ts` separately. The subagent
  renderer no longer uses `PulseManager`; it subscribes to the shared
  gradient clock via `subscribeGradientTick`/`unsubscribeGradientTick`
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
  The subagent runs **in-process** on the main thread — not in a
  `worker_thread`. The runner accepts the parent's extension-facing
  `ModelRegistry` and crosses to its canonical `ModelRuntime` exactly once in
  `runner.ts`; child sessions receive that same runtime so every registered
  provider, credential source, header, runtime override, and custom
  `models.json` entry is available without copying auth or re-registering
  providers. Never recreate child auth storage in `index.ts` or `service.ts`.
  `session.prompt()` is async and does not block the TUI
  render loop. Child sessions load a minimal extension set via
  `discoverAndLoadExtensions()`: shared Ember compaction wiring
  (`plugins/pi-custom-agents/compaction-wiring.ts` on `session_before_compact`,
  same prompts as parent via `stack-compaction.ts`) plus optional DCP outbound
  strategies when global DCP is enabled (`pi-ember-dcp/subagent-wiring.ts` —
  dedup and errored-input purge only; no DCP `compress` tool, `/dcp`, skills, or
  disk persistence). `build_subagent_settings()` enables Pi compaction
  (`compaction.enabled: true`) and disables retry. Overflow recovery may call
  `session.compact()` once before retrying the task prompt (hook supplies
  summarizer). Never
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
  Plan/debug/orchestrate include `SUBAGENT_DELEGATION_TOOLS`; code mode does
  not. Plan mode is Scout-only for exploration (`subagent-policy.ts` SSOT:
  `validate_plan_mode_subagent` blocks Coder and other agents in `tool_call`;
  `PLAN_SUBAGENT_AWARENESS_PROMPT` in `index.ts`).
- Owns per-mode model memory. The persisted `pi-ember-stack.json` state is the
  SSOT for the active `mode` and the `modeModels` map
  (`Partial<Record<modeId, { provider, modelId, thinkingLevel? }>>`). Each mode
  remembers its own last user-selected model and effort variant (`thinkingLevel`
  from `/model` Effort slider or thinking-level cycle); unbound modes have no
  entry and keep the live model on switch. The legacy top-level `model` field is
  migrated once into `modeModels[persistedMode || "code"]` and deleted on write,
  so `modeModels` is the sole authority — never write a parallel global `model`.
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
  `lookup_blob`, `assert_conversation_blobs_present`) — request build and KV
  `getBlob` lookup must share the same hex key; never duplicate blob-key logic.
  Drop stale checkpoints when referenced blobs are missing locally and **rotate
  `conversation_id`** so Cursor does not reuse server-side state for a dead
  conversation. Persist checkpoint + `blob_store` **only after a successful
  stream**; failed runs must not poison the next turn. `default` is the Cursor
  API model id for Auto routing; legacy `auto` ids map to `default` via
  `resolve_cursor_model_id` in `request.ts`. `bridge.end()` in `transport.ts` is idempotent and swallows
  `EPIPE` when the h2 child has already exited.
- **Outbound tool schema SSOT:** `PI_TO_CURSOR_TOOL_NAME` and
  `PI_TO_CURSOR_ARG_NAMES` in `src/context.ts` (`cursor_serialize_tool`;
  covers core tools plus `todo`, `apply_patch`, `subagent`, `quiz`, `task`,
  web tools, `compress`). **Inbound mapping SSOT:** `TOOL_ALIASES` +
  `normalize_tool_arguments` + `resolve_pi_tool_name` at the `stream.ts` tool-call
  boundary only — never duplicate these maps. **Final arg normalization SSOT:**
  `finalize_cursor_tool_arguments()` in `stream.ts` (used on both streaming deltas
  and `close_tool_call`) — never parse final JSON without normalization.
- Mode directives prepend to the system prompt on the first turn and after Pi
  mode changes (`stream.ts`; `plan` / `code` / `debug` / `orchestrate`).
- **Reasoning models:** `CURSOR_REASONING_MODEL_PATTERNS` in `src/constants.ts`;
  cloud `thinkingDelta` events forward as native `thinking_*` stream events.
- Protobuf schemas vendored from
  [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
  (`src/cloud-direct/proto/agent_pb.ts`, BSD-3-Clause, see `LICENSE`).

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
  `ALWAYS_PROTECTED_TOOLS` (`compress`, `write`, `edit`, `apply_patch`, `todo`,
  `task`, `skill`) — never hardcode a second membership set. User config may
  extend protection lists; it cannot remove the always-protected set.
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
- **Subagent child sessions:** `lib/wiring.ts` is the SSOT for event registration.
  `create_subagent_dcp_extension(cwd)` wires the outbound pipeline only
  (no `compress` tool, `/dcp`, skills, or `~/.pi-dcp` persistence). Loaded from
  `plugins/pi-custom-agents/subagent/extensions/runner.ts` when global DCP
  `enabled` is true. Subagent child sessions load the shared parent
  `compaction-wiring.ts` (not a duplicate under subagent/extensions).
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

### `pi-ember-todo`

- Owns the `todo` tool and `/todos` slash command (task list with `blockedBy`
  DAG, branch replay, and disk fallback under `~/.pi/ember-todo/`).
- Available in all parent modes (`plan`, `code`, `debug`, `orchestrate`) via
  `BASE_RESEARCH_TOOLS` / `build_full_tools` in `pi-custom-agents`, and on the Coder
  subagent tool list. Scout stays without `todo`.
- Renders in the **chat transcript** only (`renderShell: "self"`) — no
  above-editor overlay widget. Header uses shared `BULLET` from
  `pi-compact-tools` with `statusBulletColor` (SSOT): `muted` while any
  visible task is incomplete, `success` when every visible task is
  `completed`; label stays `muted` bold `Todo`. Pending entries use `dim`,
  in-progress uses `text`, completed uses `muted` + strikethrough (no status
  glyphs on child rows). No accent, `toolTitle`, or `warning` tokens on task
  rows. Transcript layout lives in `render.ts` (`task_subject_token`,
  `format_transcript_task_line`, `TodoTranscriptComponent`).
- Consecutive `todo` calls in one assistant burst fold into a single `• Todo`
  header with tree child rows at the **latest** todo's transcript position;
  earlier todo slots in the burst collapse to zero height. The live block
  updates via shared `CompactGroupText` on `record.group` (rebuild-safe).
  Only a **user message** or **compaction** starts a fresh todo group — edits/grep/bash
  between todo calls do not split the group (`timeline.ts` boundary on rebuild;
  `message_start` user settle live; `session_compact` resets renderer + replays
  post-compact state only (pre-compaction todo rows collapse to zero height;
  `seed_todo_renderer_from_branch` and `is_post_compaction_todo_call` use the
  post-compact branch slice). `todo` does not hard-split the unified
  work bundle either — `pi-compact-tools` `noteSoftInterveningToolCall()`
  (`WORK_GROUP_SOFT_BOUNDARY_TOOLS`) keeps the `__work__` header reopenable
  after a todo row and migrates the work header below the todo on the next
  groupable wave; `renderCall` also invokes it on rebuild (ctrl+t / compaction)
  so chronological placement survives Pi component rebuilds. `render.ts` owns
  todo grouping; never settle todo groups
  on non-todo `tool_call`.
- The visible block always shows the latest task snapshot from the group
  (`latest_group_snapshot`); historical todo tool slots in the same burst stay
  collapsed, not duplicated.
- Dotted tool-name rewrite: a `message_end` handler in `pi-ember-todo/index.ts`
  rewrites assistant tool calls whose name is `todo.<action>` (one of
  `create|update|list|get|delete|clear|batch`) to `todo` with `action: <action>`
  before Pi core's tool-name lookup. This is the SSOT for the dotted-form rescue;
  never duplicate it in provider plugins. Cursor's `TOOL_ALIASES` (`updateTodos`
  → `todo`) covers Cursor-native names and is separate from this rewrite.
- DCP lists `todo` in `ALWAYS_PROTECTED_TOOLS` — context pruning never
  compresses todo results.

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
  labeled-line contract (`Task:`, `Investigation:`, `Summary:`, `Problems:`,
  `Behavior:`, `Module N:` with `Cleanup:`, `Persistence:`, `Interfaces:`,
  `Test Plan:`, `Non-Goals:`, `Assumptions:`, `Working Tree:`, multi-axis
  `Acceptance Criteria:`) instead of `##`/`###` headers. The plan must pick
  one concrete approach (quiz unresolved forks first; no Option A/B inside
  the plan; no `Open Questions:` section).
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
