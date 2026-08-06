import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyTag } from "../scripts/release/verify-tag.mjs";
import {
  canonicalAttestationSha256,
  formatTagMetadata,
  parseTagMetadata,
  sha256Bytes,
  tarballFilename,
  validateAttestation,
} from "../scripts/release/attestation.mjs";
import { parseArguments } from "../scripts/release/publish-release.mjs";
import { verifyAttestedReleaseArtifact } from "../scripts/release/preflight-release.mjs";
import { attestationPathForTag, packageArchivePaths } from "../scripts/release/verify-release-evidence.mjs";

test("tag verifier requires an annotated, exact, clean version tag", () => {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const releaseTag = `v${packageVersion}`;
  const unexpectedTag = releaseTag === "v0.0.0" ? "v0.0.1" : "v0.0.0";
  const calls = [];
  const values = new Map([
    [`cat-file -t ${releaseTag}`, "tag"],
    [`rev-parse ${releaseTag}^{}`, "abc123"],
    [`cat-file -t ${unexpectedTag}`, "tag"],
    [`rev-parse ${unexpectedTag}^{}`, "abc123"],
    ["rev-parse HEAD", "abc123"],
    ["status --porcelain", ""],
  ]);
  const gitRunner = (args) => {
    calls.push(args.join(" "));
    return values.get(args.join(" ")) || "";
  };
  assert.equal(verifyTag({ tag: releaseTag, gitRunner }), true);
  assert.ok(calls.includes(`cat-file -t ${releaseTag}`));
  assert.throws(() => verifyTag({ tag: unexpectedTag, gitRunner }));
  assert.throws(() => verifyTag({ tag: "0.1.1", gitRunner }));
});

test("release preflight requires the exact tracked tarball before evidence generation", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-attested-tarball-"));
  const tag = "v0.1.3";
  const bytes = Buffer.from("attested tarball fixture");
  const artifact = { sha256: sha256Bytes(bytes) };
  try {
    assert.throws(() => verifyAttestedReleaseArtifact({ tag, artifact, projectRoot: temporaryDirectory }));
    const artifactDirectory = join(temporaryDirectory, "docs", "releases", "artifacts");
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, `${tag}.tgz`), bytes);
    assert.equal(
      verifyAttestedReleaseArtifact({ tag, artifact, projectRoot: temporaryDirectory }),
      join(artifactDirectory, `${tag}.tgz`),
    );
    assert.throws(() => verifyAttestedReleaseArtifact({
      tag,
      artifact: { sha256: "0".repeat(64) },
      projectRoot: temporaryDirectory,
    }));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release rebuild archives only the source package allowlist", () => {
  assert.deepEqual(
    packageArchivePaths({ files: ["README.md", "scripts/fast-context-search.mjs"] }),
    ["README.md", "package.json", "scripts/fast-context-search.mjs"],
  );
  assert.throws(() => packageArchivePaths({ files: ["../secret"] }));
  assert.throws(() => packageArchivePaths({ files: ["scripts/"] }));
});

test("workflow permissions isolate validation, release, and npm publication", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const tag = readFileSync(".github/workflows/release-tag.yml", "utf8");
  const publish = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  assert.match(ci, /permissions:\n  contents: read/);
  assert.doesNotMatch(ci, /id-token:\s*write/);
  assert.match(tag, /permissions:\n  contents: read/);
  assert.doesNotMatch(tag, /contents:\s*write/);
  assert.doesNotMatch(tag, /gh release create/);
  assert.match(publish, /permissions:\n  contents: read/);
  assert.match(publish, /contents: read\n      id-token: write/);
  assert.doesNotMatch(publish, /contents: write/);
  assert.doesNotMatch(publish, /schedule:/);
  assert.match(publish, /--ignore-scripts/);
  assert.match(publish, /Publish exact tarball with npm provenance/);
  assert.match(publish, /env:\n      NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(publish, /Verify npm publication identity/);
  assert.match(publish, /npm whoami >\/dev\/null/);
  assert.match(publish, /npm publish[^\n]*--provenance/);
  assert.match(publish, /npm audit signatures/);
  assert.doesNotMatch(publish, /package-manager-cache/);
  assert.match(ci, /npm pack --dry-run --json --ignore-scripts/);
  assert.match(tag, /npm pack --dry-run --json --ignore-scripts/);
  assert.match(ci, /build-package\.mjs --output/);
  assert.match(publish, /build-package\.mjs --output/);
  assert.match(ci, /npm install --global npm@12\.0\.1/);
  assert.match(tag, /npm install --global npm@12\.0\.1/);
  assert.match(publish, /npm install --global npm@12\.0\.1/);
  assert.match(ci, /node-version: "26\.5\.1"/);
  assert.match(tag, /node-version: "26\.5\.1"/);
  assert.match(publish, /node-version: "26\.5\.1"/);
  assert.match(publish, /verify-tag\.mjs.*verifyTag/);
  assert.match(publish, /verify-release-evidence\.mjs.*verifyReleaseEvidence/);
  assert.match(publish, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
  assert.doesNotMatch(publish, /- run: node --input-type=module -e/);
  assert.match(readFileSync("scripts/release/verify-tag.mjs", "utf8"), /process\.argv\[2\] \|\| process\.env\.GITHUB_REF_NAME/);
  assert.match(readFileSync("scripts/release/verify-release-evidence.mjs", "utf8"), /process\.argv\[2\] \|\| process\.env\.GITHUB_REF_NAME/);
  assert.match(publish, /actions\/upload-artifact@v4/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /Build diagnostic tarball before release evidence verification/);
  assert.match(publish, /rebuilt-npm-tarball-\$\{\{ github\.run_id \}\}/);
  assert.match(publish, /dist\/rebuilt-diagnostic\/\*\.tgz/);
  assert.ok(publish.indexOf("verify-tag.mjs") < publish.indexOf("Build diagnostic tarball"));
  assert.match(publish, /docs\/releases\/artifacts\/\$RELEASE_TAG\.tgz/);
  assert.match(publish, /git fetch --no-tags origin "\$GITHUB_SHA"/);
  assert.match(publish, /dist\/attested-package/);
  assert.match(publish, /buildArtifact: false/);
  assert.match(publish, /sudo ln -sf "\$NODE_EXECUTABLE" \/usr\/bin\/node/);
  assert.ok(publish.indexOf("Verify source checkout is clean before artifact download") < publish.indexOf("actions/download-artifact@v4"));
  assert.match(publish, /TARBALL_PATH="\$GITHUB_WORKSPACE\/\$TARBALL"/);
  assert.match(publish, /TARBALL_PATH="\$GITHUB_WORKSPACE\/verified-tarball\/\$PACKAGE_NAME"/);
  assert.match(publish, /tarball_sha256/);
  assert.match(publish, /E404\|404 Not Found/);
  assert.match(tag, /verify-release-evidence\.mjs/);
  assert.match(publish, /verify-release-evidence\.mjs/);
  assert.match(publish, /Poll registry for exact published version/);
  assert.match(publish, /sleep 10/);
});

test("attestation binds the staged manifest with a canonical digest and no raw self-hash", () => {
  const document = {
    schema_version: 2,
    package: { name: "@pennixrv/fast-context-skill", version: "0.1.1" },
    source: { commit: "a".repeat(40) },
    artifacts: {
      provenance_sha256: "b".repeat(64),
      package_manifest_sha256: "c".repeat(64),
      consumer_manifest_sha256: "d".repeat(64),
      tarball_filename: "pennixrv-fast-context-skill-0.1.1.tgz",
      tarball_sha256: "e".repeat(64),
    },
    canonical_attestation_sha256: "",
  };
  document.canonical_attestation_sha256 = canonicalAttestationSha256(document);
  assert.equal(validateAttestation(document), document);
  assert.throws(() => validateAttestation({ ...document, extra: true }));
  assert.throws(() => validateAttestation({ ...document, canonical_attestation_sha256: "e".repeat(64) }));
});

test("schema 1 attestations remain valid for the immutable source-packed release", () => {
  const document = {
    schema_version: 1,
    package: { name: "@pennixrv/fast-context-skill", version: "0.1.0" },
    source: { commit: "a".repeat(40) },
    artifacts: {
      provenance_sha256: "b".repeat(64),
      package_manifest_sha256: "c".repeat(64),
      tarball_filename: "pennixrv-fast-context-skill-0.1.0.tgz",
      tarball_sha256: "d".repeat(64),
    },
    canonical_attestation_sha256: "",
  };
  document.canonical_attestation_sha256 = canonicalAttestationSha256(document);
  assert.equal(validateAttestation(document), document);
});

test("tag metadata is fixed-order and rejects duplicates or extra lines", () => {
  const metadata = {
    tag: "v0.1.1",
    package: "@pennixrv/fast-context-skill@0.1.1",
    source_commit: "a".repeat(40),
    evidence_commit: "b".repeat(40),
    parent_commit: "a".repeat(40),
    provenance_sha256: "c".repeat(64),
    package_manifest_sha256: "d".repeat(64),
    tarball_filename: "pennixrv-fast-context-skill-0.1.1.tgz",
    tarball_sha256: "e".repeat(64),
    canonical_attestation_sha256: "f".repeat(64),
    raw_attestation_sha256: "0".repeat(64),
  };
  const message = formatTagMetadata(metadata);
  assert.deepEqual(parseTagMetadata(message), { "fast-context-release": "1", ...metadata });
  assert.throws(() => parseTagMetadata(`${message}\nextra=x`));
  assert.throws(() => parseTagMetadata(message.replace("tag=v0.1.1", "tag=v0.1.1\ntag=v0.1.1")));
});

test("publisher argument parser requires an exact tag and tarball pair", () => {
  assert.deepEqual(parseArguments(["--tag", "v0.1.1", "--tarball", "dist/releases/v0.1.1/pennixrv-fast-context-skill-0.1.1.tgz"]), {
    tag: "v0.1.1",
    tarballPath: resolve("dist/releases/v0.1.1/pennixrv-fast-context-skill-0.1.1.tgz"),
  });
  assert.throws(() => parseArguments(["--tag", "v0.1.1"]));
  assert.throws(() => parseArguments(["--tag", "v0.1.1", "--tarball", "a", "--tarball", "b"]));
});

test("release paths and tarball names derive from the exact package version", () => {
  assert.equal(attestationPathForTag("v0.1.1"), "docs/releases/attestations/v0.1.1.json");
  assert.equal(tarballFilename("@pennixrv/fast-context-skill", "0.1.1"), "pennixrv-fast-context-skill-0.1.1.tgz");
  assert.equal(tarballFilename("@example/other-package", "2.3.4"), "example-other-package-2.3.4.tgz");
  assert.throws(() => attestationPathForTag("main"));
});
