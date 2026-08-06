# Round 2: Provenance, Packaging, And Release Opposition Review

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Read `prd.md`, `design.md`, and the first-round package audit. Work only
through the Trellis channel and return one concise final response with exact
task-document or source citations. Do not run npm, Fast Context, tests, or a
network request; do not inspect credentials/environment variables or use
context-mode tools. Do not edit files, commit, tag, publish, or create a
GitHub Release.

Act as a hostile design reviewer. Identify up to three concrete gaps that
could make a provenance inventory unverifiable, let unexpected content into
the npm tarball, allow a non-annotated/mismatched/dirty revision through, or
allow publication after an unexpected registry/provenance failure. Address the
least-privilege requirement for a future GitHub Release separately from npm
publication. For every issue, state blocker status and the smallest exact
design correction or offline test. Reject any workaround that calls a real
registry or reads a credential in this task.

If no blocker remains in an area, say why the stated contract is sufficient.
Keep the answer under 900 words and do not quote credentials, registry bodies,
or remote content.
