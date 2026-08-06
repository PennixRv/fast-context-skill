# Implementation Plan

## Ordered Checklist

1. Add the content-free attestation schema, canonical/raw digest helpers,
   direct-child evidence validator, and annotated tag metadata parser.
2. Update release validation to build from `C`, verify `E`, and compare exact
   package allowlist, provenance, manifest, and tarball digests.
3. Update the publisher to transfer one immutable tarball, recheck cleanliness
   and SHA-256, run offline install, recheck the explicit registry 404, and
   publish through the current verified npm login only in the final step.
4. Add focused tests for C/E ancestry, attestation privacy/digest separation,
   tag metadata, package immutability, workflow ordering, auth-before-publish,
   and 404-only registry behavior.
5. Run the complete offline suite and release preflight. Stop on any scope,
   authentication, digest, tag, or registry error.
6. Configure or verify npm Trusted Publisher for the future default workflow;
   never store the current login token in the repository.
7. Create the annotated tag and publish only after the final user-visible gate
   is green. Do not create a GitHub Release unless npm publish succeeds.

## Validation Commands

- `npm whoami --registry=https://registry.npmjs.org`
- `npm view @pennixrv/fast-context-skill@0.1.0 version --json`
- `npm test`
- `npm run verify:provenance`
- `npm run pack:check`
- `npm pack --ignore-scripts --json`
- exact tarball SHA-256 comparison before and after transfer
- `git diff --check` and `git status --porcelain`

## Risky Files And Rollback Points

- Highest risk: release workflow, tag verifier, provenance verifier, and
  attestation schema.
- Stop before tag creation if any digest, ancestry, owner, or 404 gate fails.
- Stop before publish if the exact tarball changes, the worktree is dirty, or
  npm auth is unavailable.
- No destructive npm unpublish or credential discovery is permitted.
