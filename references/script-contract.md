# Script Contract

The CLI accepts exactly one `--project <directory>` and one `--query <text>`.
It also accepts bounded `--max-results <1..50>`, repeatable relative
`--deny <glob>`, standalone `--no-external`, and standalone `--help`. Short
aliases, positional values, retired credential flags, duplicate options, and
unknown options fail closed.

Every local operation is confined to the canonical project root. The baseline
deny set covers repository metadata, Trellis/Codex state, credentials,
generated output, logs, and dependency trees. `--deny` can only narrow this
set.

After argv and project-root validation, the CLI chooses credentials in a fixed
order: a non-empty explicit `WINDSURF_API_KEY`, then a Linux/WSL Devin CLI
login. The fallback is a package-owned, no-shell Node helper that only opens
the current user's fixed `~/.local/share/devin/credentials.toml` path, rejects
symlinks and oversize files, accepts only known fields and supported
`devin-session-token$`, `devin-`, or `sk-` forms, and returns an accepted value
through a bounded private pipe. It never scans desktop state databases or
alternative paths. The CLI never prints, stores, logs, places in arguments, or
returns credentials. Missing or invalid discovery fails as `FC_KEY_MISSING`.

`--no-external` is the caller's explicit opt-out. It does not inspect the
environment, start the credential helper, import the search core, or create a
network request; it writes only `FC_EXTERNAL_DISABLED` to stderr. HTTP `401`
and `403` produce `FC_AUTH_REJECTED`; a shared deadline produces
`FC_REMOTE_TIMEOUT`; transport/caller cancellation and a valid Connect
`resource_exhausted`/`unavailable` EndStream produce `FC_REMOTE_UNAVAILABLE`;
`5xx` and valid Connect `internal`/`unknown` EndStreams produce
`FC_REMOTE_SERVER_ERROR`; malformed JWT or Connect framing produces
`FC_PROTOCOL_INVALID`. These diagnostics never include response bodies,
headers, request identifiers, paths, token-derived data, or caught exception
text.

After JWT acquisition, the live request path performs one gzip protobuf
`CheckUserMessageRateLimit` preflight for the fixed `MODEL_SWE_1_6_FAST` model
before building a repository map or opening the answer/tool stream. It uses the
same remaining monotonic deadline and safe metadata as the stream route. A
rejected, unavailable, timed-out, or server-error preflight stops the search
with its existing fixed diagnostic; it does not inspect project files or send a
stream request, and its response is discarded.

A stream response with fixed capacity/availability evidence may retry the
identical request at most twice after short fixed backoff. Each attempt takes
the shared remaining deadline; retrying does not add a local-tool turn, command,
format correction, request ID, or candidate source. Malformed Connect data,
authentication, timeout, `5xx`, output ceilings, parser failures, and final
protocol violations do not use this retry path.
When all attempts end specifically in a valid Connect `resource_exhausted`, the
client may perform at most two session refreshes. Each refresh waits within the
same deadline, obtains a new JWT in memory, repeats the fixed rate-limit
preflight, and retries the unchanged current request. It never resets the
deadline or model/tool counters; exhaustion after the second refresh remains
`FC_REMOTE_UNAVAILABLE`.

Within the bounded tool envelope, the parser first accepts strict JSON, then may
repair only known unquoted-key and trailing-comma defects. A truncated
`restricted_exec` envelope may contribute only complete top-level
`command1` through `command4` objects with recognized command types. The parser
does not scan response prose for loose paths, commands, candidates, or ranges.
If this bounded recovery cannot produce a valid call, each logical remote
request has one fixed replacement under the same deadline. A second malformed
envelope for that request remains `FC_PROTOCOL_INVALID`; a replacement does not
add a tool turn or execute a command. This same helper covers ordinary tool
rounds, the terminal answer request, and the one bounded answer-content
correction request.

For protocol grounding, a guarded successful `readfile` result includes only an
internal `read_range` object with the exact inclusive bounds of the numbered
rows actually returned. Terminal answer and answer-correction prompts require a
candidate to copy that positive range rather than estimate it. The field is not
public CLI JSON, is `null` for an empty read, and never replaces the final
same-version `validateCandidateRange()` check.

Successful stdout is one JSON object:

```json
{"status":"truncated","search_terms":["import"],"candidates":[{"path":"src/import.mjs","start_line":12,"end_line":20,"reason":"local_range_validated"}],"truncated":true,"projection":{"remote_candidates":2,"accepted_candidates":1,"recovered_candidates":0,"rejected_candidates":1,"unprocessed_candidates":0,"rejection_reasons":["remote_candidate_range_rejected"]},"coverage":{"visited":{"entries":4096,"directories":128,"files":2048,"matches":37,"outputBytes":18320},"continuation":{"pending_directories":3,"next_path":"/codebase/src/remaining"},"reasons":["file_limit","remote_candidate_projection_rejected"]}}
```

`status: "complete"` means every PathGuard-approved path in the bounded local
enumeration was consumed. It does not include denied paths and is not a claim
of unrestricted whole-repository coverage or semantic correctness.
`status: "truncated"` means one or more fixed resource limits, local tool
failures, the candidate result limit, or remote candidates rejected by local
projection made the result incomplete. The legacy `truncated` boolean remains
aligned with `status`. `coverage.visited` is the shared invocation-wide count;
`coverage.reasons` contains only fixed client identifiers; `coverage.continuation`
identifies the last bounded frontier when one is available.

`projection` contains counts only. `remote_candidates` is the number of remote
candidate ranges (a `<file>` may contain more than one `<range>`),
`accepted_candidates` is the number that passed local PathGuard/range
validation, `recovered_candidates` is zero or one for the primary non-test
implementation range recovered from this invocation's successfully executed
local evidence and then locally revalidated. The first implementation
`readfile` wins; only when no implementation was read or accepted may the
client inspect at most four accepted local tests and twelve `./`/`../` import
specifiers to resolve one guarded implementation. Standard `.js`, `.jsx`,
`.mjs`, and `.cjs` specifiers may map to their TypeScript source extension;
package imports, absolute paths, root escapes, missing paths, and response prose
are never candidates. Only after that may the strongest bounded `rg` path be
considered.
`rejected_candidates` is the number locally rejected for format, path, range,
duplicate, or version reasons, and
`unprocessed_candidates` is the number left beyond `--max-results`. No field
contains rejected paths, ranges, XML, or remote prose. `rejection_reasons` is
the deduplicated fixed local category list for rejected entries. `complete`
with zero candidates is permitted only for exact `<no_results/>` or the
established empty `<ANSWER></ANSWER>` form.
Any recovered implementation candidate sets `status: "truncated"` and the
fixed `implementation_candidate_recovered` reason. Recovery never turns an
`rg` hit into a guessed range: the client performs a bounded guarded read and
the same final range validation first.
Any candidate rejection sets `status: "truncated"` and the fixed
`remote_candidate_projection_rejected` reason; arbitrary answer prose with no
candidate marker receives one fixed answer-only shape correction under the
same deadline. A second invalid shape is `FC_PROTOCOL_INVALID`, not semantic
no-result, and an empty correction cannot erase the prior nonempty malformed
answer into complete zero-candidate success. The envelope parser may recover a complete first top-level `answer`
JSON string when only the enclosing object is truncated; it never extracts a
candidate from prose, and the recovered string still undergoes strict XML,
PathGuard, and range validation.

Every repository-map and restricted local tool result sent to the remote model
uses the same `complete`, `truncated`, or `failure` status words. Tool failures
contain only a fixed local `FC_*` code. A truncated no-match tool result is
rendered as `(no matches in visited files|paths)`, never as conclusive
`(no matches)`.

Candidate projection has three separate guarantees:

1. Path validation: PathGuard rechecks canonical-root containment, hard and
   additional deny rules, ordinary-file type, and symlink escape behavior.
2. Range validation: the component opens the approved file and accepts only
   positive, ordered, 1-based ranges spanning at most 200 lines. The start and
   end must both exist in the same non-empty file version. There is no clamp;
   EOF overflow, empty files, oversized spans, and files changed during
   validation are dropped. A local change marks coverage as `truncated` with
   the fixed reason `candidate_changed`.
3. Semantic validation: the caller must read the returned source and decide
   whether it answers the query. `reason: "local_range_validated"` does not
   assert semantic correctness and no remote reason/prose is forwarded.

Remote prose, raw protocol frames, file contents, repository maps, progress
events, child stderr, and caught exception messages are never public output.
Public failures use a fixed `FC_*` code and local diagnostic text on stderr.

## Bounded remote completion

The remote protocol has at most three `restricted_exec` turns. Each one still
uses the same PathGuard, resource budget, command count, and output limits. A
locally evidenced `answer` may finish before that maximum; a remaining tool
turn is never consumed merely to exhaust the limit. Only after three effective
tool turns does the final request receive a fixed force-answer user message and
advertise only the `answer` tool. The message forbids `restricted_exec`,
requires strict `<file>`/`<range>` entries or an exact explicit no-result form,
limits the result count, and forbids guessed paths/ranges. A malformed tool-tag
JSON receives at most one fixed corrective user message per logical request and
one retry under the same remaining deadline; it neither forwards remote text
nor creates a new tool round. A projection rejection may similarly receive one answer-only correction
when the rejection is format/range related. The client rejects a terminal
non-answer response as `FC_PROTOCOL_INVALID`; its internal fixed protocol
reason is never emitted by the CLI. A tool envelope may have a bounded remote
reasoning prefix, but the client discards that prefix and never replays it in a
later request; non-whitespace JSON suffixes remain malformed. A valid remote
EndStream error remains
failure-closed but maps to its fixed service category rather than being
misreported as malformed Connect data. The terminal and correction requests
consume the same monotonic deadline and never create a fallback candidate
source.
