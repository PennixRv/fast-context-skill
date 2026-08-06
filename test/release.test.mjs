import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { verifyTag } from "../scripts/release/verify-tag.mjs";
import {
  canonicalAttestationSha256,
  formatTagMetadata,
  parseTagMetadata,
  validateAttestation,
} from "../scripts/release/attestation.mjs";
import { parseArguments } from "../scripts/release/publish-release.mjs";

test("tag verifier requires an annotated, exact, clean version tag", () => {
  const calls = [];
  const values = new Map([
    ["cat-file -t v0.1.0", "tag"],
    ["rev-parse v0.1.0^{}", "abc123"],
    ["rev-parse HEAD", "abc123"],
    ["status --porcelain", ""],
  ]);
  const gitRunner = (args) => {
    calls.push(args.join(" "));
    return values.get(args.join(" ")) || "";
  };
  assert.equal(verifyTag({ tag: "v0.1.0", gitRunner }), true);
  assert.ok(calls.includes("cat-file -t v0.1.0"));
  assert.throws(() => verifyTag({ tag: "v0.1.1", gitRunner }));
  assert.throws(() => verifyTag({ tag: "0.1.0", gitRunner }));
});

test("workflow permissions isolate validation, release, and npm publication", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const tag = readFileSync(".github/workflows/release-tag.yml", "utf8");
  const publish = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  assert.match(ci, /permissions:\n  contents: read/);
  assert.doesNotMatch(ci, /id-token:\s*write/);
  assert.match(tag, /permissions:\n  contents: read/);
  assert.match(tag, /permissions:\n      contents: write/);
  assert.match(publish, /permissions:\n  contents: read/);
  assert.match(publish, /contents: read\n      id-token: write/);
  assert.doesNotMatch(publish, /contents: write/);
  assert.doesNotMatch(publish, /schedule:/);
  assert.match(publish, /--ignore-scripts/);
  assert.match(publish, /actions\/upload-artifact@v4/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /tarball_sha256/);
  assert.match(publish, /E404\|404 Not Found/);
  assert.match(tag, /verify-release-evidence\.mjs/);
  assert.match(publish, /verify-release-evidence\.mjs/);
  assert.match(publish, /Poll registry for exact published version/);
  assert.match(publish, /sleep 10/);
});

test("attestation uses a canonical digest without a raw self-hash", () => {
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
  assert.throws(() => validateAttestation({ ...document, extra: true }));
  assert.throws(() => validateAttestation({ ...document, canonical_attestation_sha256: "e".repeat(64) }));
});

test("tag metadata is fixed-order and rejects duplicates or extra lines", () => {
  const metadata = {
    tag: "v0.1.0",
    package: "@pennixrv/fast-context-skill@0.1.0",
    source_commit: "a".repeat(40),
    evidence_commit: "b".repeat(40),
    parent_commit: "a".repeat(40),
    provenance_sha256: "c".repeat(64),
    package_manifest_sha256: "d".repeat(64),
    tarball_filename: "pennixrv-fast-context-skill-0.1.0.tgz",
    tarball_sha256: "e".repeat(64),
    canonical_attestation_sha256: "f".repeat(64),
    raw_attestation_sha256: "0".repeat(64),
  };
  const message = formatTagMetadata(metadata);
  assert.deepEqual(parseTagMetadata(message), { "fast-context-release": "1", ...metadata });
  assert.throws(() => parseTagMetadata(`${message}\nextra=x`));
  assert.throws(() => parseTagMetadata(message.replace("tag=v0.1.0", "tag=v0.1.0\ntag=v0.1.0")));
});

test("publisher argument parser requires an exact tag and tarball pair", () => {
  assert.deepEqual(parseArguments(["--tag", "v0.1.0", "--tarball", "dist/releases/v0.1.0/pennixrv-fast-context-skill-0.1.0.tgz"]), {
    tag: "v0.1.0",
    tarballPath: resolve("dist/releases/v0.1.0/pennixrv-fast-context-skill-0.1.0.tgz"),
  });
  assert.throws(() => parseArguments(["--tag", "v0.1.0"]));
  assert.throws(() => parseArguments(["--tag", "v0.1.0", "--tarball", "a", "--tarball", "b"]));
});
