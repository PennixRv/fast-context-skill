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
  [--max-results <1..50>] [--deny <relative-glob> ...] [--no-external]

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
  projection: {
    remote_candidates: integer,
    accepted_candidates: integer,
    recovered_candidates: integer,
    rejected_candidates: integer,
    unprocessed_candidates: integer,
    rejection_reasons: string[]
  },
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
There are no aliases, key commands, cwd defaults, tuning flags other than the
explicit opt-out `--no-external`, or positional arguments.

### 3. Contracts

- Canonicalize the existing project root once in `PathGuard`.
- Pass every `rg`, read, listing, tree, glob, repository-map, and candidate
  path through the same guard before touching the filesystem.
- After argv/root validation and before dynamic core import, context
  construction, DNS, socket, request body, or fetch setup, credentials are
  resolved in this exact order: non-empty explicit `WINDSURF_API_KEY`; then,
  only on Linux/WSL, the current user's fixed
  `~/.local/share/devin/credentials.toml`; otherwise `FC_KEY_MISSING`.
  `--no-external` occurs before all credential access and instead returns
  `FC_EXTERNAL_DISABLED`.
- Devin discovery runs only in a package-owned Node child with no shell, a
  minimal environment, a 1,000 ms deadline, a 16 KiB stdout/file ceiling, one
  fixed path, ordinary-file/non-symlink checks, exact allowed TOML fields, and
  supported `devin-session-token$`, `devin-`, or `sk-` forms. The private pipe
  carries at most one accepted value into current-process memory. No path,
  value, child stderr, field name, or discovery failure becomes public output.
  Never scan desktop `state.vscdb`, enumerate alternate credentials paths,
  accept caller-provided credential files, or write shell configuration.
- The direct one-shot CLI entry must await `runCli()` through credential
  discovery and bounded `search()`. Because Node may unref a pending fetch
  socket, the entry owns a local keepalive only until that promise settles and
  clears it in `finally`. An exit code of zero with empty stdout is never a
  successful search result. The same lifecycle assertion applies to the
  release-only controlled probe, but never changes runtime search budgets.
- One `search()` creates one `ResourceBudget` from a monotonic deadline and the
  caller's optional `AbortSignal`. Authentication, every network round,
  repository mapping, directory/glob walking, every `rg` child, up to four
  commands per round, up to three rounds, and candidate validation consume the
  same remaining budget. A step never receives a fresh full timeout.
- After a JWT is acquired and before repository mapping or any stream request,
  perform the bounded `CheckUserMessageRateLimit` unary preflight for the fixed
  `MODEL_SWE_1_6_FAST` model. Its protobuf body is gzip-compressed, uses the
  same safe metadata and Connect headers as the live route, and consumes the
  same remaining budget. A rejected, timed-out, unavailable, or server-error
  preflight fails closed with the existing fixed category; it never continues
  to map files or open a stream, and its response body is discarded.
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
  mismatch, invalid gzip, missing/duplicate/early/non-final EndStream, and
  data after EndStream fail closed as `FC_PROTOCOL_INVALID`. A structurally
  valid EndStream `error` is a remote service result, not malformed framing:
  auth codes map to `FC_AUTH_REJECTED`, deadline to `FC_REMOTE_TIMEOUT`,
  unavailable/resource-exhausted/canceled/aborted to `FC_REMOTE_UNAVAILABLE`,
  and unknown/internal/data-loss to `FC_REMOTE_SERVER_ERROR`. Its text and
  metadata are never exposed. Gzip never falls back to raw payload.
- After a valid Connect payload, tool tags may contain only formatting
  whitespace between `[TOOL_CALLS]`, the fixed word-form tool name, `[ARGS]`,
  and the JSON object. Strict JSON is preferred; only the named bounded repairs
  below may recover a call. Never infer a tool name or treat remote prose as a
  local command/result.
- A valid Connect response whose tool tag/JSON is locally invalid receives one
  fixed corrective user message and may make one replacement request using the
  same `ResourceBudget` remaining time. Each logical remote request owns one
  replacement; separate executable, terminal-answer, and bounded
  answer-content-correction requests do not consume each other's allowance. Connect
  framing/compression/EndStream failures, remote EndStream errors, output
  ceilings, transport failures, and a second invalid tool tag for that request
  fail immediately with their existing fixed code. The correction never
  forwards or records remote prose and cannot add a tool turn or command.
- A stream rejected with fixed transient capacity/availability evidence
  (`connect_end_stream_resource_exhausted`, `connect_end_stream_unavailable`,
  or HTTP `429`) may reissue the identical request at most twice after fixed
  short backoff. Every retry recalculates the shared remaining deadline; it
  cannot add a local-tool turn, command, format correction, candidate source,
  request identifier, or remote text. All other remote, framing, auth, timeout,
  server, output, and parser failures remain terminal.
- Successful candidates use PathGuard-approved relative paths and the fixed
  `local_range_validated` reason. Candidate ranges are positive, ordered,
  1-based, span at most 200 lines, exist in a non-empty file, and are checked
  against one opened file version using descriptor/path stat before and after
  the bounded read. EOF overflow, oversized spans, and changed files are
  dropped without clamp. Remote prose/reasons are never returned; callers still
  perform final semantic validation.
- A successful guarded `readfile` tool result may include the internal
  `read_range` bounds of the exact numbered rows returned to the remote model.
  Terminal-answer prompts require a positive candidate range copied from those
  bounds, but `read_range` is not public CLI JSON, is absent for an empty read,
  and does not replace PathGuard or the final same-version range recheck. The
  line splitter must remove the single empty segment produced by a trailing
  newline before calculating `read_range`; for `one\ntwo\n`, the exact range is
  `1-2`, never `1-3`. A file without a trailing newline uses the same real EOF.
- System instructions treat a locally read implementation as the primary
  behavior candidate. A directly related test is supplemental: when a verified
  implementation is available, a final answer must not return the test alone.
  This ranking instruction never bypasses PathGuard or range validation.
- Strict tool-envelope JSON is preferred. Before consuming a request's one format
  correction, the parser may repair only known unquoted-key/trailing-comma
  defects inside the bounded `[TOOL_CALLS]...[ARGS]` envelope. A truncated
  `restricted_exec` may salvage only complete top-level `command1` through
  `command4` objects whose `type` is one of the five local commands. A truncated
  `answer` may salvage only its complete first top-level JSON string field; its
  content still passes the strict answer parser and local candidate projection.
  Never scan prefix/suffix prose for loose paths, fields, commands, candidates,
  or ranges.
- A final answer that omits the first non-test implementation successfully read
  by this invocation may recover only that one path through a fresh bounded
  PathGuard read and normal final range validation. Only when no implementation
  was read or accepted may the client inspect at most four accepted test files
  and twelve relative `./`/`../` imports to resolve one guarded implementation;
  standard JavaScript specifiers may map to TypeScript source extensions.
  Package imports, absolute/root-escaping paths, missing files, and prose are
  ignored. Only then may one `rg` path be considered, ranked by bounded match
  count. Never expose every exploratory match.
  Increment `recovered_candidates`, set `truncated`, and add
  `implementation_candidate_recovered`. Do not count the recovered range in
  `remote_candidates` or claim that local path/range validation proves semantic
  correctness.
- A complete empty result is valid only when the remote `answer` value is exact
  `<no_results/>` or the established empty `<ANSWER></ANSWER>` form. Each remote
  `<file>` marker contributes only a fixed count to `projection`; accepted
  paths/ranges must pass local validation.
  A missing range, malformed file element, denied/unavailable/duplicate path,
  invalid range, or changed candidate increments `rejected_candidates`, sets
  `truncated: true`, and adds `remote_candidate_projection_rejected`. Candidates
  left after `maxResults` increment `unprocessed_candidates` and add
  `candidate_result_limit`; they are not treated as verified or rejected.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| Missing/repeated project or query | Fixed `FC_PROJECT_*`, `FC_QUERY_REQUIRED`, or `FC_ARG_*` diagnostic |
| Absolute, traversal, missing, type-invalid, symlink-escaping path | `FC_PATH_INVALID`, `FC_PATH_UNAVAILABLE`, or `FC_PATH_DENIED` |
| Metadata, secret, log, generated, or additive-deny path | `FC_PATH_DENIED` |
| Blank explicit key and no accepted Linux/WSL Devin credential | `FC_KEY_MISSING` before core import/fetch |
| `--no-external` | `FC_EXTERNAL_DISABLED` without environment read, helper, core import, or network request |
| Rate-limit preflight `429` or Connect unavailable result | `FC_REMOTE_UNAVAILABLE` before repository mapping or stream request |
| HTTP `401` or `403` | `FC_AUTH_REJECTED` without response body, headers, request ID, or credential detail |
| HTTP `5xx` | `FC_REMOTE_SERVER_ERROR` without response body, headers, request ID, or credential detail |
| Response/child/local output exceeds a byte ceiling | `FC_OUTPUT_LIMIT` without body, stderr, path, or exception text |
| Connect header, flags, length, compression, or EndStream structure is invalid | `FC_PROTOCOL_INVALID` without remote error text |
| Valid Connect EndStream remote error | Fixed auth/timeout/unavailable/server category by Connect code, without remote error text |
| Transient stream capacity/unavailable error or HTTP `429` | At most two identical stream retries under the same remaining deadline; then its fixed category |
| Three stream attempts end in Connect `resource_exhausted` | At most two fresh-JWT session refreshes, each with preflight and the unchanged current request under the original deadline; then `FC_REMOTE_UNAVAILABLE` |
| First malformed tool-tag JSON for a logical remote request | Add that request's one fixed correction message and replace it once under the same remaining deadline |
| Known unquoted-key/trailing-comma defect or complete commands in a truncated restricted envelope | Recover only inside the bounded envelope, apply normal command/schema/PathGuard/budget validation, and emit fixed internal recovery metadata |
| Complete first `answer` string in an otherwise truncated answer envelope | Recover only that JSON string, then apply strict answer syntax and local projection; emit fixed internal recovery metadata |
| Second malformed tool-tag JSON for the same request | `FC_PROTOCOL_INVALID` without response text |
| Shared deadline or timeout signal | `FC_REMOTE_TIMEOUT`; active streams/children are cancelled and awaited |
| Caller abort or transport failure | `FC_REMOTE_UNAVAILABLE`; active streams/children are cancelled and awaited |
| Enumeration reaches entries/directories/depth/files/matches/glob/tree limit | Typed `truncated` with fixed local reason, visited counts, and continuation when available |
| Restricted local command fails without abort/deadline | Typed tool `failure` with a fixed `FC_*` code; final coverage remains incomplete |
| Candidate start/end exceeds EOF, file is empty, or span exceeds 200 | Drop candidate without clamp or remote prose |
| Candidate file version changes during validation | Drop candidate; public status is `truncated` with `candidate_changed` |
| Remote answer is exact `<no_results/>` or empty `<ANSWER></ANSWER>` | `complete`/zero candidates and all projection counts zero |
| Remote answer has a `<file>` marker but all entries fail local projection | `truncated`/zero candidates with `remote_candidate_projection_rejected` and a nonzero rejection count |
| Final answer omits a locally executed non-test implementation evidence path | Reopen and range-validate it; if valid, return it as `truncated`, increment `recovered_candidates`, and add `implementation_candidate_recovered` |
| Remote answer has no candidate marker and is not an exact explicit no-result form | Send one fixed answer-only shape correction under the same deadline; accept only a correction with a locally projected candidate, while a second invalid or empty shape is `FC_PROTOCOL_INVALID` without answer text |

### 5. Good, Base, And Bad Cases

- Good: `--project /repo --query "legacy import"` with an explicit process key
  or a current Linux/WSL Devin CLI login yields PathGuard/range-validated
  relative candidates and complete coverage.
- Base: `--no-external` returns only `FC_EXTERNAL_DISABLED` and never inspects
  a process key, starts a credential helper, imports the core, or opens a socket.
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
- Bad: A `401`, `403`, `5xx`, credential helper failure, or malformed JWT leaks
  a response body, a credential field/path, child stderr, request ID, or raw
  exception. Map it to the fixed public code instead.
- Bad: A candidate claims line 50 in a 10-line file, spans 201 lines, or changes
  while being read. The candidate is omitted and never clamped.

### 6. Tests Required

- Parser/credential tests prove rejected arguments do not read environment or
  import core; explicit keys win; Linux fixtures accept only the fixed Devin
  file and supported values; unknown fields, invalid values, symlinks, child
  failures, and non-Linux discovery fail closed; `--no-external` starts neither
  resolver nor core.
- Guard tests cover absolute and slash/backslash traversal, symlinks, missing
  and type mismatch, hard/additive denies, valid nested paths, `**/` at zero and
  multiple directory levels, 100 glob results, the 513th file, wide/deep walks,
  and 2,500 empty directories with explicit truncation.
- Executor tests assert fixed `rg --json` argv, absolute binary, empty config
  path, approved batched files, typed failures, stdout limits, and that
  aborted/forced children have closed and no PID remains.
- Core tests inject synthetic protocol responses and assert key-before-fetch,
  gzip rate-limit preflight order/model/body and its failure before mapping,
  `401/403` authentication, transport, deadline timeout, `5xx`, malformed JWT
  and Connect categories, streaming byte limits, missing/incorrect
  `Content-Length`, slow stream/caller cancellation, one decreasing deadline
  across `4 x 3` commands, typed tool result propagation, and local candidate
  projection.
- Core tests prove one valid-envelope malformed tool payload gets exactly one
  same-budget replacement per logical request, including separate corrections
  in two executable requests, a final answer-only request, and the bounded
  answer-content correction request; malformed Connect envelopes and
  remote EndStream errors remain terminal failures.
- Core tests prove a first `resource_exhausted` stream response retries the
  same request without a new tool turn and can succeed; retryable stream
  failures remain capped and do not expose `X-Request-Id` or remote text.
- Protocol tests combine with core tests and cover normal identity/gzip,
  single/multiple frames, reserved flags, partial headers, short/long lengths,
  residual bytes, gzip bombs/failures, cumulative decompression, every
  missing/duplicate/early/non-final EndStream boundary, and fixed safe mapping
  of valid remote EndStream errors.
- Candidate tests assert start/end EOF overflow, zero/invalid order, empty file,
  spans over 200, trailing/no-trailing newline last lines, deny/root/symlink
  rejection, deterministic file change during final version comparison, all
  projection-rejected answers, partial valid answers, explicit no-result, and
  the result-limit unprocessed count.
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
range clamp, approval file, registration, whitelist, global configuration,
desktop-state credential scan, alternate credential path, or caller-provided
credential file to make the external request easier to invoke.

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

## Scenario: Bounded Remote Completion And Candidate Projection

### 1. Scope / Trigger

Use this contract whenever changing the remote conversation loop, prompt/tool
definitions, answer parser, CLI JSON result shape, or tests for candidate
recall. It prevents a final answer-only request from becoming another local-tool
round and prevents rejected remote candidates from looking like a semantic
no-result.

### 2. Signatures

```text
search({ query, guard, apiKey, maxResults, timeoutMs, fetchImpl, signal, waitImpl? })
  -> { status, candidates, truncated, projection, coverage }

projection = {
  remote_candidates: integer,
  accepted_candidates: integer,
  recovered_candidates: integer,
  rejected_candidates: integer,
  unprocessed_candidates: integer,
  rejection_reasons: string[] // fixed local categories only
}
```

The internal `FastContextError.protocolReason` may contain only a fixed local
identifier such as `answer_only_restricted_exec`; it is not a CLI or JSON field.

### 3. Contracts

- The protocol permits at most three `restricted_exec` turns and one final
  answer-only request under one `ResourceBudget` deadline. A locally evidenced
  `answer` may end the exchange before that maximum; do not consume a remaining
  tool turn merely because it is available.
- Before constructing the repository map or protocol messages, the live client
  must complete the fixed gzip `CheckUserMessageRateLimit` preflight after JWT
  acquisition. It uses the same remaining deadline; a failure stops before any
  filesystem map or answer/tool stream is requested.
- A remote capacity/unavailability response may retry the unchanged stream
  request at most twice with fixed short backoff and recalculated remaining
  deadline. This is a transport retry, not another protocol turn: it cannot
  execute a command, repeat a format correction, or reveal a remote response.
- Persistent Connect `resource_exhausted` after those retries may refresh the
  JWT session at most twice. Each refresh repeats the fixed preflight and same
  current request under the original budget. `waitImpl` exists only for
  deterministic injected tests; production uses the abort-aware bounded wait.
- After the third effective local execution result, append one fixed user
  force-answer message before building the final request. It requires `answer`,
  prohibits `restricted_exec`, specifies `<file path="/codebase/relative"><range>start-end</range></file>`, permits only exact `<no_results/>` or empty `<ANSWER></ANSWER>` for no result,
  permits multiple exact ranges in one file, carries the result bound, and
  prohibits guessed paths/ranges.
- The final tool definition contains only `answer`. A decoded final
  `restricted_exec` or other tool is `FC_PROTOCOL_INVALID`; do not retry it,
  execute it, expose its argument, or add a further round.
- A valid answer either has an exact explicit no-result form or one or more `<file>`
  markers. Every syntactically exact positive `<range>` is a candidate input;
  a file may have multiple ranges and PathGuard/range validation remains the
  authority for exposed paths and ranges.
- A tool response may contain a bounded prefix before its one `[TOOL_CALLS]`
  envelope. The parser discards that prefix and never includes it in a later
  request, log, candidate, or public result. After the parsed JSON object only
  whitespace or the `</s>` protocol terminator is valid; other suffix text uses
  the request's single format correction and then fails closed.
- Inside that envelope, strict JSON is followed by one deterministic repair for
  known unquoted-key/trailing-comma defects. If a `restricted_exec` object is
  truncated, only balanced complete `command1` through `command4` objects with
  recognized local command types may be recovered. Loose prose/path/range
  extraction remains forbidden, and recovered commands pass the unchanged
  executor schema, PathGuard, and shared budget.
- Instructions rank a locally read implementation ahead of a related test for
  behavior queries. This is a model-facing recall rule only; final candidates
  still require the same local path and range validation.
- The final projection may add bounded non-test implementation evidence from
  this search's successful local commands when the answer omits it. The path is
  reopened through PathGuard, its range is locally generated and validated,
  `recovered_candidates` increments, and coverage becomes `truncated` with a
  fixed recovery reason. Never infer a path from prose or trust a model range.
- Projection counts and `coverage.reasons` use fixed client values only. They
  must never contain remote XML/prose, rejected paths, ranges, response bytes,
  JWTs, keys, request identifiers, or absolute project paths.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| First malformed tool-tag JSON for a logical remote request | Add that request's one fixed correction message and replace it once under the same remaining deadline |
| Second malformed tool-tag JSON for the same request | `FC_PROTOCOL_INVALID` without response text |
| Rate-limit preflight is rejected | `FC_REMOTE_UNAVAILABLE`; zero map and stream requests follow |
| Direct CLI has no credential | Wait for bounded discovery, then exit 1 with only `FC_KEY_MISSING`; never exit 0 with empty stdout |
| Valid Connect EndStream `resource_exhausted` | `FC_REMOTE_UNAVAILABLE`, internal fixed `connect_end_stream_resource_exhausted`, and no remote error text |
| First retryable stream capacity result, then valid `answer` | Return the locally validated answer; observer has one fixed retry event and no additional tool turn |
| Persistent `resource_exhausted` across all stream retries | Refresh JWT/preflight at most twice under the same deadline; the third exhausted session is `FC_REMOTE_UNAVAILABLE` |
| Final request returns `restricted_exec` | `FC_PROTOCOL_INVALID`, internal `answer_only_restricted_exec` only |
| Exact `<no_results/>` or empty `<ANSWER></ANSWER>` | Complete zero-candidate result with zero projection counts |
| `<file>` candidate lacks range or fails PathGuard/range validation | Omit it, increment `rejected_candidates`, and return `truncated` with fixed projection reason |
| One `<file>` has two exact, locally valid ranges | Return two locally validated candidate entries and count both ranges |
| Some candidates validate and some reject | Return only validated candidates and counts; remain `truncated` |
| Answer omits an implementation present in successful local evidence | Reopen and validate it, count it under `recovered_candidates`, and remain `truncated` |
| Candidate lies after `maxResults` accepted results | Do not validate it; increment `unprocessed_candidates`, add `candidate_result_limit`, and remain `truncated` |
| Nonempty answer has no `<file>` marker and is not exact no-result | One answer-only shape correction may return locally projected candidates; an invalid or empty correction remains `FC_PROTOCOL_INVALID` without answer prose |

### 5. Good, Base, And Bad Cases

- Good: Three guarded tool rounds are followed by a force-answer message and an
  `answer` response containing a locally valid `/codebase/src/a.ts:1-8` range.
- Base: An exact explicit no-result form has complete coverage and projection counts
  all zero; it is the only complete empty result.
- Base: One valid and one denied candidate produce one relative validated path,
  one rejection count, and `truncated`.
- Base: A direct source or installed-tarball CLI with an empty fixed Devin home
  waits for discovery and emits only `FC_KEY_MISSING`.
- Bad: The final request advertises only `answer` but still receives
  `restricted_exec`; executing it or silently opening another turn violates the
  bounded protocol.
- Bad: A path-only or prose-only remote answer becomes `complete`/zero
  candidates; this destroys the distinction between no match and failed local
  projection.

### 6. Tests Required

- Decode injected final request frames and assert both the force-answer user
  message and absence of `restricted_exec` from final tool definitions.
- Decode the preflight request and assert fixed model, gzip body, safe headers,
  shared budget use, and no map/stream after a rejected preflight.
- Inject capacity rejection followed by a valid frame; assert at most two
  same-request retries, decreasing shared deadline, no `X-Request-Id`, and no
  command or turn increment before the valid frame.
- Inject persistent capacity rejection; assert exactly two session refreshes,
  three JWT/preflight sessions, a single shared deadline, and no extra command
  or tool turn. Injected `waitImpl` may remove wall-clock delay but not attempts.
- Assert three local rounds plus the terminal request consume decreasing values
  from one deadline; assert an earlier locally evidenced `answer` ends without
  consuming remaining rounds; assert final `restricted_exec` is failure-closed
  with the fixed internal reason.
- Assert one malformed tool JSON receives one correction message and then
  succeeds; assert separate executable requests, the terminal answer-only
  request, and an answer-content correction request retain independent single
  replacements, while a second error for one request fails; no retry occurs for Connect framing or
  terminal-tool failures.
- Assert known malformed keys/trailing commas recover inside the envelope and a
  truncated restricted object salvages only balanced complete declared
  commands. Assert loose prose/path evidence is never executed or returned.
- Assert a tool-envelope prefix is never replayed and a non-whitespace JSON
  suffix receives only one correction; both checks must avoid remote text in
  public output.
- Spawn the direct source CLI and an offline-installed tarball CLI with an
  empty fixed Devin home; both must wait for discovery, emit `FC_KEY_MISSING`,
  and never return zero with empty stdout.
- Assert at most one answer-only correction for format/range projection rejects;
  it cannot erase a prior remote candidate into a complete empty result.
- Assert an answer-shape correction cannot erase a prior nonempty malformed
  answer into a complete empty result.
- Use a fixed local fixture to cover valid answer projection, multiple ranges
  in one file, missing range, denied path, EOF range, partial valid/invalid
  entries, result limit, explicit no-result, and arbitrary answer prose. Assert
  no snapshot has a key, JWT, remote body, or rejected path.
- Assert omitted but locally executed implementation evidence is reopened and
  validated, increments `recovered_candidates`, and sets the fixed truncated
  reason even when another source candidate was accepted.
- Compare packed runtime entry files to source files after offline install and
  require the projection reason in the installed `core.mjs`.

### 7. Wrong Vs Correct

Wrong:

```js
if (candidates.length === 0) return { status: "complete", candidates: [] };
if (finalTurn) await executor.execToolCall(remoteArgs);
```

Correct:

```js
if (remoteCandidateCount > 0 && rejectedCandidates > 0) {
  reasons.add("remote_candidate_projection_rejected");
  status = "truncated";
}
if (finalTurn && toolCall.name === "restricted_exec") {
  throw protocolError("answer_only_restricted_exec");
}
```

Wrong:

```js
const jwt = await fetchJwt(apiKey, fetchImpl, timeoutMs, signal);
const repoMap = await guard.buildRepoMap(new ResourceBudget({ timeoutMs }));
```

Correct:

```js
const jwt = await fetchJwt(apiKey, fetchImpl, budget.remainingMs(), budget.signal);
await checkRateLimit(apiKey, jwt, fetchImpl, budget.remainingMs(), budget.signal);
const repoMap = await guard.buildRepoMap(budget);
```

Wrong:

```js
if (error.code === "FC_REMOTE_UNAVAILABLE") {
  return requestToolCall(buildNewRequest(), fetchImpl, freshTimeout, signal);
}
```

Correct:

```js
if (isRetryableStreamFailure(error) && attempt < MAX_STREAM_RETRIES) {
  await waitForStreamRetry(budget.signal, fixedBackoff);
  return requestToolCall(theSameRequest, fetchImpl, budget, onRetry);
}
throw error;
```

Wrong:

```js
let stageFormatRetries = 0;
if (invalidTool && stageFormatRetries++ === 0) retryAcrossTheWholeStage();
```

Correct:

```js
let requestFormatRetries = 0;
if (invalidTool && requestFormatRetries++ === 0) replaceThatRequestOnce();
```

Wrong:

```js
runCli({ argv: process.argv.slice(2) }).then((exitCode) => {
  process.exitCode = exitCode;
});
```

Correct:

```js
const cliKeepalive = setInterval(() => {}, 2 ** 31 - 1);
try {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
} finally {
  clearInterval(cliKeepalive);
}
```
