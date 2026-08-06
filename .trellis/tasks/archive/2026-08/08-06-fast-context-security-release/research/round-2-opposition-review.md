# Round 2 Opposition Review

Two independent Trellis channel workers reviewed `design.md` against the PRD
and first-round audits. Both reviews were document-only and performed no npm,
CLI, network, credential, tag, release, publish, test, or file-edit action.

## Executor, Output, And Skill

- **Blocker:** a structured `rg` call still needs a finite guard-approved
  regular-file list, exact fixed argv (`--regexp`, `--`, no directory
  operand), absolute executable, explicit minimal environment, and a spawn-spy
  test for dash-prefixed queries/files, hostile inherited configuration, and
  denied/outside sentinels. This prevents option/config/traversal expansion
  before result revalidation.
- **Blocker:** bounded diagnostics must not become bounded raw leaks. Public
  errors are therefore a closed mapping from stable `FC_*` codes to local
  literals; caught messages, stacks, child stderr, transport status, parser
  excerpts, and protocol fields are never emitted. Sentinel fixtures cover
  stdout, stderr, public errors, and debug paths.
- **Blocker:** the CLI must publish a finite grammar with cardinality, value
  rules, unknown/retired-option behavior, and precedence. All parser failures
  happen before core import, key access, client creation, or request setup.

The review confirmed that local-first, CodeGraph-first, on-demand routing does
not need project approval, registration, a whitelist, MCP, or a hook.

## Provenance, Packaging, And Release

- **Blocker:** “missing provenance record” needs an authoritative universe.
  Derive sorted `expected_runtime_paths` from the exact tarball allowlist and
  require exactly one `vendored` or `fork_owned` classification plus digest for
  every path. Add fixtures for an unrecorded allowlisted module and duplicate
  or misclassified paths.
- **Blocker:** the artifact verified must be the artifact published. Build one
  tarball from the peeled tag with lifecycle scripts disabled, hash it, run all
  package/install checks against that path, recheck cleanliness and digest
  immediately before publication, and pass only that unchanged path to the
  publisher. Mutations and repacks must abort; test with an injected runner.
- **Blocker:** least privilege needs explicit job permissions. Validation gets
  `contents: read`; only the future GitHub Release job gets `contents: write`
  and no `id-token`; npm publication gets `contents: read` and
  `id-token: write` (or a narrow token) and no `contents: write`. Static tests
  reject omitted or broad permissions.

The existing peeled-tag, package-version, clean-tree, and non-404 lookup
failure gates were judged sufficient once these artifact and permission
contracts are made explicit. Remote tag protection remains an operational
release-time gate.
