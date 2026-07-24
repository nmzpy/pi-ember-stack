# pi-ember-ui Local Guidance

Pi owns the live TUI renderer, terminal output, cursor placement, viewport
position, and differential snapshot. This package must never monkey-patch
`TUI.doRender()` or `TUI.requestRender()`, write to `tui.terminal`, or mutate
private fields such as `previousLines`, cursor rows, viewport state, render
timers, or Kitty image bookkeeping.

## Render contract

- Use the live TUI's public `requestRender()` or the public `tui.requestRender()`
  supplied to a custom component when component state changes.
- Component render overrides may call the original component render and return
  width-safe rows. They must not request renders, access terminal state, or
  perform synchronous session scans or filesystem work.
- Structural changes (thinking visibility, overlays, compact-group settling,
  mode changes) update the component tree and schedule one normal public Pi
  render. Pi owns line clearing, shrink handling, cursor positioning, and
  differential bookkeeping.
- The shared gradient clock updates live component state and issues at most one
  public render request per tick. It never paints terminal rows directly.
- Startup visuals that may be off-screen are static. Visible Thinking,
  compact-group, and subagent components use ordinary native renders.
- All custom rows must respect the width supplied by Pi, using ANSI-aware
  truncation before returning lines.

## Layout contract

`layout.ts` owns only slash/autocomplete state tracking, scroll-review flags,
editor-container discovery, and the leading chatbox spacer. It must not render
the TUI synchronously or implement viewport diffs/snaps.

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
