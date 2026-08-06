# `@pennixrv/fast-context-skill`

An on-demand Agent Skill and local CLI that asks Windsurf Devstral for bounded
semantic code-search candidates. Local `rg` and CodeGraph remain the default
path; this helper is for genuinely unknown locations or vague legacy behavior.

## Use

Set a key explicitly for the current process, then pass an existing project
directory:

```bash
WINDSURF_API_KEY='provided-out-of-band' \
  npx --yes @pennixrv/fast-context-skill \
  --project "/absolute/path/to/project" \
  --query "Where is the legacy import flow implemented?"
```

The accepted options are `--project`, `--query`, bounded `--max-results`,
repeatable relative `--deny`, and standalone `--help`. The CLI never discovers,
prints, stores, or logs credentials. It rejects metadata, secrets, generated
output, and paths outside the canonical project root before any remote request.

Use the returned paths only as hints and verify them with local tools. A single
JSON result is emitted on stdout; fixed `FC_*` diagnostics are emitted on
stderr. No MCP server, registration, approval, whitelist, or global agent
configuration is required.

## Development

All checks are offline and use temporary fixtures or injected request runners:

```bash
npm test
npm run verify:provenance
npm run pack:check
npm pack --dry-run --json --ignore-scripts
node scripts/release/build-package.mjs --output dist/package-check
```

These commands do not call Windsurf, npm publication, GitHub, or any real
credential source.

The `test`, `release`, `release:verify`, and packaging-check scripts belong to
the source repository's maintainer workflow. They are intentionally omitted
from the installed consumer manifest; installation exposes only the runtime
CLI and Skill assets.

## Attribution

The upstream MIT license is preserved at `scripts/lib/LICENSE.fast-context-mcp`.
See `NOTICE.md` and [`references/source-provenance.json`](references/source-provenance.json)
for the public shipped-file classification and digests. The projection is
included in the npm tarball; the full maintainer provenance remains source-only.
