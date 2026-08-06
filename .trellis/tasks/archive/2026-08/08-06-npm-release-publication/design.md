# Release Design

## Boundaries

The release coordinator keeps source/evidence Git history, deterministic npm
construction, npm authentication, and optional GitHub Release creation as
separate boundaries. CI validation receives no npm token and performs no
Windsurf request. The final local publisher delegates credential handling to
the already authenticated npm client and records only sanitized status.

## C To E Provenance

`C` is the clean source commit used for all offline gates. After the exact
package has been built and checked, `E` is a direct child of `C` that changes
exactly `docs/releases/attestations/v0.1.0.json`. The annotated `v0.1.0` tag
points to `E` and records fixed-order metadata for both commits and all
artifact digests.

The verifier reads the candidate attestation with `git show`, rejects symlinks
and worktree drift, confirms the direct-child diff, and compares the rebuilt
package from `C` to the digest recorded by `E`. Canonical attestation hashing
omits its own digest field; raw hashing covers exact tracked bytes.

## Artifact Flow

```text
C -> offline checks -> one npm pack -> tarball SHA-256
  -> content-free attestation -> E -> annotated tag
  -> tag validation and package rebuild
  -> exact tarball transfer/recheck
  -> npm publish using current npm login
```

The npm package excludes Trellis state, tests, workflows, generated files,
credentials, and release attestation files. The attestation remains a Git
release record, not package payload.

## Authentication Modes

### Transitional Current Login

This release uses the current npm client login only if:

- `npm whoami` succeeds in the shared environment;
- the account is authorized to create/publish under `@pennixrv`;
- the target version lookup returns an explicit 404; and
- the exact tarball, tag, evidence, and cleanliness gates pass.

The implementation never reads token bytes. It does not inspect or reuse an
`oh-my-codex` token separately from the npm client's active identity.

### Preferred OIDC

After this release, configure npm Trusted Publisher for the exact GitHub
repository/workflow. The publish job then declares only `contents: read` and
`id-token: write`, uses `npm publish --provenance --ignore-scripts`, and has no
static token secret.

## Failure And Rollback

Published npm versions are immutable. A failed or incorrect release is handled
with `npm deprecate` and a new patch version, not overwrite or routine
unpublish. If authorization or workflow integrity is uncertain, stop before
publish and revoke the dedicated credential or disable the publisher path.

## Trade-offs

- Reusing the current authenticated npm client makes the first release
  possible without waiting for OIDC configuration, but depends on local
  operator state and is not the preferred repeatable path.
- OIDC removes long-lived secret handling and produces npm provenance, but
  requires one-time registry configuration and a GitHub workflow run.
- C/E evidence is more work than a plain tag, but removes provenance
  circularity and binds evidence to exact source and package bytes.
