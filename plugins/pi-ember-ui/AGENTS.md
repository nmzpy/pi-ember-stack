# pi-ember-ui Local Guidance

Pi owns the live TUI renderer, terminal output, cursor placement, viewport
position, and differential snapshot. This package must never monkey-patch
`TUI.doRender()` or `TUI.requestRender()`, write to `tui.terminal`, or mutate
private fields such as `previousLines`, cursor rows, viewport state, render
timers, or Kitty image bookkeeping.

## Render contract

- `render-intent.ts` is the sole native render-intent SSOT. Production feature
  code imports `request_render()` from that module; it never calls
  `.requestRender()`, `tui.render()`, or `tui.invalidate()` directly. The
  binding-only callback expressions in the excluded `index.ts` bridge are
  plumbing for the live Pi callback, not a second feature render path.
- The compatibility `request_live_tui_render()` seam in `layout.ts` delegates
  to `request_render()` and ignores its former TUI target. Do not add another
  render helper, scheduler, debounce, timer, or terminal writer.
- Trackpad scroll uses **terminal scrollback**, not Pi input events. Ember must
  not intercept scroll keys, mouse wheel, or trackpad gestures. When the agent
  is settled and no gradient animation is visible, the gradient clock stops
  and issues zero periodic `request_render()` calls.
- Editor/chatbox content rows use `fit_terminal_content_line()` — truncate only,
  never pad with trailing spaces (that caused rectangular mouse selection in the
  terminal). Full-width padding is reserved for structural border/rule lines.
- Component render overrides may call the original component render and return
  width-safe rows. They must not request renders, access terminal state, or
  perform synchronous session scans or filesystem work.
- Structural changes (thinking visibility, overlays, compact-group settling,
  mode changes) update the component tree and call `request_render()` once.
  Pi owns line clearing, shrink handling, cursor positioning, and differential
  bookkeeping.
- The shared gradient clock updates component state through stable subscribers.
  Subscribers stage changed text and mark the clock dirty; the clock dispatches
  one native `request_render()` after the subscriber snapshot completes. It
  never writes terminal rows, mutates differential state, or schedules a
  parallel renderer. **Binding a host component must not subscribe the clock** —
  `sync_thinking_gradient_clock()` owns subscription through
  `sync_thinking_status_tick()`.
- The external Thinking tick resolves the mutually-exclusive widget or
  in-message host and invalidates only that host. A compact group's own
  gradient subscriber owns in-group `└ Thinking`; the external Thinking tick
  must not invalidate both external hosts or run while the compact lane owns
  the status slot.
- Do not re-anchor the viewport on slash/autocomplete exit, editor keystrokes,
  or idle lifecycle events — trackpad scroll uses terminal scrollback and any
  periodic render request could snap it back to the live frame.
- Startup visuals that may be off-screen are static. The Pi logo has no startup
  animation or timer. The sticky header persistence patch keeps its public
  header factory stable across session replacement without touching TUI render
  state or terminal output.
- All custom rows must respect the width supplied by Pi, using ANSI-aware
  truncation before returning lines.

## Layout contract

`layout.ts` owns editor-container discovery and the leading chatbox spacer.
`finalize_editor_input_after` is a no-op — it must not schedule layout snaps.
Its legacy `request_live_tui_render()` export is only a compatibility wrapper
around `request_render()`.

`index.ts` may customize Pi components, headers, widgets, themes, and footer
content, but its render paths remain pure and O(1). Lifecycle handlers own
state transitions and call the canonical render intent.

## Verification

Before changing render behavior, run:

```text
npm run typecheck -- --pretty false
bun test plugins/pi-ember-ui/test plugins/pi-compact-tools/test plugins/pi-custom-agents/subagent/extensions/test
```

The repository render-authority guard and renderer-authority test are source
guards against direct request paths, terminal writes, private differential-state
mutation, TUI render replacement, and duplicate render schedulers.
