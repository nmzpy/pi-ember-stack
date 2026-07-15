# pi-subagent

Isolated in-process subagents for Pi. The `subagent` tool supports single, parallel (8 tasks, 4 concurrent), and chained execution; `/agent` opens inspectable child threads.

## Install

```bash
pi install npm:@bacnh85/pi-subagent
# local checkout
pi install ./pi-subagent
```

## Bundled roles

| Role | Model | Thinking | Tools |
| --- | --- | --- | --- |
| `Scout` | parent model | high | read, bash, grep, find, ls |
| `Coder` | parent model | medium | read, bash, edit, write, grep, find, ls |

Bundled roles inherit the parent model so they work with the account already active in Pi. User/project agent files may override `model` and `thinking`.

## Agent naming

- **Single mode** shows the bare agent name: `Scout` or `Coder`.
- **Parallel/chain mode** assigns a session-global per-type letter so individual agents are easy to track: `Coder A`, `Coder B`, `Scout A`, `Scout B`, etc. The letter persists across tool calls within a session and resets on session replacement (`/resume`, `/new`, `/fork`, `/reload`). The lettered name appears in the TUI render, the thread viewer, and the tool result text returned to the orchestrating agent.

## Agent files

Create `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`:

```markdown
---
name: Scout-fast
description: Locate relevant files and symbols
tools: read, grep, find, ls
thinking: low
model: optional-provider/optional-model
---

Return concise evidence with file/symbol anchors.
```

Project agents require confirmation when requested through the public tool. Definitions are cached with file-signature invalidation; `/subagent reload` clears the cache.

## Context and limits

Children use in-memory SDK sessions with no extensions, skills, prompt templates, or automatic `AGENTS.md` loading. The optional `instructions` argument passes a bounded 16 KB task/repository contract. Only Pi built-in tools are available; Serena, FFF, web, and Munin are not available in lean children.

Threads are session-memory only and are cleared when Pi replaces or reloads the session. Timeout and parent cancellation propagate to child sessions. Subagents cannot recursively invoke `subagent`.

## Extension contract

`pi-subagent` owns the `pi-subagent:run` event contract for one named-agent request. `pi-review` uses it for isolated review. Requests use an immediate boolean `accept()` claim and exactly one `respond()` callback; this suppresses duplicate responders while missing services and timeouts remain caller-controlled.

See [`agent-format.md`](./agent-format.md) for all frontmatter fields.
