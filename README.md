# pi-ember-stack

The Ember-owned pi package. It installs the complete Ember agent workflow as
one package:

- Primary modes: `/coder`, `/architect`, `/doctor`, `/orchestrator`, and
  `/ui-doctor`.
- Inline `questionnaire` UI for decision-oriented questions. Agents are told to
  prefer it when they need a user choice.
- A compact native `edit` renderer that shows the filename and a single
  `+N / -N` result row.
- Vendored subagent support with bundled `coder` and `architect` definitions,
  plus the upstream bundled roles.
- Bundled Devin auth/provider support, including OAuth, model catalog refresh,
  and streaming transport.
- A self-contained `Ctrl+Space` mode-cycle shortcut and a footer showing the
  active mode, model, and thinking variant.

## Plugin registry

The package has one top-level pi extension which dispatches to the internal
plugins under `plugins/`. Ember projects enable them in `.pi/ember-stack.json`:

```json
{
  "plugins": ["ember", "subagent", "devin-auth"]
}
```

Remove a plugin ID to disable it, or use `/stack-plugins` to toggle one from
the TUI. Restart pi after changing the list. The available plugins are:

- `ember`: modes, questionnaire, footer, and compact edit rendering.
- `subagent`: bundled subagent tool and agent definitions.
- `devin-auth`: Devin provider, OAuth, catalog refresh, and streaming.

## Project setup

The Ember repository contains a project-local `.pi/settings.json` entry for:

```json
"npm:@nmzpy/pi-ember-stack@0.1.2"
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

The package entrypoint is `plugins/index.ts`. Ember functionality is under
`plugins/ember/`, subagents and bundled agents are under `plugins/subagent/`,
and Devin auth is under `plugins/devin-auth/`.

Run the package typecheck with:

```text
npm install
npm run typecheck
```

## Release

Run `./gacp.sh --release` to bump the patch version, typecheck, commit, tag,
push, and publish the package to npm. This only publishes the package; update
Ember's pinned package version separately when you want the project to install it.

The package is cross-platform: bundled paths are resolved from `import.meta.url`
and do not depend on a Windows home directory or the current working
directory.
