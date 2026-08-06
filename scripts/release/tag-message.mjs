#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTagMetadata, sha256Bytes, validateAttestation } from "./attestation.mjs";
import { attestationPathForTag } from "./verify-release-evidence.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
function git(args) {
  return execFileSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function createTagMessage({ tag, evidenceCommit }) {
  const attestationPath = attestationPathForTag(tag);
  const parentCommit = git(["rev-parse", `${evidenceCommit}^`]);
  const attestationBytes = execFileSync("git", ["show", `${evidenceCommit}:${attestationPath}`], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const attestation = validateAttestation(JSON.parse(attestationBytes.toString("utf8")));
  if (tag !== `v${attestation.package.version}` || attestation.source.commit !== parentCommit) {
    throw new Error("tag message source or version mismatch");
  }
  return formatTagMetadata({
    tag,
    package: `${attestation.package.name}@${attestation.package.version}`,
    source_commit: parentCommit,
    evidence_commit: evidenceCommit,
    parent_commit: parentCommit,
    provenance_sha256: attestation.artifacts.provenance_sha256,
    package_manifest_sha256: attestation.artifacts.package_manifest_sha256,
    tarball_filename: attestation.artifacts.tarball_filename,
    tarball_sha256: attestation.artifacts.tarball_sha256,
    canonical_attestation_sha256: attestation.canonical_attestation_sha256,
    raw_attestation_sha256: sha256Bytes(attestationBytes),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const tag = process.argv[2];
    const evidenceCommit = process.argv[3] || git(["rev-parse", "HEAD"]);
    process.stdout.write(`${createTagMessage({ tag, evidenceCommit })}\n`);
  } catch {
    process.stderr.write("tag message generation failed\n");
    process.exitCode = 1;
  }
}
