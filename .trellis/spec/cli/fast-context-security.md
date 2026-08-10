# Fast Context Security Contract

## Scenario: External Semantic Search

### 1. Scope / Trigger

`scripts/fast-context-search.mjs` is a user-facing CLI that may send a bounded
query and guarded project context to an external service. Changes to its
arguments, environment use, filesystem primitives, result shape, package
contents, or release workflows require this contract and offline regression
tests.

### 2. Signatures

```text
fast-context-search --project <directory> --query <text>
  [--max-results <1..50>] [--deny <relative-glob> ...]

stdout: {
  status: "complete" | "truncated",
  search_terms: string[],
  candidates: [{
    path: string,
    start_line: integer,
    end_line: integer,
    reason: "local_range_validated"
  }],
  truncated: boolean,
  coverage: {
    visited: { entries, directories, files, matches, outputBytes },
    continuation: object | null,
    reasons: string[]
  }
}
stderr: FC_*: fixed local diagnostic

repository-map/tool result: {
  status: "complete" | "truncated" | "failure",
  output: string,
  visited: object,
  continuation: object | null,
  reason: string | null,
  code?: "FC_*"
}
```

`--help` is valid only by itself. `--project` and `--query` occur exactly once.
There are no aliases, key commands, cwd defaults, tuning flags, or positional
arguments.

### 3. Contracts

- Canonicalize the existing project root once in `PathGuard`.
- Pass every `rg`, read, listing, tree, glob, repository-map, and candidate
  path through the same guard before touching the filesystem.
- `WINDSURF_API_KEY` is the only credential source. Validate it after argv/root
  validation and before dynamic core import, context construction, DNS, socket,
  request body, or fetch setup.
- One `search()` creates one `ResourceBudget` from a monotonic deadline and the
  caller's optional `AbortSignal`. Authentication, every network round,
  repository mapping, directory/glob walking, every `rg` child, up to four
  commands per round, up to three rounds, and candidate validation consume the
  same remaining budget. A step never receives a fresh full timeout.
- Default local limits are 30,000 ms elapsed, 4,096 visited entries, 512 visited
  directories, depth 16, 2,048 files, 200 matches, 512 KiB local output, 100
  glob results, 300 tree entries, and 64 KiB per readable file. Units and
  scopes stay centralized in `path-guard.mjs`/`executor.mjs`.
- Enumerations and remote tool results use `complete`, `truncated`, and
  `failure` literally. A truncated no-match result says `(no matches in visited
  files|paths)` and carries visited/continuation data; it never claims complete
  `(no matches)`. Public JSON aligns `status` with the `truncated` boolean.
- `rg` uses an absolute fixed binary, no shell, fixed `--json` argv, explicit
  PathGuard-approved file operands in batches of at most 128, a minimal
  environment, shared cancellation, and a 512 KiB stdout ceiling. Abort/timeout
  sends termination, escalates after a short grace period, and resolves only
  after the child `close` event.
- Read HTTP bodies through `Response.body.getReader()` and cap actual compressed
  bytes at 512 KiB before final concatenation. `Content-Length` may reject early
  but cannot prove safety. Connect frames cap compressed payload at 256 KiB,
  decompressed payload at 512 KiB, and cumulative decompressed bytes at 1 MiB.
- Decode Connect input as exact `1 byte flags + 4 byte big-endian length +
  payload`. Reserved flags, length mismatch, residual bytes, gzip/encoding
  mismatch, invalid gzip, missing/duplicate/early/non-final EndStream, data
  after EndStream, and remote EndStream errors fail closed. Gzip never falls
  back to raw payload.
- Successful candidates use PathGuard-approved relative paths and the fixed
  `local_range_validated` reason. Candidate ranges are positive, ordered,
  1-based, span at most 200 lines, exist in a non-empty file, and are checked
  against one opened file version using descriptor/path stat before and after
  the bounded read. EOF overflow, oversized spans, and changed files are
  dropped without clamp. Remote prose/reasons are never returned; callers still
  perform final semantic validation.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| Missing/repeated project or query | Fixed `FC_PROJECT_*`, `FC_QUERY_REQUIRED`, or `FC_ARG_*` diagnostic |
| Absolute, traversal, missing, type-invalid, symlink-escaping path | `FC_PATH_INVALID`, `FC_PATH_UNAVAILABLE`, or `FC_PATH_DENIED` |
| Metadata, secret, log, generated, or additive-deny path | `FC_PATH_DENIED` |
| Blank explicit key | `FC_KEY_MISSING` before core import/fetch |
| Response/child/local output exceeds a byte ceiling | `FC_OUTPUT_LIMIT` without body, stderr, path, or exception text |
| Connect header, flags, length, compression, or EndStream is invalid | `FC_PROTOCOL_INVALID` without remote error text |
| Caller abort, shared deadline, or transport failure | `FC_REMOTE_UNAVAILABLE`; active streams/children are cancelled and awaited |
| Enumeration reaches entries/directories/depth/files/matches/glob/tree limit | Typed `truncated` with fixed local reason, visited counts, and continuation when available |
| Restricted local command fails without abort/deadline | Typed tool `failure` with a fixed `FC_*` code; final coverage remains incomplete |
| Candidate start/end exceeds EOF, file is empty, or span exceeds 200 | Drop candidate without clamp or remote prose |
| Candidate file version changes during validation | Drop candidate; public status is `truncated` with `candidate_changed` |

### 5. Good, Base, And Bad Cases

- Good: `--project /repo --query "legacy import"` with an explicit process key
  yields PathGuard/range-validated relative candidates and complete coverage.
- Base: A guarded repository contains no source files and enumeration completes;
  `rg` returns typed complete `(no matches)` without an unsafe subprocess call.
- Base: A wide repository reaches a fixed budget before a match; it returns
  typed truncated `(no matches in visited files)` with a bounded frontier.
- Bad: A model asks for `/codebase/.trellis/tasks`, `../secret`, an outside
  symlink, `secrets/config`, or a dash-prefixed `rg` option. The guard or fixed
  argv rejects it without showing a path, child stderr, or secret.
- Bad: A response declares a short `Content-Length` but streams more than 512
  KiB, or sends a valid message followed by malformed EndStream data. Actual
  bytes/state-machine checks reject it.
- Bad: A candidate claims line 50 in a 10-line file, spans 201 lines, or changes
  while being read. The candidate is omitted and never clamped.

### 6. Tests Required

- Parser tests prove rejected arguments do not read environment or import core.
- Guard tests cover absolute and slash/backslash traversal, symlinks, missing
  and type mismatch, hard/additive denies, valid nested paths, `**/` at zero and
  multiple directory levels, 100 glob results, the 513th file, wide/deep walks,
  and 2,500 empty directories with explicit truncation.
- Executor tests assert fixed `rg --json` argv, absolute binary, empty config
  path, approved batched files, typed failures, stdout limits, and that
  aborted/forced children have closed and no PID remains.
- Core tests inject synthetic protocol responses and assert key-before-fetch,
  streaming byte limits, missing/incorrect `Content-Length`, slow stream/caller
  cancellation, one decreasing deadline across `4 x 3` commands, typed tool
  result propagation, and local candidate projection.
- Protocol tests combine with core tests and cover normal identity/gzip,
  single/multiple frames, reserved flags, partial headers, short/long lengths,
  residual bytes, gzip bombs/failures, cumulative decompression, and every
  missing/duplicate/early/non-final/error EndStream boundary.
- Candidate tests assert start/end EOF overflow, zero/invalid order, empty file,
  spans over 200, trailing/no-trailing newline last lines, deny/root/symlink
  rejection, and deterministic file change during final version comparison.
- Package/release tests compare exact tarball contents, perform an offline
  lifecycle-disabled install, validate provenance, and assert workflow
  permissions and annotated-tag rules.

### 7. Wrong Vs Correct

Wrong:

```js
for (const command of commands) {
  await run(command, { timeout: 30_000 }); // resets the full timeout
}
const body = await response.arrayBuffer(); // buffers before checking length
```

Correct:

```js
const budget = new ResourceBudget({ timeoutMs: 30_000, signal: callerSignal });
const repoMap = await guard.buildRepoMap(budget);
await runBoundedProcess(rgBinary, fixedArgs, {
  signal: budget.signal,
  maxOutputBytes: remainingOutputBytes,
});
const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES, budget.signal);
```

Never add a per-step full timeout, synchronous/unbounded walk, raw gzip fallback,
range clamp, approval file, registration, whitelist, global configuration, or
credential-discovery fallback to make the external request easier to invoke.

## Scenario: Tag-Bound npm Publication

### 1. Scope / Trigger

Release validation is required for every published package version. The npm
artifact must be built from a clean source commit and remain bound to an
annotated tag through a direct-child evidence commit.

### 2. Signatures

```text
release:preflight
release:verify-evidence -- v<major>.<minor>.<patch>
release:publish -- --tag v<major>.<minor>.<patch> --tarball <exact-path>
build-package --output <directory>
```

### 3. Contracts

- `C` is the clean source commit; `E` is its direct child and changes only the
  content-free attestation JSON.
- Before committing `C`, `release:prepare-artifact` creates exactly one tracked
  `docs/releases/artifacts/v<version>.tgz`. Preflight rebuilds from `C` and
  rejects a missing or mismatched artifact before writing the evidence file.
- The rebuilder archives only `package.json` and the explicit runtime allowlist
  from `C`; historical release artifacts are not package source inputs.
- The annotated tag peels to `E` and binds `C`, `E`, package/version, source
  provenance, source package manifest, staged consumer manifest, canonical/raw
  attestation, and tarball SHA-256.
- `build-package` copies only the source `files` allowlist into a disposable
  staging directory and generates a minimal consumer `package.json`. The source
  manifest retains maintainer scripts; the staged manifest has no `scripts` or
  `devDependencies`.
- Every environment that rebuilds an attested tarball pins Node to `26.5.1` and
  the pack tool to `npm@12.0.1`; npm pack output is not assumed byte-identical
  across Node or npm versions.
- A manual publish workflow must pass its dispatch `inputs.tag` directly to
  tag/evidence verifiers. `GITHUB_REF_NAME` is not authoritative after a
  `workflow_dispatch` checkout of a different ref.
- Before creating source commit `C`, `package.json.repository.url` must
  identify the canonical public GitHub owner/repository, including casing.
  npm Trusted Publishing requires this match; an immutable tag cannot be
  repaired by rewriting package metadata or repacking its attested tarball.
- The publisher accepts one exact lifecycle-disabled tarball and rechecks its
  digest immediately before `npm publish`.
- npm pack can preserve identical tar bytes while emitting a different gzip
  deflate stream on another runner build, even when Node and npm versions are
  pinned. A fixed-tag workflow must therefore consume a public tarball input
  whose SHA-256 is already bound by the tag attestation; an independent
  cross-runner rebuild remains diagnostic evidence and cannot replace it.
- After publish, the local publisher and CI workflow poll the exact package
  version for a bounded interval. Metadata lag then falls through to a download
  of the exact versioned registry tarball, whose SHA-256 must equal the
  tag-bound digest before signature and attestation verification.
- npm publication uses GitHub Actions on the public repository. The publish
  job takes a package-scoped `NPM_TOKEN` only from a repository Actions secret,
  validates it with non-echoing `npm whoami`, retains `id-token: write`, and
  invokes `npm publish --provenance --access public`. No token bytes enter
  logs, source, package contents, tag messages, or Trellis artifacts.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Missing or lightweight tag | Reject before publish |
| Non-annotated, retargeted, dirty, or unrelated evidence commit | Reject before publish |
| Source commit lacks `docs/releases/artifacts/v<version>.tgz`, or its digest differs from the staged build | Reject before evidence commit and tag |
| Tarball filename or digest mismatch | Reject before publish |
| Staged manifest has scripts/dev dependencies or a file outside the allowlist | Reject package check |
| Manual publish verifier receives a branch/default ref instead of `inputs.tag` | Reject before publish |
| Manifest repository owner/repository differs from the canonical public GitHub identity | Reject before tagging; use a newly authorized patch after correcting metadata |
| Existing target version, auth failure, or non-404 registry response before publish | Reject before publish |
| Published version metadata temporarily returns 404 | Do not republish; confirm dist-tags, public tarball HTTP 200, and immutable-version conflict evidence |

### 5. Good, Base, And Bad Cases

- Good: `C -> E -> v0.1.1`, exact staged tarball digest, script-free consumer
  manifest, explicit pre-publish 404, and public tarball digest equal to the
  local artifact.
- Base: Registry metadata lags after a successful publish; `npm dist-tag ls`
  and the public tarball endpoint establish visibility without republishing.
- Bad: A second publish is attempted because a post-publish `npm view` call
  still reports a cached 404.

### 6. Tests Required

- Evidence tests assert direct-child ancestry, a dynamic attestation path, and
  an attestation-only diff.
- Release-helper tests prove a missing or digest-mismatched tracked artifact is
  rejected before evidence generation.
- Release-helper tests prove archive reconstruction rejects unsafe paths and
  excludes historical release artifacts from its source set.
- Release tests assert canonical/raw digest separation, staged-manifest digest,
  strict tag metadata, and explicit workflow tag forwarding.
- Offline tests assert the exact package allowlist, privacy-safe README
  provenance link, script-free staged manifest, and packed install with CLI
  `--help`.
- Operator verification records `npm dist-tag ls`, public tarball HTTP status,
  and downloaded tarball SHA-256 after publication.
- Workflow tests assert that a metadata timeout does not republish and that the
  public tarball SHA-256 is checked before registry attestation verification.

### 7. Wrong Vs Correct

Wrong:

```text
npm view package@version -> 404
npm publish package.tgz again
```

Correct:

```text
npm dist-tag ls package
curl package/-/package-version.tgz
compare downloaded SHA-256 with the attested artifact
```

Wrong:

```yaml
- run: node scripts/release/verify-tag.mjs
```

Correct:

```yaml
- run: node scripts/release/verify-tag.mjs "${{ inputs.tag }}"
```
