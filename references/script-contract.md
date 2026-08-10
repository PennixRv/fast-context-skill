# Script Contract

The CLI accepts exactly one `--project <directory>` and one `--query <text>`.
It also accepts bounded `--max-results <1..50>`, repeatable relative
`--deny <glob>`, and standalone `--help`. Short aliases, positional values,
retired credential flags, duplicate options, and unknown options fail closed.

Every local operation is confined to the canonical project root. The baseline
deny set covers repository metadata, Trellis/Codex state, credentials,
generated output, logs, and dependency trees. `--deny` can only narrow this
set.

Successful stdout is one JSON object:

```json
{"status":"truncated","search_terms":["import"],"candidates":[{"path":"src/import.mjs","start_line":12,"end_line":20,"reason":"semantic_candidate"}],"truncated":true,"coverage":{"visited":{"entries":4096,"directories":128,"files":2048,"matches":37,"outputBytes":18320},"continuation":{"pending_directories":3,"next_path":"/codebase/src/remaining"},"reasons":["file_limit"]}}
```

`status: "complete"` means every PathGuard-approved path in the bounded local
enumeration was consumed. It does not include denied paths and is not a claim
of unrestricted whole-repository coverage or semantic correctness.
`status: "truncated"` means one or more fixed resource limits, local tool
failures, or the candidate result limit made the result incomplete. The legacy
`truncated` boolean remains aligned with `status`. `coverage.visited` is the
shared invocation-wide count; `coverage.reasons` contains only local fixed
identifiers; `coverage.continuation` identifies the last bounded frontier when
one is available.

Every repository-map and restricted local tool result sent to the remote model
uses the same `complete`, `truncated`, or `failure` status words. Tool failures
contain only a fixed local `FC_*` code. A truncated no-match tool result is
rendered as `(no matches in visited files|paths)`, never as conclusive
`(no matches)`.

Candidate paths are revalidated locally through PathGuard. Remote prose, raw
protocol frames, file contents, repository maps, progress events, child stderr,
and caught exception messages are never public output. Public failures use a
fixed `FC_*` code and local diagnostic text on stderr.
