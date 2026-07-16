# pi-devin-auth

A [pi](https://pi.dev) coding agent extension that adds the **Devin** (Cognition / Windsurf) provider with browser-based OAuth login and native streaming.

## Installation in pi-ember-stack

This implementation is bundled by `@nmzpy/pi-ember-stack` and enabled through
the global `PI_HOME/pi-ember-stack.json` plugin list. Toggle it with `/stack-plugins`
or remove `devin-auth` from that list, then restart pi.

### Manual / local development

```bash
pi -e ./extensions/index.ts
```

Or copy `extensions/index.ts` into `~/.pi/agent/extensions/` for auto-discovery.

## Usage

### Login

```
/login devin
```

This opens `https://windsurf.com/windsurf/signin` in your browser. After signing in, the page displays an auth token — paste it into the pi prompt. The extension exchanges it for a long-lived Devin API key via `register.windsurf.com`.

### Select a model

```
/model devin/swe-1-6
```

### Logout

```
/logout devin
```

## How it works

```
pi  --login-->  windsurf.com (Auth0)  --token-->  register.windsurf.com (RegisterUser)  --api_key-->  ~/.pi/agent/auth.json
pi  --chat-->   streamDevin()  -->  cloud-direct/streamChatEvents()  -->  server.codeium.com (GetChatMessage gRPC)  -->  pi events
```

The extension reuses the battle-tested cloud-direct gRPC layer from [opencode-windsurf-auth](https://github.com/rsvedant/opencode-windsurf-auth) and wraps it in pi's native `streamSimple` + `oauth` extension API.

## Models

Models are fetched dynamically from Cognition's `GetCascadeModelConfigs` RPC after login, so the list always reflects what your account tier can access. A static fallback set is included for offline use.

## License

MIT
