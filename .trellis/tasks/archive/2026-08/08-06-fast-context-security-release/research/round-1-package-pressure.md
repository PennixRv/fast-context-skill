# Round 1: Package And Release Pressure Test

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Work only through the Trellis channel. Inspect source and Git metadata
read-only. Do not run Fast Context or npm, inspect environment variables or
credentials, contact a remote, change product code, package files, tests, or
task artifacts, or commit.

Return one concise channel response with source file, line, or Git-object
citations. Do not write a report file. Do not use context-mode tools.

Pressure-test this proposed contract:

1. `@pennixrv/fast-context-skill` begins an independent `0.1.0` release line.
2. A provenance record inventories every vendored file with source path,
   upstream repository/commit, deterministic SHA-256 digest, license/NOTICE
   relationship, and fork-change summary.
3. The npm `files` allowlist contains only runtime code, Skill/reference,
   licenses/notices, and required provenance material; tests, Trellis state,
   maps, generated output, and development material are excluded.
4. PR CI runs offline tests and package-content checks. Tag-bound release and
   manually dispatched publication both fail closed on annotation, exact
   version, clean tree, provenance, package, or test failures. Neither
   workflow publishes in this task.

Identify the three most serious provenance, package-content, or release-gate
gaps the plan must resolve, likely owner files, minimum offline validation,
and rejected alternatives. Keep the answer under 900 words and do not include
registry responses, credentials, or remote content.
