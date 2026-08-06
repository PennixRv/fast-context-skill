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
{"status":"ok","search_terms":["import"],"candidates":[{"path":"src/import.mjs","start_line":12,"end_line":20,"reason":"semantic_candidate"}],"truncated":false}
```

Candidates are revalidated locally. Remote prose, raw protocol frames, file
contents, repository maps, progress events, child stderr, and caught exception
messages are never public output. Failures use a fixed `FC_*` code and local
diagnostic text on stderr.
