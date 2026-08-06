# Release Gates

The release identity is an immutable annotated `v<major>.<minor>.<patch>` tag
for `@pennixrv/fast-context-skill`. A publisher must validate the peeled tag
target, the direct-child source/evidence history, fixed tag metadata, package
version, clean tree, source provenance, staged consumer manifest, exact package
contents, and one lifecycle-disabled tarball. The evidence commit changes only
`docs/releases/attestations/<tag>.json`. The tarball digest is rechecked
immediately before publication; any mutation or repack aborts.

The attestation records source manifest, public provenance, staged consumer
manifest, and tarball digests. Its canonical digest omits only the
canonical-digest field itself. The exact raw attestation digest is bound in the
annotated tag message, which avoids a self-referential commit or file hash.

Before source commit `C`, `release:prepare-artifact` writes exactly one
`docs/releases/artifacts/v<version>.tgz` from the staging builder. `C` includes
that tarball; preflight rebuilds the consumer tarball from `C` and rejects a
missing or digest-mismatched tracked artifact before creating evidence commit
`E`. This is the immutable workflow input downloaded by the CI publisher; a
runner rebuild is diagnostic only and never replaces it.

The evidence rebuilder archives only `package.json` and the explicit npm
`files` allowlist from `C`. It must never archive accumulated historical
release artifacts merely to recreate the consumer package, since that makes
release verification depend on unrelated repository growth.

Development and offline tests do not read real credentials or call Windsurf.
Publication runs only in GitHub Actions against the fixed tag. The publish job
receives a package-scoped `NPM_TOKEN` from the repository Actions secret,
verifies it with `npm whoami` without printing it, retains `id-token: write`,
and invokes `npm publish --provenance --access public`. The secret never enters
source, package contents, tag messages, Trellis artifacts, or logs. This keeps
token authentication separate from the GitHub-hosted provenance attestation
and avoids making npm website Trusted Publisher configuration an operator gate.
Publication still requires operator authorization, npm scope ownership, tag
protection, registry availability, and post-publish signature/attestation
verification. The workflow never creates a GitHub Release.

A successful `npm publish` is never retried because a short metadata poll still
returns 404. The publisher may wait for version metadata, then downloads the
exact versioned public tarball and compares its SHA-256 with the tag-bound
digest before verifying registry signatures and attestations.

Before creating the source commit `C`, verify that
`package.json.repository.url` identifies the canonical public GitHub
owner/repository, including the owner and repository casing. npm requires this
match for GitHub Trusted Publishing; case-insensitive GitHub redirects are not
a release gate. A mismatch rejects publication before tagging. Once an
annotated tag has bound the consumer manifest and tarball, do not change that
manifest, rebuild the tarball, or move the tag to repair the URL. Correct the
metadata in a later source release and create a new, independently attested
patch only after explicit release authorization.
