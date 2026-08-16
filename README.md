# pi-ember-stack

The Ember-owned pi package. It installs the complete Ember agent workflow as
one package:

- Primary modes: `/coder`, `/architect`, `/doctor`, `/orchestrator`, and
  `/ui-doctor`.
- Inline `quiz` UI for decision-oriented questions. Agents are told to
  prefer it when they need a user choice.
- A compact native `edit` renderer that shows the filename and a single
  `+N / -N` result row.
- Hierarchical AGENTS.md auto-loading: nested `AGENTS.md` files under the
  project root are discovered as tools touch their directories and injected
  into every LLM request (shallow → deep), without persisting copies in the
  session.
- Vendored subagent support with bundled `coder` and `architect` definitions,
  plus the upstream bundled roles.
- Bundled Devin auth/provider support, including OAuth, model catalog refresh,
  and streaming transport.
- Cursor subscription support through the official Cursor Agent CLI, with Pi
  retaining its native session and tool loop.
- A self-contained `Ctrl+Space` mode-cycle shortcut and a footer showing the
  active mode, model, and thinking variant.

## Plugin registry

The package has one top-level pi extension which dispatches to the internal
plugins under `plugins/`. Enable them globally in `PI_HOME/pi-ember-stack.json`:

```json
{
  "plugins": [
    "pi-compact-tools",
    "devin-auth",
    "pi-cursor-auth",
    "pi-ember-images",
    "pi-custom-agents",
    "pi-ember-fff",
    "pi-ember-ui",
    "pi-ember-tps",
    "pi-ember-webtools"
  ]
}
```

Remove a plugin ID to disable it, or use `/stack-plugins` to toggle one from
the TUI. Restart pi after changing the list. The available plugins are:

- `pi-compact-tools`: collapsed native edit rendering.
- `pi-custom-agents`: quiz UI, primary modes, plans, subagent tool, bundled agent definitions, and hierarchical AGENTS.md auto-loading.
- `devin-auth`: Devin provider, OAuth, catalog refresh, and streaming.
- `pi-cursor-auth`: Cursor subscription auth, model refresh, and native Pi streaming.
- `pi-ember-fff`: FFF-powered grep/find with compact rendering.
- `pi-ember-images`: Windows/macOS clipboard image attachments with compact chat previews.
- `pi-ember-ui`: Ember accent theme and TUI chrome.
- `pi-ember-tps`: tokens-per-second meter.
- `pi-ember-webtools`: web search, URL fetching, and related extraction tools.

## Project setup

The Ember repository contains a project-local `.pi/settings.json` entry for:

```json
"npm:@nmzpy/pi-ember-stack@0.1.6"
```

On a new clone, start pi from the project directory. Pi will ask for a
one-time project trust decision before it installs the package into the
project-local `.pi/npm/` directory. The same decision can be approved
non-interactively with:

```text
pi --approve
```

Project trust is intentionally a user decision; a repository cannot safely
bypass it. After trust, normal startup is just `pi` from the Ember directory.

When a new version is intentionally released, update the pinned version in
the project settings and run:

```text
pi update --extensions
```

Third-party utilities such as pi-fff and image paste remain separate package
entries. Devin auth is now bundled as a stack plugin, but credentials and
provider secrets stay in the machine-local pi configuration and are not part
of this repository.

## Development

The package entrypoint is `plugins/index.ts`. Compact tools are under
`plugins/pi-compact-tools/`, while quiz, primary modes, plans,
subagents, and bundled agents are under `plugins/pi-custom-agents/`. Provider
plugins are under `plugins/devin-auth/` and `plugins/pi-cursor-auth/`.

Run the package typecheck with:

```text
npm install
npm run typecheck
```

## Hierarchical AGENTS.md auto-loading

Pi loads the project-root `AGENTS.md` into the system prompt natively.
`pi-custom-agents` extends that with a hierarchical auto-loader
(`plugins/pi-custom-agents/agents-md.ts`): when a tool touches a directory
under the session cwd, every `AGENTS.md` from the root down to that directory
is activated shallow → deep, and the active instructions are injected into
every LLM request as ONE virtual custom message delimited like
`<agents_md path="relative/path">\n...\n</agents_md>`. The message is built
per request from the current active set — nothing is persisted into the
session, and the root AGENTS.md (already in the system prompt) is never
re-injected.

### Installation and location

There is nothing to install and no configuration. The loader ships inside the
`pi-custom-agents` plugin, which is enabled by default in
`PI_HOME/pi-ember-stack.json`. Just place `AGENTS.md` files in the directories
whose instructions should apply while the model works there:

```text
<project root>/
  AGENTS.md            <- loaded natively by Pi (system prompt)
  src/
    AGENTS.md          <- auto-loaded when a tool touches src/
    api/
      AGENTS.md        <- auto-loaded when a tool touches src/api/
```

Only files named exactly `AGENTS.md` are recognized. Activation order is
shallow → deep, so a deeper file's instructions append after its ancestors';
instructions from unrelated directories stay active for the session in their
first-activation order.

### Hooks

The loader uses only public Pi lifecycle events:

- `session_start` — captures `ctx.cwd` as the project root boundary (the loader
  never searches above it).
- `tool_call` — derives target paths from `read`/`edit`/`write`/`grep`/`find`/
  `ls` (plus `file_path`/`filePath` aliases), bash (`cd <dir>`, `cd -- <dir>`,
  and absolute/dot-relative operands only — ambiguous commands are ignored),
  and `apply_patch` (shared envelope parser), then activates the applicable
  `AGENTS.md` files.
- `tool_execution_end` — rescans the touched directories and updates, activates,
  or drops files whose content changed or that were created/deleted.
- `context` — before each LLM request, appends the single virtual custom
  instruction message for the current active set (skips when the message array
  already carries the `pi-agents-md-instructions` marker; the incoming array is
  never mutated).
- `session_shutdown` — clears all loader state.

Paths are resolved against the filesystem, not string-slashed: `..` is
normalized, existing symlinks cannot escape the canonical root, nonexistent
create targets are judged through their nearest existing ancestor, and
anything outside the project root is rejected.

### Verification

Run the loader's test suite:

```text
bun test plugins/pi-custom-agents/test/agents-md.test.ts
```

The tests generate a reproducible temp-dir fixture:

```text
<tmp>/root/            <- session cwd / project root
  AGENTS.md            <- root instructions (never auto-loaded)
  a/
    AGENTS.md          <- "a instructions"
    file.ts
    b/
      AGENTS.md        <- "b instructions"
      deep.ts
  sub/
    AGENTS.md          <- "sub instructions"
  plain/               <- no AGENTS.md (write-created file test)
<tmp>/outside/         <- escape boundary (outside root)
  secret.txt
```

To verify manually in a real pi session, create `src/AGENTS.md` inside the
project, ask the model to read a file under `src/`, then check that a
subsequent request carries the `src/AGENTS.md` instructions (the `context`
hook adds them on the next LLM request after the tool call).


## Release

Run `./gacp.sh --release` to bump the patch version, typecheck, commit, tag,
push, and publish the package to npm. This only publishes the package; update
Ember's pinned package version separately when you want the project to install it.

The package is cross-platform: bundled paths are resolved from `import.meta.url`
and do not depend on a Windows home directory or the current working
directory.
