# Technical Design

## 1. Boundaries And Ownership

The fork keeps one local CLI entry point in
`scripts/fast-context-search.mjs` and isolates security-sensitive behavior in
small modules:

| Module | Responsibility |
| --- | --- |
| `scripts/lib/path-guard.mjs` | Canonical root, relative-path validation, real-path containment, hard and additive deny policy, safe directory walking, and guarded reads |
| `scripts/lib/executor.mjs` | Structured remote-tool dispatch; every filesystem operation delegates to `PathGuard` and no arbitrary subprocess flags are accepted |
| `scripts/lib/directory-scorer.mjs` | Candidate scoring through injected guard-backed walkers/readers only |
| `scripts/lib/core.mjs` | Bounded local context, explicit credential gate, request protocol, and candidate projection; no credential discovery or raw fallback |
| `scripts/fast-context-search.mjs` | Exact public argument contract, sanitized exit errors, and one final stdout result |
| `scripts/lib/provenance.mjs` and `scripts/release/verify-tag.mjs` | Offline provenance and tag/package gate helpers used by tests and CI |
| `skills/fast-context/SKILL.md` plus `skills/fast-context/references/` | Concise on-demand routing and detailed user-facing contract |

No MCP server, background indexer, project registration, approval file,
whitelist, context-mode hook, CodeGraph change, or global configuration is
introduced.

## 2. Canonical Root And Path Guard

`canonicalizeProjectRoot(value)` rejects a missing, repeated, empty, or
non-directory `--project` value, obtains `realpathSync(value)`, and stores the
result as the only process root. The public parser accepts no `-p` or
`--project-path` alias. Internal callers receive the guard instance rather
than a second root string.

The finite public argv grammar is:

| Option | Cardinality and value | Default/behavior |
| --- | --- | --- |
| `--project <directory>` | exactly once; nonempty path value | required |
| `--query <text>` | exactly once; nonempty bounded text value | required |
| `--max-results <integer>` | at most once; bounded positive integer | `10` |
| `--deny <relative-glob>` | repeatable additive pattern | none |
| `--help` | only argument when present | prints fixed usage and exits 0 |

Short aliases, tuning flags, key flags, `--exclude`, `--project-path`, unknown
options, positional arguments, duplicate options, missing values, and values
that begin with an option all fail deterministically before importing core,
reading the environment, constructing a client, or preparing a request. The
parser validates option shape first, then required cardinality, then root,
query, integer, and deny-pattern semantics; public errors are closed `FC_*`
messages rather than interpolated parser exceptions.

`PathGuard.resolve(relativePath, options)` has this order:

1. Require a nonempty string; reject NUL/control characters, POSIX or Windows
   absolute forms, drive prefixes, and `..` components after treating both
   slash characters as separators.
2. For a glob, validate the non-wildcard parent and reject negation or a
   pattern that can escape that parent. For a direct path, require existence.
3. Resolve the candidate from the canonical root, call `realpathSync`, and
   calculate `path.relative(root, resolved)`. Reject empty parent traversal,
   external targets, broken links, resolution errors, and unexpected types.
4. Match hard denies against both requested and canonical relative components;
   then match additive project patterns. A denied or failed resolution returns
   a stable error code without echoing the path.

The hard policy is immutable and additive user patterns cannot negate it. It
contains exact components `.git`, `.trellis`, `.codegraph`, `.codex`, `.ssh`,
log directories, common generated directories (`dist`, `build`, `coverage`,
`.cache`, `out`, and `target`), and `node_modules`; filename rules cover
`.env`/`.env.*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.netrc`, credential/token/
secret/password/api-key names, and log/generated suffixes. A CLI `--deny`
option may add relative glob patterns, but rejects empty, absolute, traversal,
and negated patterns and never changes the baseline.

Recursive `rg`, `tree`, `ls`, and `glob` use a guard-backed walker that skips
hard-denied entries before launching a subprocess. The `rg` adapter first
enumerates a finite guard-approved list of canonical regular files; it never
passes a directory operand. It invokes the absolute ripgrep executable with a
fixed argv shape equivalent to `--no-config --no-ignore --no-follow
--no-heading --line-number --color never --regexp <query> -- <files>`, so a
dash-prefixed query or filename cannot become an option. It passes a minimal
explicit environment containing locale and the empty ripgrep-config setting,
not the caller's environment. Model-supplied option strings, globs, cwd, and
environment values are rejected. Every returned path is resolved and rechecked
before it enters a result. Scorer and repository-map code use the same
walker/read methods; no direct `fs` call or unbounded child-process path
remains in those flows.

### Error Matrix

| Condition | Public code | Information policy |
| --- | --- | --- |
| Missing/repeated/alias project | `FC_PROJECT_REQUIRED` / `FC_PROJECT_DUPLICATE` / `FC_PROJECT_ALIAS` | No root echo |
| Missing/repeated query or option value | `FC_QUERY_REQUIRED` / `FC_ARG_DUPLICATE` / `FC_ARG_VALUE_MISSING` | No value echo |
| Unknown/retired/positional option | `FC_ARG_UNKNOWN` | Fixed usage-free message |
| Missing/non-directory root | `FC_PROJECT_INVALID` | No absolute path echo |
| Empty/absolute/traversal/malformed local path | `FC_PATH_INVALID` | No candidate echo |
| Missing/broken link/type mismatch | `FC_PATH_UNAVAILABLE` | Stable code only |
| Outside-root or hard/additive deny | `FC_PATH_DENIED` | Stable code only |
| Missing/blank explicit key | `FC_KEY_MISSING` | Never echo key or environment |
| Network/protocol/size failure | `FC_REMOTE_UNAVAILABLE`, `FC_PROTOCOL_INVALID`, `FC_OUTPUT_LIMIT` | Fixed local message only |

## 3. Credential, Network, And Result State

The state order is intentionally fail-closed:

```text
parse exact args
  -> canonicalize root and construct immutable PathGuard
  -> validate query and additive deny patterns
  -> read only process.env.WINDSURF_API_KEY
  -> reject absent/blank key before request client, DNS, socket, or body setup
  -> build bounded guarded context
  -> send one bounded request with timeout/abort
  -> parse allowlisted protocol fields
  -> locally revalidate candidate paths and project safe output
```

`extract-key.mjs`, desktop/database discovery, `--check-key`, `--print-key`,
`--key-env`, and `--db-path` are removed. The key exists only in the request
closure, is never logged or written, and test fixtures use a synthetic value.

The request and response are bounded by named constants for query length,
context-file count, file bytes, request bytes, response bytes, candidate count,
reason length, and diagnostic length. No prompt, map, response, or progress
event is persisted by default.

The protocol parser accepts only an object with a bounded `candidates` array.
Each candidate must contain a safe relative path, finite positive line numbers,
and one of the local reason codes `name_match`, `path_match`, or
`semantic_candidate`. Free-form remote reason text is discarded. Paths are
resolved and locally revalidated; invalid, denied, absolute, missing, or
out-of-root candidates are dropped without echoing them. The final stdout is a
single deterministic JSON object:

```json
{"status":"ok","search_terms":["..."],"candidates":[{"path":"src/x.mjs","start_line":12,"end_line":18,"reason":"semantic_candidate"}],"truncated":false}
```

`search_terms` derive from the bounded local query, not arbitrary response
text. Public diagnostics are a closed mapping from each `FC_*` code to a fixed
local literal. They never include caught messages, stacks, child stderr,
transport status, parser excerpts, or protocol fields, even in bounded form;
internal causes are non-emitted. There is no raw-response, progress,
file-content, map, or credential fallback.

## 4. Skill Routing

The packaged Skill is concise and explicitly on-demand. It routes in this
order: local `rg`/direct reads, CodeGraph for known symbols and relationships,
then Fast Context only for a genuinely unknown location or vague business/
legacy description. It is skipped for known files/symbols, impact analysis,
literal/config/log searches, external documentation, and ordinary conversation.
The Skill states that the CLI enforces the root and key boundary; prompting
does not create approval or registration. Returned candidates are untrusted
and must be verified locally before structural use.

## 5. Provenance, Package, And Release Contracts

`docs/security/source-provenance.json` is canonical JSON with stable key order
and sorted `files`. Its `expected_runtime_paths` is the authoritative,
sorted set derived from the exact package-content allowlist for runtime source
files. Every expected path has exactly one classification: a `vendored` entry
contains `shipped_path`, upstream repository, immutable source commit/path,
`upstream_sha256`, `shipped_sha256`, license/NOTICE reference, and a short
`change_summary`; a `fork_owned` entry contains an explicit owner/change record
and the shipped digest. A verifier hashes exact bytes from the local upstream
Git object and the checked-out shipped file, then rejects unmatched,
duplicate, unsafe, misclassified, missing, or digest/license-mismatched
records.

`package.json` becomes `@pennixrv/fast-context-skill` version `0.1.0` with an
individual-file `files` allowlist. A package-content test compares the exact
normalized `npm pack --dry-run --json` set against the allowlist and rejects
tests, task state, local configuration, maps, generated output, and workflow
files. A packed-install smoke test installs the exact tarball offline with
scripts/audit/fund disabled.

CI on pull requests runs syntax/type checks, the full offline suite, the
provenance verifier, package-content assertions, and `npm pack --dry-run`.
The tag workflow accepts only an annotated `v<semver>` tag whose peeled target
is the checked revision, matches `package.json`, has a clean tree, and passes
all gates. The validation job declares `contents: read` only. A separate
future GitHub Release job alone receives `contents: write` and no
`id-token`; a separate npm-publish job receives `contents: read` plus
`id-token: write` (or a narrowly scoped future `NPM_TOKEN`) and no
`contents: write`. Static workflow tests reject omitted or broad permissions.

The manual `publish-npm` workflow accepts an existing annotated tag only,
checks the package/tag and provenance again, creates one tarball from the
peeled tag with lifecycle scripts disabled, computes and retains its SHA-256,
and runs package-content and packed-install checks against that exact file.
It rechecks tracked and untracked cleanliness immediately before publication
and passes only that unchanged tarball path to the publisher. Any mutation,
repack, lifecycle-script request, or provenance mismatch aborts. It treats
only an explicit registry 404 as "not already published", fails closed on all
other lookup errors, publishes with provenance, and polls for the exact
version. None of these workflows is dispatched during this task.

## 6. Rollback And Deferred Decisions

Implementation is staged so a failed gate can stop before package metadata or
workflow changes: path guard/executor, credential removal, protocol/output,
Skill, provenance/package, then CI/release. Each stage retains offline tests;
the last passing stage is the rollback point. No tag, Release, publish, or
deployment rollback is needed because none is executed.

The named `grill-me` Trellis capability is unavailable in installed `0.6.10`;
planning cannot claim that gate passed. The final planning review must ask the
user whether to authorize a documented project-local equivalent adversarial
review or wait for an environment exposing the named command. npm scope
ownership, trusted-publishing availability, and remote tag protection remain
release-time gates and are not probed here. Upstream synchronization and
homewsl/CodeGraph/context-mode integration are separate later tasks.
