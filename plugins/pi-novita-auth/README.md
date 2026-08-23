# pi-novita-auth

Novita provider for [Pi](https://pi.dev), bundled as part of
`@nmzpy/pi-ember-stack`. Novita exposes a fully OpenAI-compatible API at
`https://api.novita.ai/v3/openai`, so the built-in `openai-completions` stream
handles chat, tool calls, structured outputs, and extended reasoning
(`reasoning_content`) natively. Auth is a plain API key.

## Requirements

- A [Novita](https://novita.ai) account and API key.

## Usage

```text
/login novita
/model novita/deepseek/deepseek-r1
```

`/login novita` prompts for your API key (from the Novita dashboard → Settings →
API Keys) and persists it through Pi's standard credential storage. Diagnostics:

```text
/novita-status
/novita-refresh-models
/novita-logout
```

The API key can also be supplied without the interactive flow via the
`NOVITA_API_KEY` environment variable, or an `api_key`-type credential in
`~/.pi/agent/auth.json`:

```json
{
  "novita": {
    "type": "api_key",
    "key": "nvapi-..."
  }
}
```

## Model catalog

Models are discovered live from `https://api.novita.ai/v3/openai/models` and
mapped into Pi `ProviderModelConfig`s: `context_size` → context window,
`title` → display name, and per-million-token prices
(`input_token_price_per_m` / `output_token_price_per_m`, reported as integers in
1/10,000 USD) → cost. Reasoning models (ids containing `r1`, `qwq`, `qvq`,
`qwen3`, `thinking`, `glm-z1`, or `hunyuan`) expose a `thinkingLevelMap` and use
`reasoning_effort` with the `max_tokens` field, matching Novita's supported
parameters.

## Commands

| Command | Description |
|---------|-------------|
| `/login novita` | Prompt for and store your Novita API key |
| `/novita-status` | Auth + catalog probe |
| `/novita-refresh-models` | Re-fetch `/v3/openai/models` |
| `/novita-logout` | Clear stored credential + cached catalog |

## Architecture

```text
/model novita/<id>
  → openai-completions (built-in stream)
  → https://api.novita.ai/v3/openai/chat/completions
  → Authorization: Bearer <api-key>
  → text / reasoning_content / tool call events → Pi
```

The provider is registered with an `oauth` block whose `login()` collects the
API key via `onPrompt` and returns it as `OAuthCredentials.access`. Pi resolves
`getApiKey(credentials)` to the bearer token for every request and persists the
credential so `/resume` and later sessions stay signed in.

## LICENSE

MIT — see `LICENSE`.
