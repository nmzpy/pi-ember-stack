# pi-cursor-auth

Cursor subscription provider for [Pi](https://pi.dev), bundled as part of
`@nmzpy/pi-ember-stack`.

The provider talks **cloud-direct** to `api2.cursor.sh` over Connect-RPC
(`agent.v1.AgentService/Run`). Pi owns the full conversation context and tool
loop; native `toolcall_*` stream events feed **pi-compact-tools** rendering.

No `cursor-agent` subprocess is required for the default path.

## Requirements

- A Cursor subscription account.
- Browser available for PKCE OAuth (`/login cursor`).

## Usage

```text
/login cursor
/cursor-refresh-models
/model cursor/<model-id>
```

Diagnostics and logout:

```text
/cursor-status
/cursor-logout
```

`/login cursor` opens Cursor's browser OAuth flow (PKCE). Pi stores OAuth
`access` / `refresh` tokens in `auth.json` like other providers.

## Architecture

```text
Pi agent loop
  → stream_cursor() (streamSimple)
  → map_context_to_cursor() — full messages + tools
  → cloud-direct AgentService/Run (HTTP/2 via Node h2-bridge)
  → native text/thinking/toolcall events
  → Pi executes tools (bash rules, DCP, compact rendering)
```

### Key behaviors

- **Full Pi context** each turn (messages with assistant tool calls, tool results,
  system prompt). Hidden `pi-agents-*` injections are filtered via the same SSOT
  as `build_cursor_user_prompt()`.
- **Pi executes tools** — Cursor native filesystem/shell tools are rejected;
  Pi tools are exposed via Cursor's MCP exec path.
- **History rebuild** — completed assistant tool calls are encoded as MCP
  `ConversationStep` bytes (`cloud-direct/history.ts`); pending results carry
  `tool_call_id` markers in outbound user text.
- **Per-session checkpoints** — conversation state is keyed by Pi session id, not
  `cwd`; `/resume` preserves checkpoint state for that session.
- **Parallel tool batching** — multiple MCP tool requests in one `Run` stream
  are collected and emitted as several `toolcall_*` blocks with a single
  `toolUse` finish so Pi can execute them in one turn.
- **Mode directives** prepend to the system prompt on the first turn and after
  Pi mode changes (`plan`, `code`, `debug`, `orchestrate`).
- **Reasoning models** are detected via `CURSOR_REASONING_MODEL_PATTERNS` and
  forward `thinking_*` events natively.
- **Windows HTTP/2** uses an isolated Node `h2-bridge.mjs` child process
  (Bun's `node:http2` is unreliable against Cursor's API).

## Commands

| Command | Description |
|---------|-------------|
| `/login cursor` | PKCE browser OAuth |
| `/cursor-status` | Auth + model catalog probe |
| `/cursor-refresh-models` | Re-fetch `GetUsableModels` |
| `/cursor-logout` | Clear OAuth + cached checkpoints |

## Provenance

Wire protocol, OAuth PKCE flow, h2-bridge, and protobuf schemas are adapted from
[ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
(BSD-3-Clause). See `LICENSE`.

Pi integration shape follows `plugins/devin-auth/` (cloud-direct + context-map +
native `streamSimple` events).
