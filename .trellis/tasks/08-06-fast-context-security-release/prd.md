# Fast Context Security Hardening And Release Design

## Goal

Design a reviewable, user-level Fast Context Skill and local CLI that returns
bounded external semantic-search candidates only when local search and
CodeGraph cannot locate relevant code. The fork must never read outside one
explicit project root, retain a credential or remote content, or turn external
search into a default retrieval path.

## Product Boundary

- The deliverable is an on-demand Skill and local CLI, not an MCP server,
  background indexer, persistent memory store, or universal code lookup.
- Local `rg` and direct reads come first; CodeGraph handles known symbols and
  relationships; Fast Context is used only for genuinely unknown locations or
  vague business/legacy descriptions after those methods are insufficient.
- Results are untrusted candidates to verify locally before any structural use.
- The CLI boundary, not prompting, enforces root, credential, filesystem, and
  output controls. No project registration, approval, or whitelist state is
  in scope.

## Confirmed Baseline

| Area | Current evidence | Required consequence |
| --- | --- | --- |
| Source baseline | `d5ebd5522295d21c1a4d6fcf05580e069104c5d6` | Fork provenance starts from this immutable revision. |
| CLI parser | `scripts/fast-context-search.mjs:12-41`, `:68-103` | It defaults to CWD and accepts aliases; replace with one finite required-root grammar. |
| Credential surface | `scripts/fast-context-search.mjs:163-175`, `:231-255`; `scripts/lib/extract-key.mjs:1`; `scripts/lib/core.mjs:27-29`, `:643-667` | Remove discovery, database paths, key flags, imports, and output paths. |
| Local reads | `scripts/lib/executor.mjs:43-64`, `:128-408`; `scripts/lib/core.mjs:1200-1294`; `scripts/lib/directory-scorer.mjs:183-430` | One guard must cover executor, map construction, scorer, walkers, and subprocess operands. |
| Raw output | `scripts/lib/core.mjs:1636-1683`, `:1859-1894` | Remove response/error/debug fallbacks and project only allowlisted result data. |
| Package identity | `package.json:2-17`, `:23-30` | Replace upstream identity and broad directory packaging. |
| Existing publish workflow | `.github/workflows/npm-publish.yml:3-13`, `:44-70` | Replace schedule/ref-free publishing with verified tag and manual-publish gates. |
| Trellis bootstrap | `cfbe51e` | Durable Trellis assets are tracked; native Codex subagents are disabled and delegation is channel-only. |

## Requirements

### R1: Exact CLI And Canonical Confinement

The public grammar accepts only `--project <directory>` and `--query <text>`
exactly once, optional bounded `--max-results <integer>`, repeatable additive
`--deny <relative-glob>`, and standalone `--help`. All short aliases,
`--project-path`, key flags, tuning/exclude flags, unknown options, positional
arguments, duplicate values, and missing values fail before core import,
environment access, request-client construction, or request setup.

The CLI canonicalizes the existing project directory once with real-path
semantics. Every `rg`, `readfile`, `tree`, `ls`, `glob`, repository-map, and
directory-scorer access uses one injected guard before it touches the
filesystem. The guard rejects empty, absolute, malformed, slash/backslash
traversal, missing, broken-link, unexpected-type, and root-internal symlink
escape inputs. It uses post-resolution containment, never lexical prefixes.

### R2: Non-Bypassable Deny And Subprocess Policy

After canonicalization every guarded path applies an immutable hard deny:
`.git`, `.trellis`, `.codegraph`, `.codex`, `.ssh`, `.env*`, key/credential/
token/secret/password/API-key names, `*.pem`, `*.key`, `id_*`, logs, common
generated output, and project-specific secret paths. Additive `--deny` globs
may narrow access but cannot negate the baseline.

Recursive operations walk only guard-approved entries. `rg` runs only against
a finite approved regular-file list with absolute executable, fixed no-config/
no-follow argv, `--regexp <query>`, option terminator, and minimal explicit
environment. Remote models cannot control options, cwd, glob expansion, or
child environment. Result-path revalidation supplements, but never replaces,
pre-launch containment.

### R3: Explicit Credential, Network, And Diagnostic Boundary

Delete `extract-key.mjs`, automatic desktop/database discovery, and all
key-related flags. Read only a nonempty `WINDSURF_API_KEY` from the environment
after structural argument/root validation and before request-client, DNS,
socket, body, or local-context preparation. Never write, log, print, persist,
or inspect another credential source.

Protocol data becomes one bounded deterministic candidate object with safe
relative paths, finite line ranges, locally defined reason codes, and query
derived search terms. Free-form remote text is discarded. Public diagnostics
are closed fixed mappings from `FC_*` codes; stdout, stderr, public errors,
and debug paths never interpolate caught messages, stacks, child stderr,
transport status, parser text, raw protocol data, maps, file contents, or
fixture keys.

### R4: Skill Routing Without Approval State

Replace the inherited Skill with concise metadata and a packaged reference.
It visibly marks Fast Context as external and on-demand, routes local search
then CodeGraph before it, and skips known files/symbols, caller analysis,
literal/config/log searches, external documentation, and ordinary discussion.
It creates no MCP registration, install side effect, approval file,
registration, whitelist, hook, or global Codex mutation.

### R5: Fork Provenance And Package Artifact

Release identity is `@pennixrv/fast-context-skill@0.1.0`, independent of
upstream tags and repository URLs. Retain MIT obligations in `LICENSE` and
`NOTICE.md`. A canonical source provenance record derives the full sorted
runtime-source path universe from the exact package allowlist and requires
exactly one `vendored` or `fork_owned` classification and shipped SHA-256 for
each path. Vendored records also contain repository, immutable source
commit/path, upstream SHA-256, license/NOTICE reference, and fork delta.

Use an individual-file npm `files` allowlist. The exact tarball may contain
only runtime code, packaged Skill/reference, safe documentation, licenses/
NOTICE, and provenance material; it excludes tests, Trellis/Codex state,
workflows, local configuration, maps, generated output, and development
material. Package assertions inspect the actual tarball, not the manifest
alone.

### R6: Offline Tests, CI, And Tag-Bound Publication Design

All tests use fixtures, injected runners, or mocked protocol responses. They
never call Windsurf/npm/GitHub, inspect a real credential, tag, publish, or
create a Release. PR CI runs syntax/type checks, the complete offline suite,
provenance verification, exact package-content checks, and `npm pack --dry-run`.

Release validation accepts only an annotated immutable `v<semver>` tag whose
peeled target is the checked revision, matches `package.json`, has no tracked
or untracked drift, and passes all gates. The future manual publish workflow
builds one lifecycle-disabled tarball from that revision, records its SHA-256,
validates and installs that exact file offline, rechecks its digest/cleanliness,
and publishes only that unchanged path with provenance. Only an explicit
registry 404 means not-yet-published; every other lookup/provenance error fails
closed. Validation, Release, and npm jobs use separately asserted least
privilege.

## Acceptance Criteria

- [ ] R1 parser tests cover help, all accepted options, required cardinality,
  aliases, retired/unknown options, missing values, duplicates, and proof that
  failures precede core/key/client/request setup.
- [ ] R1/R2 tests cover every primitive plus map/scorer reads for absolute,
  slash/backslash traversal, escaping/broken symlink, missing/type mismatch,
  every deny category, and valid nested paths.
- [ ] R2 spawn-spy tests prove dash-prefixed query/file inputs and hostile
  inherited configuration cannot alter the fixed `rg` argv, environment, or
  approved file set.
- [ ] R3 tests prove missing-key failure precedes networking; a synthetic key
  and remote/child/parser sentinels appear in no public output path.
- [ ] R3 malformed and oversized protocol fixtures yield only bounded safe
  candidates or fixed `FC_*` failures, never raw content or absolute paths.
- [ ] R4 tests and package inspection confirm local-first/CodeGraph-first
  routing with no automatic invocation, registration, approval, or whitelist.
- [ ] R5 provenance verification rejects an unrecorded, duplicate, unsafe, or
  misclassified allowlisted runtime path and validates byte-accurate records.
- [ ] R5 package tests compare exact `npm pack --dry-run --json` paths and
  install the produced tarball offline with scripts/audit/fund disabled.
- [ ] R6 fixture Git tests reject lightweight, malformed, mismatched, dirty,
  untracked, provenance-invalid, or package-invalid tag candidates; injected
  publishing tests reject mutations/repacking and receive only the verified
  tarball path/digest.
- [ ] R6 workflow static tests require `contents: read` validation,
  `contents: write` only for the future Release job, and `id-token: write` only
  for the future npm job; no workflow is dispatched in this task.
- [ ] No implementation or test reads a real Windsurf/npm credential, calls
  Windsurf/npm/GitHub, publishes, tags, creates a Release, or changes homewsl,
  CodeGraph, context-mode, OpenViking, or global Codex configuration.

## Out Of Scope

- Installing `fast-context-mcp`, registering an MCP server, global Skill
  installation, `npm install` side effects, homewsl deployment, or CodeGraph
  indexing/configuration.
- A project-level approval, registration, or whitelist mechanism.
- Real Windsurf, npm, GitHub, tag, Release, registry, or credential operation.
- Treating a sandbox/container as a substitute for source-level confinement.
- Upstream synchronization, trusted-publishing enrollment, scope-ownership
  verification, remote tag protection, and context-mode integration; each is a
  later release or deployment gate.

## Planning Evidence And Status

- [x] Repository-backed executor/credential audit:
  `research/executor-credential-audit.md`.
- [x] Provenance/package/release audit:
  `research/provenance-package-release-audit.md`.
- [x] Two Trellis-channel pressure-test rounds with opposite executor and
  package reviews; second-round blockers are resolved in `design.md` and
  recorded in `research/round-2-opposition-review.md`.
- [x] Complete design and ordered implementation plan: `design.md` and
  `implement.md`.
- [ ] Named `grill-me` gate. Installed Trellis `0.6.10` exposes no command or
  project skill for it; no ordinary review is being represented as that command.

## Blocking Planning Decision

The only remaining planning decision is procedural: authorize a documented
project-local adversarial review as the `grill-me` equivalent, or require an
environment that provides the named Trellis capability. The recommended choice
is the documented local equivalent because the two completed channel pressure
tests already provide a scoped basis; waiting preserves literal command
compliance but blocks implementation without changing product scope.
