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
import { buildConsumerPackage } from "./build-package.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

function attestationPathForTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("tag must be v<semver>");
  return `docs/releases/attestations/${tag}.json`;
}

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

function packageArchivePaths(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) throw new Error("package files allowlist is missing");
  const paths = [...new Set(["package.json", ...manifest.files])].sort();
  if (paths.some((path) => typeof path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) || path.includes("..") || path.endsWith("/"))) {
    throw new Error("package files allowlist is unsafe");
  }
  return paths;
}

function buildTarball(commit, projectRoot = PROJECT_ROOT, { stagedConsumerPackage = true } = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-release-"));
  try {
    const manifest = JSON.parse(gitBytes(["show", `${commit}:package.json`], projectRoot).toString("utf8"));
    const archive = gitBytes(["archive", "--format=tar", commit, "--", ...packageArchivePaths(manifest)], projectRoot);
    execFileSync("tar", ["-xf", "-", "-C", temporaryDirectory], { input: archive, stdio: ["pipe", "ignore", "pipe"] });
    if (stagedConsumerPackage) {
      const artifact = buildConsumerPackage({ sourceRoot: temporaryDirectory });
      return {
        filename: artifact.filename,
        sha256: artifact.sha256,
        consumerManifestSha256: artifact.manifestSha256,
      };
    }
    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory],
      { cwd: temporaryDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const report = Array.isArray(JSON.parse(output)) ? JSON.parse(output)[0] : Object.values(JSON.parse(output))[0];
    const tarballPath = join(temporaryDirectory, report.filename);
    return { filename: report.filename, sha256: sha256Bytes(readFileSync(tarballPath)) };
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
  const attestationPath = attestationPathForTag(tag);
  if (runGit(["cat-file", "-t", tag]) !== "tag") throw new Error("tag must be annotated");
  const evidenceCommit = runGit(["rev-parse", `${tag}^{}`]);
  const parentCommit = runGit(["rev-parse", `${evidenceCommit}^`]);
  const diff = runGit(["diff-tree", "--no-commit-id", "--name-status", "-r", parentCommit, evidenceCommit]);
  if (diff !== `A\t${attestationPath}`) throw new Error("evidence commit changes an unexpected path");
  const rawAttestation = Buffer.from(readGitObject(evidenceCommit, attestationPath));
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
    const artifact = buildTarball(parentCommit, projectRoot, {
      stagedConsumerPackage: attestation.schema_version === 2,
    });
    if (artifact.filename !== metadata.tarball_filename || artifact.sha256 !== metadata.tarball_sha256) {
      throw new Error("rebuilt tarball digest mismatch");
    }
    if (attestation.schema_version === 2 && artifact.consumerManifestSha256 !== attestation.artifacts.consumer_manifest_sha256) {
      throw new Error("consumer manifest digest mismatch");
    }
  }
  return { tag, sourceCommit: parentCommit, evidenceCommit, package: packageCoordinate, tarball: metadata.tarball_filename };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    verifyReleaseEvidence({ tag: process.argv[2] || process.env.GITHUB_REF_NAME });
    process.stdout.write("release evidence ok\n");
  } catch {
    process.stderr.write("release evidence verification failed\n");
    process.exitCode = 1;
  }
}

export { attestationPathForTag, buildTarball, packageArchivePaths };
