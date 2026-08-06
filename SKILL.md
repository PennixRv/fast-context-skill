---
name: fast-context
description: Use this on-demand external semantic search only after local search and CodeGraph cannot identify the relevant code location.
metadata:
  short-description: On-demand semantic code candidates
---

# Fast Context

Fast Context is an external, opt-in search helper. It returns untrusted file
candidates; inspect every candidate locally before relying on it. The CLI is
the security boundary: prompts do not create registration, approval, or
whitelist state.

## Routing

1. Search the explicit project root with local `rg`, direct reads, and existing
   project tools.
2. Use CodeGraph for known symbols, callers, relationships, and impact work.
3. Use this Skill only when the location is genuinely unknown or the request
   describes vague business or legacy behavior.

Skip Fast Context for known files or symbols, literal/config/log searches,
external documentation, ordinary conversation, or requests that only need
local impact analysis.

## Invocation

Provide one existing project directory and one natural-language query:

```bash
node /path/to/fast-context-skill/scripts/fast-context-search.mjs \
  --project "/absolute/path/to/project" \
  --query "Where is the legacy import flow implemented?"
```

The only optional controls are bounded `--max-results` and repeatable,
relative additive `--deny` patterns. The command reads only the explicit
`WINDSURF_API_KEY` environment variable. It never discovers credentials from
desktop state, prints keys, persists prompts or responses, or emits raw remote
errors. Do not run it without a user-provided key and never place a key in a
file, command history, log, or commit.

Before using a result, resolve its relative path inside the same project and
read the relevant lines locally. A network failure or malformed response is a
closed `FC_*` diagnostic and should be handled as an unavailable hint, not as
evidence about the repository.
