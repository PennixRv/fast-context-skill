# Round 1: Executor Boundary Pressure Test

Active task: `.trellis/tasks/08-06-fast-context-security-release`

Work only through the Trellis channel. Review the current source without
executing the Fast Context CLI, inspecting environment variables or credential
locations, opening a network connection, changing product code, package files,
tests, or task artifacts, or committing.

Return one concise channel response with source file and line citations. Do
not write a report file. Do not use context-mode tools.

Pressure-test this proposed contract:

1. `--project` is the only project-root flag and is required exactly once.
2. A shared canonical path guard controls `rg`, `readfile`, `tree`, `ls`, and
   `glob`; it rejects absolute paths, traversal in both slash styles, escaping
   symlinks, missing/broken paths, unexpected types, and hard-denied paths.
3. The hard deny baseline cannot be weakened and covers Trellis, Git, Codex,
   CodeGraph, credential-like names, logs, generated output, `.env*`, and
   project secret paths.
4. `WINDSURF_API_KEY` is the sole credential source; missing-key handling
   happens before network preparation; normal output is a bounded sanitized
   candidate summary with no raw remote/local content fallback.

Identify the three most serious bypasses or compatibility hazards the design
must explicitly address, the exact owning files, the minimum offline tests,
and rejected alternatives. Keep the answer under 900 words and avoid quoting
keys, repository maps, protocol payloads, or complete local file contents.
