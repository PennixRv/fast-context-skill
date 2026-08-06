# Implementation Plan

Implementation is not authorized until the user approves the final planning
summary and Trellis changes the task status to `in_progress` with
`task.py start`. All parallel investigation or review remains in Trellis
channels; the coordinator owns product edits and commits.

## Ordered Checklist

1. Run `trellis-before-dev` after approval; read the applicable `.trellis/spec`
   guidance and confirm the worktree contains only the expected task artifacts.
2. Add offline parser and path-guard fixtures and tests first. Implement the
   finite argv grammar, canonical root, traversal/symlink/type checks,
   hard-deny matching, additive `--deny`, and stable closed error codes in
   `scripts/lib/path-guard.mjs` and the CLI boundary.
3. Route executor `rg`, `readfile`, `tree`, `ls`, and `glob`, repository-map
   builders, and directory scoring through the guard. Restrict `rg` to a
   finite guard-approved regular-file list, fixed argv with `--regexp` and
   `--`, an absolute executable, and a minimal explicit environment. Test
   every primitive and a spawn spy against the full rejection matrix,
   dash-prefixed inputs, inherited-config sentinels, and outside/denied files.
4. Remove `extract-key.mjs`, discovery imports, database access, and all
   removed CLI flags. Add explicit `WINDSURF_API_KEY` validation and a request
   spy proving missing-key failure precedes client/network setup.
5. Replace raw/progress/error fallback formatting with bounded protocol parsing,
   local candidate revalidation, reason-code projection, deterministic JSON
   output, and a closed local `FC_*` diagnostic map. Add malformed, oversized,
   absolute-path, child-stderr, transport-error, and sentinel-redaction
   fixtures.
6. Rewrite `skills/fast-context/SKILL.md`, its reference contract, README, and
   NOTICE so routing is local-first and CodeGraph-first, external use is
   visibly on-demand, and no registration/approval/whitelist is introduced.
7. Create the canonical provenance record and verifier. Derive the complete
   expected runtime-path universe from the package allowlist and require one
   classification/digest per path. Update package identity to
   `@pennixrv/fast-context-skill@0.1.0`, use an individual-file allowlist,
   remove the old credential helper/docs, and add exact tarball plus offline
   packed-install tests.
8. Add PR CI, annotated-tag validation, future GitHub Release, and manually
   dispatched provenance-aware npm publication workflows. Encode job-level
   least privilege (`contents: read` validation, `contents: write` only for
   Release, `id-token: write` only for npm publication). Publish only the
   exact verified tarball after an immediate cleanliness/digest recheck. Keep
   all workflow credentials external and do not dispatch them in this task.
9. Run `trellis-check` against the complete diff. Repeat the pressure tests,
   offline suite, package inspection, provenance verification, and
   `git diff --check`; update specs only for durable project-wide conventions.

## Validation Commands

- `node --test test/*.mjs`
- `node --check scripts/fast-context-search.mjs` and every changed module
- `node scripts/release/verify-provenance.mjs`
- `node test/package-content.mjs`
- `npm pack --dry-run --json`
- `node test/packed-install.mjs` using a temporary offline directory
- workflow static assertions with mocked Git/npm command runners
- `git diff --check` and `git status --short`

No command may read a real credential, call Windsurf, access a remote registry,
publish, tag, create a Release, or mutate homewsl/CodeGraph/context-mode/
global Codex configuration.

## Risky Files And Rollback Points

Highest-risk files are `scripts/lib/path-guard.mjs`, `executor.mjs`,
`directory-scorer.mjs`, `core.mjs`, and the CLI entry point. Keep the path
guard tests passing before credential removal, then keep credential/output
tests passing before package/workflow edits. If a later stage fails, stop at
the last passing local stage and do not expose an unverified tarball or invoke
any release action.

## Pre-Start Gate

Before `task.py start`, `prd.md`, `design.md`, and this file must be reviewed
top-to-bottom, the PRD convergence pass must have no product open questions,
and the `grill-me` capability gap must have an explicit user decision. The
latest planning summary, not the original request, is the required approval
boundary.
