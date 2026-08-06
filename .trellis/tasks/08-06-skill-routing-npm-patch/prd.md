# Skill auto-routing and npm patch package

## Goal

Make the fork-owned Skill an independently installable, automatically routable
and security-bounded npm package. Preserve the current Windsurf/Devstral CLI
protocol and local filesystem boundary, while publishing a deterministic
consumer artifact as `@pennixrv/fast-context-skill@0.1.3` from an immutable tag.

## Confirmed Facts

- `0.1.0` is already published and must remain immutable.
- The source package manifest currently exposes maintainer test/release scripts
  when packed directly.
- `README.md` links to source-only `docs/security/source-provenance.json`.
- `SKILL.md` has a partial local-first routing rule, while
  `agents/openai.yaml` disables implicit invocation.
- Path confinement, explicit `WINDSURF_API_KEY` handling, bounded output and
  offline security tests already exist and must remain compatible.
- Trellis is initialized and this task runs in Codex inline mode. Any bounded
  delegation, if later needed, uses Trellis channel only.

## Requirements

### R1. Skill routing contract

- Set `agents/openai.yaml.allow_implicit_invocation` to `true` and remove any
  default prompt that asks users to type `$fast-context`.
- State the routing order in metadata and Skill body: local tools for known
  files/literals/configuration/logs/realtime content; CodeGraph for symbols,
  relationships, structure and impact; Fast Context only for genuinely vague
  business, historical or legacy semantics after both local and CodeGraph
  attempts cannot locate the answer.
- Explicitly skip Fast Context for known files, known symbols, literals,
  configuration/log searches, external documentation, ordinary conversation,
  and local-only impact analysis.
- Do not trigger on natural language alone, run CodeGraph and Fast Context in
  parallel, or treat one CodeGraph miss as an automatic external fallback.
- Treat every Fast Context result as an untrusted candidate. The caller must
  reread it under the same project root and use CodeGraph for further relation
  analysis. Never persist candidates into Trellis, OpenViking, CodeGraph or
  context-mode indexes.

### R2. CLI and security compatibility

- Keep the independent CLI, existing protocol and compact parseable output.
- Preserve one explicit canonical project root and shared real-path checks for
  all local primitives, including traversal, Windows separator and symlink
  escape rejection.
- Keep `exclude_paths` as a transfer-size optimization only, never a security
  boundary.
- Read only explicit `WINDSURF_API_KEY`; fail closed before network work when
  missing; never discover, print, cache, persist or echo credentials.
- Retain bounded result, read, turn and output limits and stable sanitized
  `FC_*` diagnostics. Malformed remote JSON must not be echoed.

### R3. Self-contained public documentation and provenance

- Add a minimal public provenance projection to the package allowlist.
- Update README links so every relative link resolves inside the final tarball.
- Validate the projection as JSON and reject tokens/keys, credentials, runtime
  state and local absolute paths.

### R4. Consumer package boundary

- Retain maintainer `npm test`, release verification, packaging checks and CI in
  the source repository.
- Build a deterministic staging directory with a generated minimal manifest;
  do not mutate the source `package.json` to hide scripts.
- The consumer manifest keeps runtime entry/bin/dependencies/version/license,
  repository and required metadata, but no test/release scripts or dev deps.
- Use an explicit npm files allowlist containing only runtime code, Skill,
  README, licenses/notices and public references. Exclude tests, release
  scripts, Trellis/runtime state, VCS data, logs, backups, temporary files and
  local configuration.
- Confirm the unpacked CLI `--help` works without test or release directories.

### R5. Tests and release

- Extend offline tests for routing metadata, all path escape cases, missing key,
  redaction, malformed JSON, output limits, README/provenance, staging manifest,
  allowlist and packed-install behavior.
- Run the existing offline suite, syntax/type/build checks and `npm pack
  --dry-run`; do not call Windsurf or use real credentials.
- Preserve the rejected immutable `v0.1.1` and `v0.1.2` evidence tags. Publish
  only the new patch `0.1.3` from a distinct annotated immutable `v0.1.3` tag.
  Refuse an existing registry version and never use `@latest` or a branch tip.
- Bind source commit, direct-child evidence commit, tag, staging manifest,
  provenance, tarball file list and SHA-256 in release evidence. Do not create a
  GitHub Release.
- After publication, verify the exact registry version and tarball contents;
  never repair an installed/published package manually.

## Out Of Scope

- Windsurf calls, real API keys, desktop/Devin credential stores or npm token
  inspection/output.
- MCP server/runtime registration, hooks, plugins or context-mode MCP changes.
- Homewsl, CodeGraph, OpenViking, context-mode or global Codex configuration.
- Project-level approval, registration or whitelist mechanisms.
- GitHub Releases, tag replacement, version overwrite or post-publish edits.
- Upstream synchronization or unrelated refactoring.

## Acceptance Criteria

- [ ] Routing metadata/body pass offline assertions for all positive and skip
      cases, including implicit invocation and candidate verification rules.
- [ ] Existing CLI security/protocol tests remain green, with new regression
      coverage for traversal, Windows separators, symlink escape, missing key,
      redaction, malformed JSON and output limits.
- [ ] Final tarball contains a resolvable README provenance link and a valid,
      privacy-safe projection; no disallowed source/development artifacts are
      present.
- [ ] Staging manifest is deterministic, minimal and script-free while source
      `package.json` retains maintainer scripts.
- [ ] Unpacked `@pennixrv/fast-context-skill@0.1.3` runs `--help` offline without
      test/release directories or external API access.
- [ ] Fixed-tag release checks bind `0.1.3`, tag/evidence ancestry, manifest,
      provenance and tarball SHA-256; registry verification confirms the exact
      published version and digest.

## Open Questions

None. The user has approved the routing behavior, staging boundary, public
provenance projection, patch version and release constraints, and explicitly
waived the separate grill-me interaction.
