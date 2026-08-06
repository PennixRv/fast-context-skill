# Executor And Credential Audit Brief

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Inspect the current product source read-only. Do not run the Fast Context CLI,
do not inspect environment variables or credential locations, do not open a
network connection, and do not edit product code, package files, or tests.

Write only `research/executor-credential-audit.md`. Report concrete
file-and-line evidence for:

1. CLI flags, defaults, and project-root selection.
2. Every remote-model-controlled local filesystem primitive and its current
   path-resolution behavior.
3. Traversal, symlink, missing-path, deny-policy, raw-response, progress, and
   output-boundary failures relevant to R1-R4 in `prd.md`.
4. Credential discovery, key selection, key printing, and network ordering.
5. Existing test coverage and a minimal offline test matrix.

For each finding, state the required hardening decision, likely owning file,
and any compatibility concern. Do not include credential values, raw repository
maps, raw remote protocol data, or local file contents in the report.
