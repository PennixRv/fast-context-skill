# Implementation Plan

## Ordered Checklist

1. Start the Trellis task after reviewing this plan and load
   `trellis-before-dev` plus the CLI/package specs.
2. Inspect current routing, executor, path guard, credential and release tests;
   preserve existing contracts and identify hard-coded `0.1.0` assumptions.
3. Rewrite `SKILL.md` and `agents/openai.yaml` with the complete local-first,
   CodeGraph-second, Fast Context-last routing and skip/persistence rules.
4. Add the privacy-safe provenance projection, update README links and package
   allowlist, and add offline projection/link/leak tests.
5. Implement deterministic staging package generation in maintainer-side
   release tooling. Keep source `package.json` scripts intact; exclude tests,
   release scripts, Trellis state and local artifacts from the consumer package.
6. Make release helpers derive the current version, tag, attestation and tarball names
   dynamically, while retaining the direct-child `C -> E` evidence contract.
7. Extend tests for routing metadata, path/symlink/credential/protocol/output
   security, staging manifest, allowlist, README/provenance and packed-install
   `--help` behavior.
8. Run `npm test`, syntax/type/build checks available in the repository,
   `npm pack --dry-run`, staging/tarball verification and `git diff --check`.
9. Run `trellis-check`, resolve findings, update the relevant spec if a durable
   release/package convention was learned, and review the complete diff.
10. Commit source changes, build the evidence-only child commit, create the
    annotated `v0.1.2` tag, and run the tag-bound release verification.
11. Publish only the exact fixed tag through the existing npm workflow with
    provenance; never inspect or print token material and never create a
    GitHub Release.
12. Poll npm for exact `0.1.2`, download/verify the tarball SHA-256 and file
    contents, then archive the Trellis task and record the session journal.

## Files And Ownership

- Skill/routing: `SKILL.md`, `agents/openai.yaml`, README routing text.
- Runtime/security: `scripts/`, `scripts/lib/`, and focused `test/` fixtures.
- Packaging/provenance: `package.json` allowlist, `scripts/release/build-package.mjs`,
  `references/source-provenance.json`, `docs/security/source-provenance.json`.
- Release/CI: `scripts/release/*.mjs`, `.github/workflows/ci.yml`,
  `.github/workflows/publish-npm.yml`, release tests and evidence.
- Trellis artifacts: this task directory only; do not modify unrelated Trellis
  runtime or global configuration.

## Validation And Stop Points

- Stop before network if any offline test, manifest, provenance or tag check
  fails.
- Stop before publish if npm reports the exact version already exists, the tag
  is not annotated/fixed, provenance cannot be generated, or the worktree has
  generated drift.
- Stop after publish if registry content or digest differs; do not repair the
  installed package manually. Record the discrepancy and use a new patch.

## Expected Evidence

Record final source/evidence commit IDs, tag target, package name/version,
staging manifest digest, sorted tarball file list, tarball SHA-256, registry
version verification and any commands not run with reasons. No real API key or
raw credential may appear in artifacts, logs or the final report.
