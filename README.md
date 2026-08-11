# `@pennixrv/fast-context-skill`

An on-demand Agent Skill and local CLI that asks Windsurf Devstral for bounded
semantic code-search candidates. Local `rg` and CodeGraph remain the default
path; this helper is for genuinely unknown locations or vague legacy behavior.

## Use

Pass an existing project directory. An explicit key remains supported for the
current process:

```bash
WINDSURF_API_KEY='provided-out-of-band' \
  npx --yes @pennixrv/fast-context-skill \
  --project "/absolute/path/to/project" \
  --query "Where is the legacy import flow implemented?"
```

On Linux/WSL, when the current user has already completed Devin CLI login, the
same command may omit `WINDSURF_API_KEY`. The runtime then starts a bounded,
no-shell helper that reads only the fixed Devin CLI credentials file for that
user. It rejects symbolic links, oversized files, unknown fields and unsupported
formats, does not scan desktop state databases, and never exposes the token in
arguments, output, logs, or persistent state. Explicit `WINDSURF_API_KEY`
always has priority.

The accepted options are `--project`, `--query`, bounded `--max-results`,
repeatable relative `--deny`, standalone `--no-external`, and standalone
`--help`. `--no-external` exits with `FC_EXTERNAL_DISABLED` before inspecting
credentials, importing the remote core, or opening a network request. Missing
credentials produce `FC_KEY_MISSING`; `401/403`, timeout, transport or remote
capacity exhaustion, `5xx`, and malformed protocol responses use distinct fixed
`FC_*` diagnostics. The CLI never prints, stores, or logs credentials. It
rejects metadata, secrets, generated output, and paths outside the canonical
project root before any remote request.

Use the returned paths only as hints and verify them with local tools. A single
JSON result is emitted on stdout; fixed `FC_*` diagnostics are emitted on
stderr. No MCP server, registration, approval, whitelist, or global agent
configuration is required.

## Bounded coverage

Each invocation uses one monotonic deadline and one shared resource budget for
authentication, protocol requests, directory traversal, glob matching, `rg`
subprocesses, tool commands, and model rounds. Local enumeration limits visited
entries, directories, depth, files, matches, and output bytes. Child processes
run without a shell and are terminated and reaped when the caller cancels or
the deadline expires.

The live path performs one bounded `CheckUserMessageRateLimit` preflight after
JWT acquisition and before any repository map or answer/tool stream. It uses
the same remaining deadline and a fixed model identifier. A rejected preflight
stops before inspecting project files or opening the stream and remains a fixed
redacted `FC_*` failure.

When the stream reports a fixed transient capacity or availability rejection,
the client may retry that unchanged request at most twice within the same
deadline. This is not an additional model or tool round; malformed protocol,
authentication, timeout, output-limit, and server failures still stop safely.

For behavior queries, returned candidates prioritize locally read implementation
files; related tests are supplemental rather than a standalone substitute when
the implementation is available. The protocol permits one fixed tool-envelope
correction during local-tool work and one during the final answer-only request.
Neither correction accepts prose or relaxes local path/range checks.

For remote protocol grounding only, a successful guarded `readfile` result also
contains an internal `read_range` with the exact inclusive bounds of the
numbered rows it returned. The prompt requires a candidate range to copy those
bounds rather than estimate a line number, and candidate projection reopens the
file and validates the range again. `read_range` is not a public CLI JSON field;
it is absent for an empty read and never weakens PathGuard, output budgets, or
the final same-version range check.

Successful JSON uses `status: "complete"` or `status: "truncated"` and includes
local `coverage` counts, fixed reasons, and continuation information when
available. `complete` means the search exhausted the paths that PathGuard was
allowed to inspect within the named limits. It does not include denied paths
and does not prove semantic correctness or unrestricted whole-repository
coverage. `truncated` means the returned candidates may be incomplete; it is
never rendered as a conclusive `(no matches)` result.

The JSON `projection` object reports only fixed counts for candidates reported
by the remote answer: `remote_candidates`, `accepted_candidates`,
`rejected_candidates`, `unprocessed_candidates`, and fixed
`rejection_reasons`. `complete` with zero candidates is valid only for the
exact `<no_results/>` marker or the established empty `<ANSWER></ANSWER>`
form. If any remote candidate fails local path/range projection, the result is
`truncated` with `coverage.reasons` containing
`remote_candidate_projection_rejected`; no remote XML, prose, rejected path, or
rejected range is emitted. A bounded answer-only correction cannot convert a
previously reported candidate into a complete empty result. A result-limit
frontier is likewise `truncated` and uses `candidate_result_limit` plus
`unprocessed_candidates`.

Candidate projection has three distinct trust boundaries. PathGuard first
revalidates canonical containment, deny rules, and symlink escapes. It then
opens the approved file and accepts only a 1-based range of at most 200 lines
that exists in one unchanged file version; empty files, EOF overflow, oversized
ranges, and files changed during validation are dropped without clamping.
Finally, callers must still inspect the returned source and decide whether it
actually satisfies the requested behavior. The fixed
`reason: "local_range_validated"` describes local path/range validation only,
not semantic correctness.

## Development

All checks are offline and use temporary fixtures or injected request runners:

```bash
npm test
npm run verify:provenance
npm run pack:check
npm pack --dry-run --json --ignore-scripts
node scripts/release/build-package.mjs --output dist/package-check
```

These commands do not call Windsurf, npm publication, GitHub, or any real
credential source.

The `test`, `release`, `release:verify`, and packaging-check scripts belong to
the source repository's maintainer workflow. They are intentionally omitted
from the installed consumer manifest; installation exposes only the runtime
CLI and Skill assets.

## Attribution

The upstream MIT license is preserved at `scripts/lib/LICENSE.fast-context-mcp`.
See `NOTICE.md` and [`references/source-provenance.json`](references/source-provenance.json)
for the public shipped-file classification and digests. The projection is
included in the npm tarball; the full maintainer provenance remains source-only.
