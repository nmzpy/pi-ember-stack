# pi-cursor-auth

Cursor subscription provider for [Pi](https://pi.dev), bundled as part of
`@nmzpy/pi-ember-stack`.

The provider uses the official Cursor Agent CLI's browser-authenticated session.
It does not require or accept a Cursor SDK API key. Pi continues to own the
conversation, tool loop, tool permissions, rendering, and session persistence.

## Requirements

- Install the official Cursor Agent CLI.
- Ensure `cursor-agent` is available, or set `CURSOR_AGENT_EXECUTABLE` to its
  executable path.
- Authenticate with `/login cursor` or `cursor-agent login`.

The provider deliberately does not fall back to an executable named `agent`,
because other products use that ambiguous command name. It also does not provide
an API-key or `cursor/auto` fallback: the CLI must be installed, authenticated,
and able to list models before Cursor models appear in `/model`.

If `cursor-agent` is missing at startup, the rest of `pi-ember-stack` still
loads; the Cursor provider registers with an empty catalog. On `/login cursor`,
streaming, or `/cursor-refresh-models`, the plugin ensures the official CLI is
installed (via Cursor.app's `cursor agent` helper on macOS when present, otherwise
`https://cursor.com/install`) and then proceeds.

## Usage

```text
/login cursor
/cursor-refresh-models
/model cursor/<model-id>
```

Run `/cursor-refresh-models` to see the available model ids from your subscription. There is no `cursor/auto` fallback; the plugin fails loudly if the CLI is missing, unauthenticated, or returns no models.

Diagnostics and logout:

```text
/cursor-status
/cursor-logout
```

`/login cursor` delegates browser authentication to Cursor Agent. Cursor owns
and stores the subscription credential; Pi stores only a non-secret marker so
its normal provider login UI recognizes the completed login.

## Transport

Each Pi provider turn starts Cursor Agent in `stream-json` print mode and sends
a neutral serialization of Pi's existing system prompt, ordered messages, and
active function schemas. The serialization does not add a Cursor/Composer
persona or replace Pi's system prompt.

Cursor text and thinking events become native Pi stream events. A Cursor tool
event is accepted only when it resolves to a tool in Pi's active tool list; Pi
then executes the tool through its normal lifecycle. Cursor wraps Model Context
Protocol server tool calls in an `mcpToolCall` envelope; the provider unwraps
the envelope and resolves the inner tool name (`args.name`/`args.tool_name`)
through Pi's registry before execution. Unknown tool events stop the request
and surface an error.

Image input is advertised and passed through as base64 data URLs in the serialized request.

## Provenance

The Cursor CLI executable resolution, model-output parsing, stream event shapes,
and tool-event compatibility behavior were informed by
[Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor), licensed
under BSD-3-Clause. See `LICENSE`.
