# pi-ember-todo

Ember-owned task list extension for Pi. Registers the `todo` tool, the
`/todos` slash command, and a persistent `TodoOverlay` widget that renders
above the editor.

Adapted from `@xaccefy/pi-xtodo` (MIT License, Copyright (c) 2025 x4cc3) —
see `./LICENSE` for upstream attribution. The adaptation is distributed
under AGPL-3.0-or-later as part of `pi-ember-stack`.

## Tool: `todo`

| Action   | Purpose                                                       |
| -------- | ------------------------------------------------------------- |
| `create` | New task (`subject` needed); optional `blockedBy`, `description`, `owner` |
| `update` | Change fields / status / links (`id` needed)                  |
| `list`   | Filter by `status`; `includeDeleted` for tombstones           |
| `get`    | Full detail including blockedBy / blocks                      |
| `delete` | Soft-delete (kept as a tombstone)                             |
| `clear`  | Clear all tasks                                               |

### Status lifecycle

```
pending ↔ in_progress → completed → deleted
                ↘ deleted
```

- `completed → pending` is **not** allowed (make a new task to reopen).
- Ids must be **whole positive numbers** (`"1"` works; `"2.7"` / `"1e2"` are rejected).

### Dependencies

- `blockedBy` / `addBlockedBy` / `removeBlockedBy` form a DAG; cycles are rejected.
- **Deleting** a task (or `update status: deleted`) **pulls** its id out of every other
  task's `blockedBy`, so dependents don't hang on a tombstone.

### Persistence

- Main copy: the session's tool-result history (replay on `session_start` / compact / tree).
- If that's empty, use the disk file `~/.pi/ember-todo/<safe-session-id>.json`
  (override the directory with `PI_EMBER_TODO_DIR`).
- Session ids are cleaned so they can't escape the folder.

## Command

- `/todos` — grouped summary (interactive mode)

## Development

```bash
./t.gate.sh plugins/pi-ember-todo/index.ts   # lint + typecheck
buntest plugins/pi-ember-todo                 # tests
```
