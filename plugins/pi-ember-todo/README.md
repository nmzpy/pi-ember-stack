# pi-ember-todo

Ember-owned task list extension for Pi. Registers the `todo` tool and the
`/todos` slash command. Todo tool calls render as a compact header with
subject-only task rows in the chat transcript; descriptions, metadata, active
forms, and dependency details remain available to the model and `/todos`
command with no above-editor overlay.

Adapted from `@xaccefy/pi-xtodo` (MIT License, Copyright (c) 2025 x4cc3) —
see `./LICENSE` for upstream attribution. The adaptation is distributed
under AGPL-3.0-or-later as part of `pi-ember-stack`.

## Tool: `todo`

| Action   | Purpose                                                       |
| -------- | ------------------------------------------------------------- |
| `create` | New task (`subject` needed); optional `blockedBy`, `description`, `owner` |
| `update` | Change fields / status / links (`id` or exact `task`)          |
| `list`   | Filter by `status`; `includeDeleted` for tombstones           |
| `get`    | Full detail including blockedBy / blocks (`id` or `task`)      |
| `delete` | Soft-delete (kept as a tombstone; `id` or `task`)              |
| `clear`  | Clear all tasks                                               |

### Status lifecycle

```
pending ↔ in_progress → completed → deleted
                ↘ deleted
```

- `completed → pending` is **not** allowed (make a new task to reopen).
- Ids are whole positive numbers; provider strings such as `"1"` and `"#1"` are normalized.
- `update`, `get`, and `delete` can target an exact subject with `task` when the id is not known.

### Dependencies

- `blockedBy` / `addBlockedBy` / `removeBlockedBy` form a DAG; cycles are rejected.
- **Deleting** a task (or `update status: deleted`) **pulls** its id out of every other
  task's `blockedBy`, so dependents don't hang on a tombstone.

### Persistence

- Main copy: the session's tool-result history (replay on `session_start` / compact / tree).
- **Compaction resets the list.** When the session is compacted, only todo results
  created after the compaction entry survive; pre-compaction tasks are dropped and
  the next `todo create` restarts at `#1`.
- If the history is temporarily unavailable, use the disk file `~/.pi/ember-todo/<safe-session-id>.json`
  (override the directory with `PI_EMBER_TODO_DIR`). The disk copy is overwritten
  with the fresh (empty) state on compaction so a restart cannot restore the old list.
- Session ids are cleaned so they can't escape the folder.

## Command

- `/todos` — grouped summary (interactive mode)

## Development

```bash
./t.gate.sh plugins/pi-ember-todo/index.ts   # lint + typecheck
buntest plugins/pi-ember-todo                 # tests
```
