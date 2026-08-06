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
Publication requires operator authorization, npm scope ownership, tag
protection, registry availability, and successful provenance creation. The
workflow never creates a GitHub Release.
