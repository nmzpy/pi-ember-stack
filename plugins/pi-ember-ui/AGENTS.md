# pi-ember-ui Local Guidance

This file is a compact map of the installed Pi contracts that `pi-ember-ui`
overrides. Read it before inspecting `node_modules` or changing the editor/TUI
patches.

## Upstream Baseline

- Installed Pi packages are `@earendil-works/pi-coding-agent@0.80.6` and
  `@earendil-works/pi-tui@0.80.6`.
- Runtime source references are relative to the repository root:
  - `node_modules/@earendil-works/pi-tui/dist/tui.js`
  - `node_modules/@earendil-works/pi-tui/dist/components/editor.js`
  - `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- Re-check these notes when the installed Pi version changes. Do not edit
  `node_modules`; adapt the plugin against the installed contract.

## Root TUI Composition

`TUI` extends `Container`. `Container.render(width)` renders each direct child
and concatenates the returned rows from the top. It does not bottom-anchor any
child and it does not insert layout rows automatically.

Interactive mode adds direct children in this order:

1. Header container
2. Loaded-resources container
3. Chat container
4. Pending-messages container
5. Status container
6. Widgets above the editor
7. Editor container
8. Widgets below the editor
9. Footer

The editor container is stable, but Pi replaces its child when a custom editor
or extension input is activated. Identify the container structurally and do not
retain assumptions about one editor instance.

## Render Lifecycle

- `TUI.doRender()` calls `this.render(width)`, then composites overlays, extracts
  the cursor marker, applies line resets, and performs differential rendering.
- `TUI.requestRender()` schedules a normal render through Pi's 16 ms scheduler.
- `TUI.requestRender(true)` clears Pi's differential state
  (`previousLines`, dimensions, cursor rows, high-water rows, and viewport)
  and runs a full clear/redraw on the next tick. Never use this on normal
  slash/autocomplete collapse — it homes the buffer and can clear terminal
  scrollback. `disable_tui_clear_on_shrink()` explicitly keeps Pi's
  `clearOnShrink` path off for the live TUI.
- `clearOnShrink` controls whether Pi performs a full redraw when the rendered
  content becomes shorter than the previous high-water mark. Pi defaults it **off**
  (`PI_CLEAR_ON_SHRINK=1` to enable globally); Ember explicitly disables it per
  session so terminal scrollback remains terminal-owned. Collapse uses the
  non-destructive screen reset described below instead of Pi's shrink path.
- When rendered content is taller than the terminal, Pi displays the bottom
  viewport and appends new lines with terminal scroll. On slash/autocomplete
  collapse, `layout.ts` clears only the visible screen through the terminal
  abstraction, resets Pi's differential state, and requests a normal render.
  It deliberately does not emit Pi's `3J` scrollback clear sequence, re-enable
  `clearOnShrink`, or use `requestRender(true)`.
- `layout.ts` owns slash/autocomplete-collapse normal render requests
  (`request_overlay_collapse_render()`, `finalizeEditorInputAfter()`), the
  non-destructive visible-screen reset, and `ensure_chatbox_leading_spacer()`.
  `CHATBOX_LEADING_ROWS` (1) is the SSOT for padding above the chatbox or above
  Thinking/Working when that widget is visible — the widget label itself is flush
  to the editor.
  It does not patch `TUI.render()`.

## Editor Contract

`Editor.render(width)` emits rows in this order:

1. Top horizontal border
2. Visible editor text rows
3. Bottom horizontal border
4. Autocomplete rows, when active

The Ember render override reorders active autocomplete rows above the editor
body, so the chat-pill grows upward and the editor remains terminal-bottom
anchored. Its outer shell uses a rounded top border for the menu, a shared
separator, the editor body, and rounded bottom corners.

The base editor has no side borders. The Ember `Editor.prototype.render`
override owns the chat-pill border, content insets, slash separator, and
autocomplete boundary. Keep all of that logic in `plugins/pi-ember-ui/index.ts`.

The editor's `handleInput()` mutates editor state and may update autocomplete;
after the focused component handles input, `TUI.handleInput()` requests a normal
render. Slash-exit and autocomplete-collapse detection run after Pi's original editor
handler via `finalizeEditorInputAfter(editor)` in `layout.ts` (including Escape
early returns and model-picker intercepts). Overlay collapse calls
`request_overlay_collapse_render()`, which resets only the visible screen and
Pi's differential bookkeeping, then requests a normal render without Pi's
scrollback-clearing path.

## Extension UI Contracts

- `setEditorComponent(factory)` clears the stable editor container, creates the
  new editor, copies callbacks/text/settings, and adds it back to that
  container.
- `setWidget(key, content, options)` places components in the above-editor or
  below-editor widget container. Widget render closures must remain O(1).
- `setFooter(factory)` removes the current footer and adds the custom footer as
  a direct TUI child.
- Pi's base autocomplete list is rendered after its bottom border, but the
  Ember patch moves active autocomplete rows above the editor body so the
  chat-pill grows upward. Detect borders from their characters, not fixed row
  indexes.

## Model / Resume Picker (`model-picker.ts`)

- Owns `/model` and `/resume` editor intercepts, `pickModelInEditor()` for
  `/subagent-model`, slash-layout autocomplete patching, and pending-pick
  submit handling.
- **Never** `registerCommand("model")` or `registerCommand("resume")` — both
  conflict with built-in interactive commands (Extension issues warning).
  Override purely via prototype patches, matching `/model`.
- Prototype patches install at `pi-ember-ui` plugin load; `wrapModelPickerEditor()`
  is called from the `pi-custom-agents` editor factory as the outermost
  `handleInput` wrap. `Editor.prototype.submitValue` blocks Pi's overlay
  selectors for `/model` and `/resume`. `CustomEditor.handleInput` routes
  `app.model.select` and `app.session.resume` into the chat-pill flow.
  Entry pickers show `AUTOCOMPLETE_MAX_VISIBLE` (7) rows — not Pi's default 5.
- Session switch uses `switchSession` captured from
  `ExtensionRunner.prototype.bindCommandContext` (same binding InteractiveMode
  uses). Completions via `ctx.ui.addAutocompleteProvider` on `session_start`.
- Chat-pill chrome (rounded corners, pipes, dim inset separator) comes from the
  existing `Editor.prototype.render` override when editor text starts with `/`.
- **Auto-submit on argument completion:** When the user selects a model or
  session from the autocomplete popup (Enter / `tui.select.confirm`), Pi only
  falls through to submit for command-name completions (prefix starts with
  `/`), not for argument completions (model names, session paths). The
  `wrapModelPickerEditor` `handleInput` wrapper detects when a confirm key
  closes the autocomplete and the editor text is a completed `/model
  provider/id` or `/resume <session>` command, and auto-submits via
  `handleSlashOverrideText`. This makes `/model` and `/subagent-model`
  (which uses `pickModelInEditor`) apply the selection immediately without
  requiring a second Enter.

## Override Rules

- Do not duplicate Pi layout, render scheduling, differential-render logic, or
  model-picker intercepts in `pi-custom-agents`; import the shared Ember UI
  entry points instead.
- Do not scan session entries, calculate context usage, or perform synchronous
  filesystem work from editor/header/footer/TUI render closures.
- Keep `requestTuiRender(force)` throttled through the shared scheduler. Do not
  call `tui.requestRender(true)` directly from unrelated plugins.
- Preserve Pi's cursor marker and row ordering. Do not insert terminal fill
  rows, welcome padding, or custom bottom-anchor layout in `TUI.render()`.
- Treat `node_modules` source as an inspected dependency contract, not a second
  implementation to copy into the plugin.

## Fast Navigation

- Root child composition: `interactive-mode.js` around lines 493-505.
- Widget rebuilding: `interactive-mode.js` around lines 1528-1551.
- Custom footer replacement: `interactive-mode.js` around lines 1553-1578.
- Custom editor replacement: `interactive-mode.js` around lines 1824-1882.
- Container rendering: `tui.js` around lines 77-105.
- Forced render state reset: `tui.js` around lines 498-526.
- Overlay composition: `tui.js` around lines 792-839.
- Main render/differential path: `tui.js` around lines 976-1219.
- Base editor row order: `editor.js` around lines 363-472.