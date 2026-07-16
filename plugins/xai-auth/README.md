# pi-xai-auth

xAI (Grok) OAuth provider for [pi](https://pi.dev) — Grok 4.5, Grok 4.3, Grok Build,
Composer 2.5, and Grok 4.20 variants with PKCE OAuth login, automatic token
refresh, Grok CLI credential reuse, and a suite of custom xAI tools.

Forked from [pi-xai-oauth](https://github.com/BlockedPath/pi-xai-oauth) (MIT)
and adapted for the `pi-ember-stack` plugin architecture.

## Installation in pi-ember-stack

Bundled by `@nmzpy/pi-ember-stack` and enabled through the global
`PI_HOME/pi-ember-stack.json` plugin list. Toggle it with `/stack-plugins`
or remove `xai-auth` from that list, then restart pi.

## Usage

### Login

```
/login xai-auth
```

Opens the xAI OAuth page in your browser. After approving, the browser
redirects to a local callback server. If localhost is blocked (VPN, WSL,
remote SSH), paste the redirect URL into the pi prompt.

Reuses existing `~/.grok/auth.json` credentials from the official Grok CLI
when present.

### Select a model

```
/model grok-4.5
/model grok-4.3
/model grok-build
/model grok-composer-2.5-fast
```

### Reasoning levels

```
/think high
/think medium
/think low
```

### Status

```
/xai-status
```

## How it works

```
pi  --login-->  auth.x.ai (PKCE OAuth)  --callback-->  token exchange  --credentials-->  ~/.pi/agent/auth.json
pi  --chat-->   streamSimpleXaiResponses()  -->  pi OpenAI Responses transport  -->  api.x.ai/v1/responses  -->  pi events
```

Grok Build and Composer route through `cli-chat-proxy.grok.com` with Grok CLI
proxy headers. All other models hit `api.x.ai` directly.

## Improvements from devin-auth

- **AbortError guard**: Swallows `DOMException [AbortError]` unhandled
  rejections from cancelled agent runs so the process doesn't crash.
- **Session-replacement discipline**: `session_shutdown` clears module-level
  state and removes the rejection handler so jiti-cached modules don't
  survive across sessions with stale references.
- **Status command**: `/xai-status` for quick auth diagnostics.
- **Typed entry point**: Proper `async` factory with typed `ExtensionAPI`,
  constants extracted to SSOT with `XAI_PROVIDER_NAME`, `XAI_OAUTH_NAME`,
  and `XAI_API_IDENTIFIER`.

## License

MIT (original: BlockedPath/pi-xai-oauth)
