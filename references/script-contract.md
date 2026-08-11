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
`FC_REMOTE_TIMEOUT`; transport/caller cancellation produces
`FC_REMOTE_UNAVAILABLE`; `5xx` produces `FC_REMOTE_SERVER_ERROR`; malformed
JWT or Connect data produces `FC_PROTOCOL_INVALID`. These diagnostics never
include response bodies, headers, request identifiers, paths, token-derived
data, or caught exception text.

Successful stdout is one JSON object:

```json
{"status":"truncated","search_terms":["import"],"candidates":[{"path":"src/import.mjs","start_line":12,"end_line":20,"reason":"local_range_validated"}],"truncated":true,"projection":{"remote_candidates":2,"accepted_candidates":1,"rejected_candidates":1,"unprocessed_candidates":0,"rejection_reasons":["remote_candidate_range_rejected"]},"coverage":{"visited":{"entries":4096,"directories":128,"files":2048,"matches":37,"outputBytes":18320},"continuation":{"pending_directories":3,"next_path":"/codebase/src/remaining"},"reasons":["file_limit","remote_candidate_projection_rejected"]}}
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
`<file>` markers, `accepted_candidates` is the number that passed local
PathGuard/range validation, `rejected_candidates` is the number locally
rejected for format, path, range, duplicate, or version reasons, and
`unprocessed_candidates` is the number left beyond `--max-results`. No field
contains rejected paths, ranges, XML, or remote prose. `rejection_reasons` is
the deduplicated fixed local category list for rejected entries. `complete`
with zero candidates is permitted only for exact `<no_results/>` or the
established empty `<ANSWER></ANSWER>` form.
Any candidate rejection sets `status: "truncated"` and the fixed
`remote_candidate_projection_rejected` reason; arbitrary answer prose with no
candidate marker is `FC_PROTOCOL_INVALID`, not semantic no-result.

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
fourth and final request first receives a fixed force-answer user message and
advertises only the `answer` tool. The message forbids `restricted_exec`,
requires strict `<file>`/`<range>` entries or an exact explicit no-result form,
limits the result count, and forbids guessed paths/ranges. A malformed tool-tag
JSON receives one fixed corrective user message and one retry under the same
remaining deadline; it neither forwards remote text nor creates a new tool
round. A projection rejection may similarly receive one answer-only correction
when the rejection is format/range related. The client rejects a terminal
non-answer response as `FC_PROTOCOL_INVALID`; its internal fixed protocol
reason is never emitted by the CLI. The terminal and correction requests consume
the same monotonic deadline and never create a fallback candidate source.
