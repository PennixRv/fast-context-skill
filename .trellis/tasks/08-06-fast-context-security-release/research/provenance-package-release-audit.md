# Provenance, Package, And Release Audit

Active task: `.trellis/tasks/08-06-fast-context-security-release`

## Confirmed Findings

### [Critical] The current NOTICE cannot prove vendored provenance

`NOTICE.md:3` names one upstream repository, tag, and commit but describes
only "vendored core files". It has no file inventory or byte digest. The
shipped source tree contains the CLI, five library modules, the credential
helper, and an upstream license through the broad `scripts/` packaging entry
in `package.json:10`. Repository history records source introduction at
`cd67378edaae6035dfdec89f12671eb75cf379dc` and later changes at
`6f9f98e5163c5a9dd1458eabba228ffe2e516c3f` and
`bc5dca654c6a99e260f20ad656780a75a244f3c1`.

The fork needs a machine-verifiable provenance record. Every shipped vendored
file must name its source repository, immutable commit, source path, upstream
SHA-256, shipped SHA-256, license/NOTICE relationship, and concise fork delta.
The verifier must hash exact checked-out bytes and reject unsafe, duplicate,
missing, stale, or mismatched records.

### [Major] The package allowlist is broad enough to ship unsafe material

`package.json:10` ships directory-wide `agents/`, `references/`, and
`scripts/`, plus `README.md`. That currently includes
`scripts/lib/extract-key.mjs:1`, key-oriented documentation at
`references/script-contract.md:42`, and persistence/printing guidance at
`README.md:127`. A future source map, generated file, or development helper
would also be included by the directory entries.

Use a narrow, individual file allowlist and assert the normalized package
pathname set from the real tarball. The package must contain only the runtime
CLI/modules, the packaged Skill/reference, licenses/notices, safe README, and
provenance record. It must reject test, Trellis, Codex, GitHub workflow, map,
generated, lock/development, and unapproved documentation paths.

### [Critical] The existing publishing workflow is not a release gate

`.github/workflows/npm-publish.yml:3` permits arbitrary manual dispatch,
weekly scheduling, and wildcard tags. It does not establish annotated tag,
exact version/tag identity, target revision, clean tree, provenance, tarball,
or install evidence. Its registry lookup permits publishing after lookup
failure at `:48`, and directly calls publication at `:59`.

The fork must replace this with PR validation plus tag-bound release and
explicit manual publish workflows. Publication remains coded for a later,
authorized release only; the workflow has no schedule, no branch-tip
publication path, and treats all unexpected registry lookup errors as failure.

## Required Offline Evidence

- Verify deterministic JSON provenance against the checked-out source and its
  local immutable upstream Git object without a network call.
- Assert exact `npm pack --dry-run --json` pathname output, then pack and
  install the artifact in an offline temporary profile with scripts/audit/fund
  disabled.
- Use disposable Git fixtures to reject lightweight, malformed, mismatched,
  and non-target tags; dirty or untracked trees; invalid provenance; package
  drift; and test failure. A valid annotated `v0.1.0` on the checked revision
  is the only passing fixture.
- Unit-test the workflow-owned release command runner so registry errors do
  not become a publish allowance and no test calls a registry or publish API.

## Rejected Alternatives

- Prose-only NOTICE, tag-only references, or Git blob IDs in place of
  SHA-256; omitting modified vendored files because their bytes changed.
- Directory allowlists, denylist-only package assertions, or syntax checks as
  a substitute for inspecting the actual tarball.
- Scheduled/ref-free release actions, wildcard tag matching as identity
  validation, registry reachability as a release decision, or a fallback
  unprovenanced publication.

## Audit Limits

This was a source and local Git metadata review only. No npm command, remote
request, credential/environment inspection, product edit, or publication was
performed.
