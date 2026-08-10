---
name: fast-context
description: Automatically route genuinely ambiguous business, historical, or legacy code-location questions to bounded external semantic search only after local tools and CodeGraph cannot locate the answer; never trigger on natural language alone.
metadata:
  short-description: On-demand semantic code candidates
---

# Fast Context

Fast Context is an external, on-demand search helper. It returns untrusted file
candidates; inspect every candidate locally before relying on it. The CLI is
the security boundary: prompts do not create registration, approval, or
whitelist state. Do not add an MCP server, hook, plugin, project registration,
approval, or persistent index integration.

## Routing

1. Use local tools against the explicit project root for known files, literals,
   configuration, logs, and realtime content.
2. Use CodeGraph for known symbols, callers/callees, structure, relationships,
   and impact analysis.
3. Use this Skill only when the location is genuinely unknown and both local
   retrieval and CodeGraph cannot locate useful candidates for vague business
   semantics, historical names, or legacy behavior.

Do not trigger this Skill merely because a request is written in natural
language. Do not run CodeGraph and Fast Context automatically in parallel, and
do not treat one CodeGraph miss as a mechanical external fallback. Skip Fast
Context for known files, known symbols, literals/configuration/log searches,
external documentation, ordinary conversation, and requests that only need
local impact analysis.

## Invocation

Provide one existing project directory and one natural-language query:

```bash
node /path/to/fast-context-skill/scripts/fast-context-search.mjs \
  --project "/absolute/path/to/project" \
  --query "Where is the legacy import flow implemented?"
```

The only optional controls are bounded `--max-results`, repeatable relative
additive `--deny` patterns, and `--no-external`. The command first accepts an
explicit `WINDSURF_API_KEY`. On Linux/WSL only, a missing explicit key may use
the current user's Devin CLI login through a package-owned, bounded no-shell
helper. That helper has one fixed credentials path, rejects symlinks, oversize
files, unknown fields and unsupported values, and never scans desktop state.
It never prints keys, persists prompts or responses, or emits raw remote
errors. Do not copy a credential into a file, command history, log, or commit.
Use `--no-external` when the caller must prevent all credential access and
remote search.

Before using a result, resolve its relative path inside the same project root
and read the relevant lines locally. When relationship analysis is needed,
expand the verified candidate with CodeGraph. Fast Context output is always a
candidate, never repository truth: do not write it to Trellis, OpenViking,
CodeGraph, or context-mode persistent indexes. A network failure or malformed
response is a closed `FC_*` diagnostic and should be handled as an unavailable
hint, not as evidence about the repository.
