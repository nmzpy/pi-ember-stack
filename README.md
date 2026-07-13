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
- A self-contained `Ctrl+Space` mode-cycle shortcut and a footer showing the
  active mode, model, and thinking variant.

## Project setup

The Ember repository contains a project-local `.pi/settings.json` entry for:

```json
"npm:@nmzpy/pi-ember-stack@0.1.0"
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

Third-party utilities such as pi-fff, image paste, and Devin authentication
remain separate package entries. Credentials and provider secrets stay in the
machine-local pi configuration and are not part of this repository.

## Development

The package entrypoint is `src/pi-ember-stack.ts`. The vendored subagent
entrypoint is `src/subagent/extensions/index.ts`; all bundled agent files are
under `src/subagent/agents/`.

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
