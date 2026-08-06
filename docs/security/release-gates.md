# Release Gates

The release identity is the immutable annotated tag `v0.1.0` for
`@pennixrv/fast-context-skill`. A future publisher must validate the peeled tag
target, the direct-child source/evidence history, fixed tag metadata, package
version, clean tree, source provenance, exact package contents, and one
lifecycle-disabled tarball. The evidence commit changes only
`docs/releases/attestations/v0.1.0.json`. The tarball digest is rechecked
immediately before publication; any mutation or repack aborts.

The attestation records source and artifact digests. Its canonical digest omits
only the canonical-digest field itself. The exact raw attestation digest is
bound in the annotated tag message, which avoids a self-referential commit or
file hash.

This repository does not read real credentials, call Windsurf or npm, create
tags or Releases, or publish during development. Trusted publishing, npm scope
ownership, tag protection, and registry availability remain operator-time
gates.
