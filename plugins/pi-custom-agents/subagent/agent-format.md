# Agent Definition Format

Sub-agents are defined as Markdown files with YAML frontmatter.

## File Location

| Location | Scope |
|----------|-------|
| `~/.pi/agent/agents/*.md` | User-level (all projects) |
| `.pi/agents/*.md` | Project-level |
| `<package>/agents/*.md` | Bundled with pi-subagent |

Project agents override user agents with the same name when `agentScope: "both"`.

## Frontmatter Fields

```yaml
---
name: my-agent          # Required. Unique identifier (kebab-case).
description: ...        # Required. When to use this agent.
tools: read, grep, ...  # Optional. Comma-separated tool names. Defaults to all.
model: provider/model     # Optional. Defaults to parent's model.
thinking: low             # Optional: off|minimal|low|medium|high|xhigh|max.
---
```

Only `name` and `description` are required.

## Body

The body after frontmatter becomes the agent's **entire system prompt**. No pi defaults, no AGENTS.md files, no skills — only what you write here. Keep it focused.

## Available Tools

Built-in pi tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

The code-edit tool is provider-aware: sub-agents receive `edit` unless the
resolved model's provider is `openai-codex`, in which case they receive
`apply_patch` instead. `apply_patch` and `edit` are both valid in frontmatter,
but the runner normalizes the list to the provider-appropriate tool via
`with_provider_patch_tool` (`pi-custom-agents/edit-tools.ts` SSOT) — never
hardcode the patch tool elsewhere.

The `subagent` tool is never available to sub-agents (prevents accidental recursion). Sub-agents run at one level of delegation only; they cannot spawn further sub-agents.

Custom/extension tools are NOT available to sub-agents by default. Child sessions load Pi compaction only — not the full parent extension stack.

## Context management

Child sessions enable **Ember-owned Pi compaction** (threshold/overflow recovery) via the shared `compaction-wiring.ts` / `stack-compaction.ts` summarizer (same structured checkpoint as the parent session).

## Model Resolution

Model IDs are resolved via `getModel("provider", "id")`. Common values:
- `claude-haiku-4-5` (Anthropic Haiku — fast, cheap)
- `claude-sonnet-4-20250514` (Anthropic Sonnet — balanced)
- `gpt-4o` (OpenAI)
- Any model available in your pi configuration.

If not specified, defaults to the parent session's model.

## Instruction handoff

Children do not automatically load repository instructions. Callers may pass an `instructions` task contract, truncated to 16 KB. Use this for relevant repository rules or review contracts rather than copying the parent transcript.

## Token Budget

Each sub-agent runs with:
- **System prompt**: agent body only (~200-1K tokens typical)
- **No AGENTS.md**: saves 500-5K tokens
- **Pi compaction**: enabled with Ember summarizer checkpoints on threshold/overflow
- **Thinking per role**: defaults off; bundled Scout/Coder choose high/medium

This is ~10x leaner than spawning a full `pi` process.
