---
name: pi-dcp
description: Use the pi-ember-dcp Dynamic Context Pruning tools and slash commands to keep long pi sessions cheap. Triggers on long tutoring or coding loops, repeated tool failures, "context filling up" nudges, and any request to compress, summarize, or inspect token usage.
---

# pi-ember-dcp — Dynamic Context Pruning

`pi-ember-dcp` is the Ember-owned fork of `pi-dcp` (AGPL-3.0-or-later). It
reduces token spend in long sessions through three mechanisms:

1. **Automatic deduplication** — When the same tool is called with the same
   arguments more than once, only the latest output is sent to the LLM. Older
   duplicates are replaced with a `[pruned by pi-dcp: duplicate ... call]`
   placeholder. Session history on disk is never rewritten.
2. **Errored input purging** — Tool calls that errored have their *inputs*
   stripped after `strategies.purgeErrors.turns` turns (default: 2). The error
   message is preserved so the model can still recover; only the (often huge)
   failed payload is removed.
3. **LLM-callable `compress` tool** — The model can summarize closed
   work-streams into a lossless technical summary. The summary replaces the
   original tool outputs on the next LLM request only.

Adapted from `@davecodes/pi-dcp` 0.2.0 by Davidcreador
(<https://github.com/Davidcreador/pi-dcp>). License retained in
`plugins/pi-ember-dcp/LICENSE`.

## When to call `compress`

Default config registers **range mode**:

```text
compress(startToolCallId, endToolCallId, topic, summary)
```

If `compress.mode` is `"message"`, the schema is:

```text
compress(toolCallIds, topic, summary)
```

Call `compress` when:

- A discovery phase is finished (initial repo scan, finding the bug location)
  and you no longer need the raw `grep`/`read` output.
- A long failing retry loop has been resolved and the verbose failures are no
  longer informative.
- A logically closed sub-task is complete and you can move on with just the
  conclusions.

**Never compress** the most recent turn, in-flight work, or anything containing
facts the user just asked about. Compressions preserve only what is in the
`summary` argument — be terse but lossless on file paths, line numbers, errors,
and decisions. Targets inside `turnProtection` are refused upfront.

## Slash commands

| Command | Purpose |
|---|---|
| `/dcp` / `/dcp help` | Show command list |
| `/dcp context` | Current session token usage + DCP savings + active compressions |
| `/dcp stats` | Cumulative lifetime DCP savings across all sessions |
| `/dcp sweep [n]` | Stage a compression over the last `n` tool results (default: since last user msg) |
| `/dcp manual [on\|off\|toggle\|status]` | Control runtime manual mode (edit config to persist) |
| `/dcp decompress <id>` | Temporarily restore a compression's original tool outputs |
| `/dcp recompress <id>` | Re-apply a previously decompressed entry |

## Configuration

Defaults are auto-written to `~/.pi-dcp/config.json` on first run. Per-project
overrides go in `<cwd>/.pi/dcp.json`. Restart pi (or `/reload`) after changes.
Ember stack toggle: `/stack-plugins` or the global `pi-ember-stack.json`
`plugins` list (`pi-ember-dcp`).

Notable knobs:

- `compress.mode` — `"range"` (default; start+end span) or `"message"`
  (individual `toolCallIds[]`).
- `compress.minContextLimit` / `compress.maxContextLimit` — soft floor/ceiling
  for system-prompt nudges. Accepts a number or `"X%"` of the model's context
  window.
- `compress.modelMinLimits` / `modelMaxLimits` — per-model overrides keyed by
  `"<provider>/<id>"`.
- `compress.permission` — `"allow"` (default), `"ask"`, or `"deny"` (tool not
  registered at all).
- `compress.nudgeForce` — `"soft"` or `"strong"` wording for the in-window nudge.
- `compress.nudgeFrequency` (per-fetch) and `compress.nudgeEveryTurns` (per-turn)
  — stacked throttles for the soft/strong nudge.
- `compress.iterationNudgeThreshold` — fire an iteration nudge after N non-user
  messages since the last user message, even below the context floor. `0`
  disables.
- `turnProtection.enabled` / `turns` — the last N user-bounded turns are immune
  to ALL pruning. The compress tool also refuses targets inside this window.
- `manualMode.enabled` / `automaticStrategies` — silence the LLM compress tool
  and optionally also skip dedup/purge. Stored compressions still apply.
- `experimental.customPrompts` — honor user overrides in
  `~/.pi-dcp/prompts/overrides/`.
- `strategies.deduplication.enabled` / `strategies.purgeErrors.enabled` —
  independent on/off switches.
- `*.protectedTools` — additional tool names that must never be pruned.

## Guardrails (always on)

`compress`, `write`, `edit`, `todo`, `task`, and `skill` are *never*
deduplicated or purged (`ALWAYS_PROTECTED_TOOLS`). Their outputs are also
appended verbatim when included in a compression range. Pipeline exceptions
pass the original messages through unchanged so a broken prune cannot destroy
a request.
