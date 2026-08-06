# Provenance, Package, And Release Audit Brief

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Inspect the current product source and Git metadata read-only. Do not run npm
commands, do not inspect environment variables or credentials, do not contact
any remote, and do not edit product code, package files, or tests.

Write only `research/provenance-package-release-audit.md`. Report concrete
file-and-line or Git-object evidence for:

1. Upstream and current-fork identity claims in package metadata and docs.
2. Vendored source files, license/NOTICE obligations, and a provenance-inventory
format with deterministic SHA-256 inputs.
3. Current npm allowlist risks and the required package-content assertion.
4. The exact missing CI and release workflow gates, including tag/version,
   clean-worktree, `npm pack --dry-run`, packed-install smoke, provenance, and
   fail-closed publication requirements.
5. A minimal offline validation plan and files likely to own it.

Keep the report as a concise security/release design input. Do not include
credentials, registry responses, or remote content.
