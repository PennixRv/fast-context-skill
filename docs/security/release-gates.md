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

Development and offline tests do not read real credentials or call Windsurf.
Publication uses npm Trusted Publishing from the public GitHub repository
`PennixRv/fast-context-skill`: the publish job has `id-token: write`, does not
accept a static `NODE_AUTH_TOKEN`, and invokes `npm publish --access public`.
npm generates the registry provenance attestation automatically for this public
repository. Publication still requires operator authorization, an exact npm
Trusted Publisher configuration for `publish-npm.yml`, npm scope ownership, tag
protection, registry availability, and post-publish signature/attestation
verification. The workflow never creates a GitHub Release.

Before creating the source commit `C`, verify that
`package.json.repository.url` identifies the canonical public GitHub
owner/repository, including the owner and repository casing. npm requires this
match for GitHub Trusted Publishing; case-insensitive GitHub redirects are not
a release gate. A mismatch rejects publication before tagging. Once an
annotated tag has bound the consumer manifest and tarball, do not change that
manifest, rebuild the tarball, or move the tag to repair the URL. Correct the
metadata in a later source release and create a new, independently attested
patch only after explicit release authorization.
