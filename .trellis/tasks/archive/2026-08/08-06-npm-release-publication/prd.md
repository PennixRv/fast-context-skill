# Publish Fast Context npm Package

## Goal

Publish the exact, verified `@pennixrv/fast-context-skill@0.1.0` package once,
without exposing a credential or publishing an unverified worktree. Reuse the
current npm login only after the npm client proves authentication and release
gates prove the intended scope/version is publishable.

## Confirmed Facts

- The package is scoped as `@pennixrv/fast-context-skill@0.1.0`.
- Offline tests, source provenance verification, exact package-content checks,
  and packed-install smoke tests passed for the current implementation.
- `npm whoami --registry=https://registry.npmjs.org` succeeds as `pennix` in the
  shared Codex execution environment; token bytes were not read or emitted.
- `npm view @pennixrv/fast-context-skill@0.1.0` returns explicit 404, so the
  target version is absent.
- The `pennixrv` npm organization now exists and `pennix` is its owner. The
  active granular token is unrevoked, has `bypass_2fa=true`, and has package
  and organization write permissions; token bytes were not read or emitted.

## Requirements

### R1: Credential Boundary

- Use only the active npm client login. Never print, persist, commit, upload,
  or include token material in task artifacts, tag messages, release notes,
  package contents, or logs.
- Never discover credentials from unrelated files, backups, shell history, or
  other projects.
- Stop if npm rejects owner/scope authorization. Do not try another token or
  alter package ownership automatically.

### R2: Immutable Source And Evidence

- Build from clean source commit `C` after all offline gates pass.
- Add only content-free release evidence in direct-child commit `E`; annotated
  `v0.1.0` points to `E`.
- Bind `C`, `E`, tag/version, source provenance, package manifest, tarball
  digest, canonical attestation digest, and raw tracked attestation digest.
- Reject unannotated, retargeted, dirty, mismatched, or unrelated-child tags.

### R3: Exact Artifact

- Generate one lifecycle-disabled tarball from verified source and record its
  SHA-256.
- Validate package allowlist, source provenance, offline packed install, and
  registry version status before publish.
- Never repack or modify the tarball before the final `npm publish` call.

### R4: Publication Policy

- The transitional release may use the verified current local npm login.
- The long-term default remains GitHub Actions OIDC Trusted Publishing with
  `id-token: write` isolated to its publish job.
- Explicit registry 404 is the only valid “not published” response. Existing
  versions, authorization failures, network failures, or registry errors stop
  publication.
- GitHub Release creation remains separate from npm publication and uses only
  a dedicated `contents: write` job when enabled later.

## Acceptance Criteria

- [x] The current npm login succeeds without exposing a token; publish
  authorization was confirmed by the final publisher.
- [x] The final PRD/design/implementation review has no unresolved product or
  release-risk decision.
- [x] `C -> E` direct-child release evidence is validated from Git objects.
- [x] The exact tarball digest is equal before and immediately before publish.
- [x] Tarball contents equal the individual-file allowlist and install offline
  with lifecycle scripts disabled.
- [x] The target version is an explicit registry 404 before publish.
- [x] npm publication succeeded without token disclosure and without creating a
  GitHub Release.

## Out Of Scope

- Scanning for credentials outside the active npm client boundary.
- Reusing an `oh-my-codex` token by name or copying its configuration.
- Calling Windsurf or using `WINDSURF_API_KEY` during release validation.
- Project-level approval, registration, or whitelist state.
- Publishing a version other than the verified package version.

## Publication Evidence

- Source commit `C`: `f72dadf21979d16c58ed1cb77dfaf9980027aae6`
- Evidence commit `E`: `9e2b9b0ab023277f014cfa10c8486bfbb1a54c69`
- Annotated tag: `v0.1.0`, pushed to `origin`
- Tarball SHA-256: `e092a16440adb4b4851e98b8961c1376305fbc3fc9f3c5c68aa09c40fbaa7371`
- npm dist-tag: `latest -> 0.1.0`
- Public tarball download SHA-256 equals the attested digest
- GitHub Release: not created
