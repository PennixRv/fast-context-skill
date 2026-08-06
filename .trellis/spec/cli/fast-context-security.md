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

stdout: { status, search_terms, candidates, truncated }
stderr: FC_*: fixed local diagnostic
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
- Successful candidates use safe relative paths, positive ranges, and the
  local `semantic_candidate` reason only. Remote prose and reasons are dropped.

### 4. Validation And Error Matrix

| Condition | Required result |
| --- | --- |
| Missing/repeated project or query | Fixed `FC_PROJECT_*`, `FC_QUERY_REQUIRED`, or `FC_ARG_*` diagnostic |
| Absolute, traversal, missing, type-invalid, symlink-escaping path | `FC_PATH_INVALID`, `FC_PATH_UNAVAILABLE`, or `FC_PATH_DENIED` |
| Metadata, secret, log, generated, or additive-deny path | `FC_PATH_DENIED` |
| Blank explicit key | `FC_KEY_MISSING` before core import/fetch |
| Child, transport, malformed protocol, or size failure | Fixed `FC_TOOL_UNAVAILABLE`, `FC_REMOTE_UNAVAILABLE`, `FC_PROTOCOL_INVALID`, or `FC_OUTPUT_LIMIT` without raw detail |

### 5. Good, Base, And Bad Cases

- Good: `--project /repo --query "legacy import"` with an explicit process key
  yields revalidated relative candidates.
- Base: A guarded repository contains no source files; `rg` returns
  `(no matches)` and makes no unsafe subprocess call.
- Bad: A model asks for `/codebase/.trellis/tasks`, `../secret`, an outside
  symlink, `secrets/config`, or a dash-prefixed `rg` option. The guard or fixed
  argv rejects it without showing a path, child stderr, or secret.

### 6. Tests Required

- Parser tests prove rejected arguments do not read environment or import core.
- Guard tests cover absolute and slash/backslash traversal, symlinks, missing
  and type mismatch, hard/additive denies, and valid nested paths.
- Executor tests assert fixed `rg` argv, absolute binary, empty config path,
  approved file list, and closed child errors.
- Core tests inject synthetic protocol responses and assert key-before-fetch,
  malformed/oversized response handling, and local candidate projection.
- Package/release tests compare exact tarball contents, perform an offline
  lifecycle-disabled install, validate provenance, and assert workflow
  permissions and annotated-tag rules.

### 7. Wrong Vs Correct

Wrong:

```js
const key = await discoverDesktopCredential();
return fetch(url, { body: buildRequest(key, projectRoot) });
```

Correct:

```js
const guard = new PathGuard(project);
const key = requireApiKey(process.env);
const result = await search({ query, guard, apiKey: key });
```

Never add an approval file, registration, whitelist, global configuration, or
credential-discovery fallback to make the external request easier to invoke.
