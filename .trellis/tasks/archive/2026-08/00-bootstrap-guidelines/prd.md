# Bootstrap Task: Trellis Asset Ownership

## Goal

Establish Git ownership for the durable Trellis project layer before any Fast
Context implementation work begins. The repository must use Trellis channels
for delegated work and must not retain a Codex-native subagent dispatch path.

## Confirmed Facts

- `trellis init` has already generated `.trellis/`, `.agents/`, `.codex/`,
  `AGENTS.md`, and `.gitattributes`; all were initially untracked.
- `.trellis/.gitignore` excludes developer identity, task/runtime state, agent
  runtime files, temporary files, backup files, and Python cache.
- The durable Trellis assets named in the release plan are intended to be
  versioned, including task records and mergeable workspace journals.
- The generated Codex integration included native agent profiles, a
  `SubagentStart` hook, and `inject-subagent-context.py`.

## Requirements

1. Track the durable project-scoped Trellis assets, `.agents/skills/`,
   `.gitattributes`, `AGENTS.md`, and the retained `.codex/` integration.
2. Preserve every exclusion already declared in `.trellis/.gitignore`; do not
   add local identity, runtime state, credentials, or caches to Git.
3. Configure `codex.dispatch_mode: inline`.
4. Remove `.codex/agents/`, the `SubagentStart` hook, and the unused
   `inject-subagent-context.py` implementation.
5. Retain only the Codex project-document discovery configuration and the
   `UserPromptSubmit` workflow-state hook.
6. Update project instructions and workflow routing so only the coordinator
   may delegate and all delegation uses `trellis channel`.
7. Create one local bootstrap commit containing only the reviewed ownership
   changes. Do not push, tag, or create a release.

## Acceptance Criteria

- `git check-ignore` confirms `.trellis/.developer`, `.trellis/.runtime/**`,
  and Python cache files remain ignored while durable Trellis paths are staged.
- `.codex/hooks.json` has no `SubagentStart` registration and no
  `.codex/agents/` or `inject-subagent-context.py` remains.
- `python3 ./.trellis/scripts/get_context.py --mode phase` reports the inline
  workflow with no syntax or configuration error.
- The bootstrap commit contains no Fast Context source, package metadata, or
  credential material.

## Out Of Scope

- Fast Context runtime behavior, tests, package metadata, Skill text, CI, or
  release workflows.
- `trellis init`, `.trellis` reset, global Codex configuration, homewsl,
  CodeGraph, context-mode, npm publication, Git tags, and GitHub Releases.

## Completion Checklist

- [x] Audit generated Trellis, agent, Codex, and Git-attribute assets.
- [x] Classify durable assets and retain runtime/local identity exclusions.
- [x] Remove native Codex subagent dispatch and synchronize project routing.
- [x] Run bootstrap validation.
- [x] Create the local bootstrap commit (`cfbe51e`).
