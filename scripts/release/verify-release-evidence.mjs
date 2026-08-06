#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  canonicalAttestationSha256,
  parseTagMetadata,
  sha256Bytes,
  validateAttestation,
  validateTagMetadata,
} from "./attestation.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const ATTESTATION_PATH = "docs/releases/attestations/v0.1.0.json";

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: options.encoding || "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBytes(args, cwd = PROJECT_ROOT) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function buildTarball(commit, projectRoot = PROJECT_ROOT) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-release-"));
  try {
    const archive = gitBytes(["archive", "--format=tar", commit], projectRoot);
    execFileSync("tar", ["-xf", "-", "-C", temporaryDirectory], { input: archive, stdio: ["pipe", "ignore", "pipe"] });
    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory],
      { cwd: temporaryDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const report = Array.isArray(JSON.parse(output)) ? JSON.parse(output)[0] : Object.values(JSON.parse(output))[0];
    const tarballPath = join(temporaryDirectory, report.filename);
    const tarball = readFileSync(tarballPath);
    return { filename: report.filename, sha256: sha256Bytes(tarball) };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyReleaseEvidence({
  tag,
  projectRoot = PROJECT_ROOT,
  gitRunner = null,
  readObjectBytes = null,
  buildArtifact = true,
} = {}) {
  const runGit = gitRunner || ((args) => git(args, { cwd: projectRoot }));
  const readGitObject = readObjectBytes || ((revision, path) => gitBytes(["show", `${revision}:${path}`], projectRoot));
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("tag must be v<semver>");
  if (runGit(["cat-file", "-t", tag]) !== "tag") throw new Error("tag must be annotated");
  const evidenceCommit = runGit(["rev-parse", `${tag}^{}`]);
  const parentCommit = runGit(["rev-parse", `${evidenceCommit}^`]);
  const diff = runGit(["diff-tree", "--no-commit-id", "--name-status", "-r", parentCommit, evidenceCommit]);
  if (diff !== `A\t${ATTESTATION_PATH}`) throw new Error("evidence commit changes an unexpected path");
  const rawAttestation = Buffer.from(readGitObject(evidenceCommit, ATTESTATION_PATH));
  const attestation = validateAttestation(JSON.parse(rawAttestation.toString("utf8")));
  const metadata = validateTagMetadata(parseTagMetadata(runGit(["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"])));
  const packageJson = JSON.parse(Buffer.from(readGitObject(parentCommit, "package.json")).toString("utf8"));
  const packageCoordinate = `${packageJson.name}@${packageJson.version}`;
  if (metadata.tag !== tag || metadata.package !== packageCoordinate) throw new Error("tag package metadata mismatch");
  if (metadata.source_commit !== attestation.source.commit || metadata.source_commit !== parentCommit) {
    throw new Error("source commit metadata mismatch");
  }
  if (metadata.evidence_commit !== evidenceCommit || metadata.parent_commit !== parentCommit) {
    throw new Error("evidence ancestry metadata mismatch");
  }
  if (attestation.package.name !== packageJson.name || attestation.package.version !== packageJson.version) {
    throw new Error("attestation package mismatch");
  }
  const provenanceDigest = sha256Bytes(readGitObject(parentCommit, "docs/security/source-provenance.json"));
  const manifestDigest = sha256Bytes(readGitObject(parentCommit, "package.json"));
  if (metadata.provenance_sha256 !== provenanceDigest || attestation.artifacts.provenance_sha256 !== provenanceDigest) {
    throw new Error("provenance digest mismatch");
  }
  if (metadata.package_manifest_sha256 !== manifestDigest || attestation.artifacts.package_manifest_sha256 !== manifestDigest) {
    throw new Error("package manifest digest mismatch");
  }
  const canonicalDigest = canonicalAttestationSha256(attestation);
  if (metadata.canonical_attestation_sha256 !== canonicalDigest) throw new Error("canonical attestation metadata mismatch");
  if (sha256Bytes(rawAttestation) !== metadata.raw_attestation_sha256) throw new Error("raw attestation digest mismatch");
  if (metadata.tarball_filename !== attestation.artifacts.tarball_filename || metadata.tarball_sha256 !== attestation.artifacts.tarball_sha256) {
    throw new Error("tarball metadata mismatch");
  }
  if (buildArtifact) {
    const artifact = buildTarball(parentCommit, projectRoot);
    if (artifact.filename !== metadata.tarball_filename || artifact.sha256 !== metadata.tarball_sha256) {
      throw new Error("rebuilt tarball digest mismatch");
    }
  }
  return { tag, sourceCommit: parentCommit, evidenceCommit, package: packageCoordinate, tarball: metadata.tarball_filename };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    verifyReleaseEvidence({ tag: process.env.GITHUB_REF_NAME || process.argv[2] });
    process.stdout.write("release evidence ok\n");
  } catch {
    process.stderr.write("release evidence verification failed\n");
    process.exitCode = 1;
  }
}

export { ATTESTATION_PATH, buildTarball };
