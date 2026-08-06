# Release Gates

The release identity is the immutable annotated tag `v0.1.0` for
`@pennixrv/fast-context-skill`. A future publisher must validate the peeled tag
target, package version, clean tree, source provenance, exact package contents,
and one lifecycle-disabled tarball. The tarball digest is rechecked immediately
before publication; any mutation or repack aborts.

This repository does not read real credentials, call Windsurf or npm, create
tags or Releases, or publish during development. Trusted publishing, npm scope
ownership, tag protection, and registry availability remain operator-time
gates.
