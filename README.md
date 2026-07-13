# pi-agents

Personal pi extension providing toggleable primary agent modes for Ember:

- `/coder`: full implementation access.
- `/architect`: read-only investigation and planning.
- `/doctor`: read-only engineering health check.
- `/orchestrator`: read-only task decomposition and delegation planning.
- `/ui-doctor`: read-only PySide6/Qt UI diagnosis.
- `/subagent-model`: choose the model for the project-local coder or architect subagent.

## Development

The canonical extension source is `src/pi-agents.ts`.

Pi discovers the global loader at
`C:\Users\nmz\.pi\agent\extensions\pi-agents.ts`, which re-exports this source
file. Changes in this repository take effect after restarting pi or running
`/reload`.

The Ember-specific subagent definitions remain in:

- `C:\Work\Ember\.pi\agents\coder.md`
- `C:\Work\Ember\.pi\agents\architect.md`

## Validation

Start pi from `C:\Work\Ember` after changing the extension and run `/reload`.
Confirm the footer shows the active mode in the form:

`Coder • openai-codex: GPT-5.5 high`
