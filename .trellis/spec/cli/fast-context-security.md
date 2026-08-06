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
  version for a bounded interval before reporting success.
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
- Release tests assert canonical/raw digest separation, staged-manifest digest,
  strict tag metadata, and explicit workflow tag forwarding.
- Offline tests assert the exact package allowlist, privacy-safe README
  provenance link, script-free staged manifest, and packed install with CLI
  `--help`.
- Operator verification records `npm dist-tag ls`, public tarball HTTP status,
  and downloaded tarball SHA-256 after publication.

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
