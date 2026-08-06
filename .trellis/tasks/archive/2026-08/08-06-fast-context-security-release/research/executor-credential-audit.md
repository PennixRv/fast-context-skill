# Executor And Credential Audit

Active task: `.trellis/tasks/08-06-fast-context-security-release`

## Confirmed Findings

### [Critical] Project selection is optional and ambiguous

`scripts/fast-context-search.mjs:68-103` defaults to the current directory,
accepts `-p` and `--project-path`, and overwrites repeated values. Its later
`path.resolve()` call at `:185` neither obtains a real path nor establishes
that the result is a directory. `scripts/lib/core.mjs:1474-1497` accepts an
independent arbitrary root.

The fork must accept exactly one required `--project` option, reject aliases
and duplicates, and canonicalize an existing directory once before it creates
a request client. No library entry may select a different root.

### [Critical] Filesystem confinement has more than one bypass path

`ToolExecutor._real()` in `scripts/lib/executor.mjs:43-64` passes unknown
paths through without canonical containment. Its `rg`, `readfile`, `tree`,
`ls`, and `glob` implementations at `:128-408` rely on that conversion.

The remote dispatcher is not the only reader. Core builds repository maps
through direct tree/list operations at `scripts/lib/core.mjs:1200-1294`.
`scripts/lib/directory-scorer.mjs:183-286` walks and reads directly, then
executes `rg` at `:391-430`. Existing exclusions in `core.mjs:89-116` and
`directory-scorer.mjs:34-39` are selection hints, not an access policy.

The design therefore needs one injected canonical `PathGuard` for executor,
map construction, scorer reads, walker recursion, and all filesystem-backed
subprocess arguments. It cannot rely on lexical prefixes, `lstat` alone,
per-command policy, or remote dispatcher coverage alone.

### [Critical] Credential discovery and raw-output egress remain active

`scripts/lib/core.mjs:27-29` imports credential discovery; `:643-667` falls
back to it, and `:1900-1905` exposes it again. CLI key controls and full-key
output remain in `scripts/fast-context-search.mjs:37-40`, `:163-174`, and
`:231-255`. The discovery module is `scripts/lib/extract-key.mjs`.

Raw remote material can escape through error/debug/result fallbacks at
`scripts/lib/core.mjs:1636-1683` and `:1859-1894`. The fork must remove the
credential module, all imports and flags, require only nonempty
`WINDSURF_API_KEY` after structural argument validation, and format one
bounded sanitized result instead of exposing protocol fallbacks.

## Required Offline Evidence

- For every primitive and internal map/scorer reader: absolute paths, slash
  and backslash traversal, escaping and broken symlinks, missing paths,
  unexpected types, each hard-deny category, and valid nested paths.
- A request spy proving missing-key failure happens before request setup.
- Sentinel-key tests proving stdout, stderr, debug paths, and thrown errors do
  not contain the fixture value.
- Malformed protocol and oversize-field fixtures proving no raw response,
  absolute path, file content, map, or unbounded diagnostic reaches output.

## Rejected Alternatives

- Defaulting to the current directory or retaining project-root aliases.
- Guarding only remote requested operations or each primitive independently.
- Prefix string checks, symlink checks without post-resolution containment, or
  a user-configurable way to remove the hard deny baseline.
- Masked discovery, key-print/export flags, post-log redaction, debug raw
  dumps, or full-path compatibility output.

## Audit Limits

This was a source-only, offline review. No Fast Context invocation, network
call, credential/environment inspection, test execution, or source edit was
performed.
