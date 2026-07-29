# pi-ember-ui Local Guidance

Pi owns the live TUI renderer, terminal output, cursor placement, viewport
position, and differential snapshot. This package must never monkey-patch
`TUI.doRender()` or `TUI.requestRender()`, write to `tui.terminal`, or mutate
private fields such as `previousLines`, cursor rows, viewport state, render
timers, or Kitty image bookkeeping.

## Render contract

- Schedule live paints through `request_live_tui_render()` in `layout.ts`
  (exported as `requestLiveTuiRender`) or `requestTuiRender()` in `index.ts`.
  Animated UI — Thinking, gradient ticks, quiz refresh — must not call raw
  `tui.requestRender()` directly.
- Trackpad scroll uses **terminal scrollback**, not Pi input events. Ember must
  not intercept scroll keys, mouse wheel, or trackpad gestures. When the agent is
  settled and no gradient animation is visible, the gradient clock must stop and
  issue zero periodic `requestRender` calls.
- Editor/chatbox content rows use `fit_terminal_content_line()` — truncate only,
  never pad with trailing spaces (that caused rectangular mouse selection in the
  terminal). Full-width padding is reserved for structural border/rule lines.
- Use the live TUI's public `requestRender()` or the public `tui.requestRender()`
  supplied to a custom component when component state changes.
- Component render overrides may call the original component render and return
  width-safe rows. They must not request renders, access terminal state, or
  perform synchronous session scans or filesystem work.
- Structural changes (thinking visibility, overlays, compact-group settling,
  mode changes) update the component tree and schedule one normal public Pi
  render. Pi owns line clearing, shrink handling, cursor positioning, and
  differential bookkeeping.
- The shared gradient clock updates live component state through subscribers;
  each subscriber owns its own `requestTuiRender()` / `invalidate()` call only
  when visible text actually changes. The clock never issues a blanket render
  after every tick. **Binding a host component must not subscribe the clock** —
  `sync_thinking_gradient_clock()` owns subscribe/unsubscribe via
  `sync_thinking_status_tick()`. It never paints terminal rows directly.
- The external Thinking tick resolves the mutually-exclusive widget or
  in-message host and invalidates only that host. A compact group's own
  gradient subscriber owns in-group `└ Thinking`; the external Thinking tick
  must not invalidate both external hosts or run while the compact lane owns
  the status slot.
- Do not re-anchor the viewport on slash/autocomplete exit, editor keystrokes,
  or idle lifecycle events — trackpad scroll uses terminal scrollback and any
  periodic `requestRender` snaps it back to the live frame.
- Startup visuals that may be off-screen are static. Visible Thinking,
  compact-group, and subagent components use ordinary native renders.
- All custom rows must respect the width supplied by Pi, using ANSI-aware
  truncation before returning lines.

## Layout contract

`layout.ts` owns editor-container discovery and the leading chatbox spacer.
`finalize_editor_input_after` is a no-op — it must not schedule layout snaps.

`index.ts` may customize Pi components, headers, widgets, themes, and footer
content, but its render paths remain pure and O(1). Lifecycle handlers own
state transitions and call the native public request API.

## Verification

Before changing render behavior, run:

```text
npm run typecheck -- --pretty false
bun test plugins/pi-ember-ui/test plugins/pi-compact-tools/test plugins/pi-custom-agents/subagent/extensions/test
```

The renderer-authority test is intentionally a source guard against terminal
writes, private differential-state mutation, and TUI render replacement.
