import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { verifyTag } from "../scripts/release/verify-tag.mjs";
import {
  canonicalAttestationSha256,
  formatTagMetadata,
  parseTagMetadata,
  tarballFilename,
  validateAttestation,
} from "../scripts/release/attestation.mjs";
import { parseArguments } from "../scripts/release/publish-release.mjs";
import { attestationPathForTag } from "../scripts/release/verify-release-evidence.mjs";

test("tag verifier requires an annotated, exact, clean version tag", () => {
  const calls = [];
  const values = new Map([
    ["cat-file -t v0.1.1", "tag"],
    ["rev-parse v0.1.1^{}", "abc123"],
    ["rev-parse HEAD", "abc123"],
    ["status --porcelain", ""],
  ]);
  const gitRunner = (args) => {
    calls.push(args.join(" "));
    return values.get(args.join(" ")) || "";
  };
  assert.equal(verifyTag({ tag: "v0.1.1", gitRunner }), true);
  assert.ok(calls.includes("cat-file -t v0.1.1"));
  assert.throws(() => verifyTag({ tag: "v0.1.2", gitRunner }));
  assert.throws(() => verifyTag({ tag: "0.1.1", gitRunner }));
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
  assert.match(ci, /npm pack --dry-run --json --ignore-scripts/);
  assert.match(tag, /npm pack --dry-run --json --ignore-scripts/);
  assert.match(ci, /build-package\.mjs --output/);
  assert.match(publish, /build-package\.mjs --output/);
  assert.match(ci, /npm install --global npm@12\.0\.1/);
  assert.match(tag, /npm install --global npm@12\.0\.1/);
  assert.match(publish, /npm install --global npm@12\.0\.1/);
  assert.match(publish, /verify-tag\.mjs "\$\{\{ inputs\.tag \}\}"/);
  assert.match(publish, /verify-release-evidence\.mjs "\$\{\{ inputs\.tag \}\}"/);
  assert.match(publish, /GITHUB_REF_NAME: ""/);
  assert.match(readFileSync("scripts/release/verify-tag.mjs", "utf8"), /process\.argv\[2\] \|\| process\.env\.GITHUB_REF_NAME/);
  assert.match(readFileSync("scripts/release/verify-release-evidence.mjs", "utf8"), /process\.argv\[2\] \|\| process\.env\.GITHUB_REF_NAME/);
  assert.match(publish, /actions\/upload-artifact@v4/);
  assert.match(publish, /actions\/download-artifact@v4/);
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
