# Technical Design

## Boundaries

The source repository remains the maintainer interface. Runtime files are
selected into a disposable staging directory by a release builder, which
generates a consumer-only `package.json` and invokes `npm pack --ignore-scripts`
there. The source manifest and its development scripts are never rewritten.

The Skill is prompt metadata plus source instructions; it does not implement a
new router or consumer-side approval system. Its contract tells the host when
to skip or invoke the CLI. The CLI remains the only component that enforces
project-root, credential and output limits.

## Routing Contract

The body and `agents/openai.yaml` description use the same ordered decision:

1. Local tools resolve known paths, literals, configuration, logs and current
   content.
2. CodeGraph resolves known symbols, callers/callees, structure and impact.
3. Fast Context is an external, on-demand candidate search only for genuinely
   vague business terminology, historical names or legacy behavior that the
   first two layers cannot locate.

The wording explicitly excludes natural-language-only triggers, automatic
parallel execution, mechanical fallback after one CodeGraph miss, and all
known/local/documentation/conversation cases. Results are candidates only;
same-root local reads verify them before any CodeGraph expansion. No result is
written to persistent indexes or Trellis state.

## Public Provenance Projection

Keep the complete maintainer provenance under `docs/security/`. Generate a
small `references/source-provenance.json` for the package containing only the
schema, package coordinate/version, source repository, upstream baseline,
runtime inventory and public digests/classifications. The projection is an
explicit allowlisted file and is checked for valid JSON, secret-like keys,
runtime state and absolute local paths. README links to this package-relative
projection.

## Staging Manifest And Allowlist

`build-package.mjs` owns one explicit runtime copy list. It copies the CLI,
reviewed libraries, Skill and metadata files, then writes a sorted/minimal
manifest containing runtime `bin`, dependencies, engines, license, repository,
version and `files`. It omits `scripts`, `devDependencies`, tests, release
tooling and Trellis/VCS state. The builder emits a manifest/file-list report,
packs from staging, and computes SHA-256 without changing tracked source files.

The packed-install test extracts the tarball into a clean temporary directory,
checks the README/provenance link and allowlist, and runs the CLI `--help` with
no network or credential environment.

## Release Evidence

Release helpers derive version, tag, attestation path and scoped tarball name
from the source manifest/tag rather than hard-coded `0.1.0` values. The
release sequence is:

1. Run all offline/security/package checks on a clean source tree.
2. Commit source as `C` and build the exact staging tarball/evidence inputs.
3. Create a direct-child evidence commit `E` changing only
   `docs/releases/attestations/v0.1.3.json`.
4. Create annotated immutable `v0.1.3` pointing at `E`; verify ancestry and all
   bound digests.
5. Publish the exact tag with the package-scoped GitHub Actions `NPM_TOKEN`
   secret and explicit npm provenance, refusing an existing registry version.
   The public GitHub-hosted runner provides the provenance identity. Do not
   create a GitHub Release.
6. Poll and inspect the exact registry tarball/version after publish.

If any credential, provenance, tag, clean-tree or registry gate fails, stop
without fallback publication or post-publish mutation.

### Publication Checkpoint: 0.1.3

`v0.1.1` is retained as immutable rejected evidence: npm accepted the scoped
token and created the GitHub Actions provenance statement, then rejected the
PUT with `E422` because its package metadata used
`pennixrv/fast-context-skill` while provenance identified
`PennixRv/fast-context-skill`. `v0.1.2` is also retained as immutable rejected
evidence: its source commit omitted the tracked tarball that the tag-bound
workflow intentionally requires. Neither tag or tarball is moved or repacked.
`0.1.3` keeps the corrected canonical GitHub URL and adds a release helper that
creates the tracked tarball before source commit `C`, so preflight can bind and
verify it before evidence commit `E`. Its rebuilder archives only the package
allowlist, so historical tracked tarballs cannot exhaust the source archive
buffer or influence the reconstructed consumer artifact.

The fixed-tag GitHub Actions job verifies a package-scoped repository
`NPM_TOKEN` without echoing it and publishes the attested tarball with explicit
`--provenance` from the public GitHub-hosted runner. Registry attestation
verification after publication is the final proof that provenance was
established. An auth, provenance, tag, clean-tree, or registry failure stops
the workflow without a second publish attempt, a tag move, or a repack.

## CI And Rollback

Pull requests run offline tests, syntax/type/build checks, package-content
inspection and dry-run packing. Tag-bound workflows repeat checks against the
checked-out immutable tag before publication. A failed preflight leaves the
source/tag untouched; an already-published exact version is never overwritten.
Only a new patch release can correct a publication error.
