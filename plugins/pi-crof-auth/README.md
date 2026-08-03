# pi-crof-auth

CrofAI provider for [Pi](https://pi.dev), bundled as part of
`@nmzpy/pi-ember-stack`. CrofAI exposes a fully OpenAI-compatible API at
`https://crof.ai/v1`, so the built-in `openai-completions` stream handles chat,
tool calls, structured outputs, and extended reasoning (`reasoning_content`)
natively. Auth is a plain API key.

## Requirements

- A [CrofAI](https://crof.ai) account and API key.

## Usage

```text
/login crof
/model crof/deepseek-v4-flash
```

`/login crof` prompts for your API key (from the CrofAI dashboard) and persists
it through Pi's standard credential storage. Diagnostics:

```text
/crof-status
/crof-usage
/crof-refresh-models
/crof-logout
```

The API key can also be supplied without the interactive flow via the
`CROF_API_KEY` (or `CROFAI_API_KEY`) environment variable, or an
`api_key`-type credential in `~/.pi/agent/auth.json`:

```json
{
  "crof": {
    "type": "api_key",
    "key": "nahcrof_..."
  }
}
```

## Model catalog

Models are discovered live from `https://crof.ai/v1/models` and mapped into Pi
`ProviderModelConfig`s: `context_length` → context window,
`max_completion_tokens` → max output, `reasoning_effort`/`custom_reasoning` →
extended thinking, and per-million-token `pricing` → cost. Reasoning models
expose a `thinkingLevelMap` (`off → none`, `minimal/low → low`,
`medium → medium`, `high/xhigh/max → high`) and use the `max_tokens` field with
`reasoning_effort`, matching CrofAI's supported parameters.

## Commands

| Command | Description |
|---------|-------------|
| `/login crof` | Prompt for and store your CrofAI API key |
| `/crof-status` | Auth, catalog, and usage probe |
| `/crof-usage` | Remaining requests + credit balance |
| `/crof-refresh-models` | Re-fetch `/v1/models` |
| `/crof-logout` | Clear stored credential + cached catalog |

## Architecture

```text
/model crof/<id>
  → openai-completions (built-in stream)
  → https://crof.ai/v1/chat/completions
  → Authorization: Bearer <api-key>
  → text / reasoning_content / tool call events → Pi
```

The provider is registered with an `oauth` block whose `login()` collects the
API key via `onPrompt` and returns it as `OAuthCredentials.access`. Pi resolves
`getApiKey(credentials)` to the bearer token for every request and persists the
credential so `/resume` and later sessions stay signed in.

## LICENSE

MIT — see `LICENSE`.
