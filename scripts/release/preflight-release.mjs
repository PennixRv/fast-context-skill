#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalAttestationSha256,
  sha256Bytes,
  validateAttestation,
} from "./attestation.mjs";
import { ATTESTATION_PATH, buildTarball } from "./verify-release-evidence.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

function git(args) {
  return execFileSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runChecked(command, args) {
  execFileSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function requireExplicit404(packageCoordinate) {
  const result = spawnSync("npm", ["view", packageCoordinate, "version", "--json", "--registry=https://registry.npmjs.org"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) throw new Error("target npm version already exists");
  if (!/E404|404 Not Found/.test(result.stderr || "")) {
    throw new Error("npm version lookup did not return an explicit 404");
  }
}

function requireNpmAuth() {
  const result = spawnSync("npm", ["whoami", "--registry=https://registry.npmjs.org"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("npm authentication unavailable");
}

function createAttestation({ sourceCommit, packageJson, artifact }) {
  const provenance = readFileSync(join(PROJECT_ROOT, "docs/security/source-provenance.json"));
  const manifest = readFileSync(join(PROJECT_ROOT, "package.json"));
  const document = {
    schema_version: 1,
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    source: {
      commit: sourceCommit,
    },
    artifacts: {
      provenance_sha256: sha256Bytes(provenance),
      package_manifest_sha256: sha256Bytes(manifest),
      tarball_filename: artifact.filename,
      tarball_sha256: artifact.sha256,
    },
    canonical_attestation_sha256: "",
  };
  document.canonical_attestation_sha256 = canonicalAttestationSha256(document);
  return validateAttestation(document);
}

export function preflightRelease({ projectRoot = PROJECT_ROOT } = {}) {
  if (projectRoot !== PROJECT_ROOT) throw new Error("custom project root is not supported");
  if (git(["status", "--porcelain"])) throw new Error("worktree must be clean before release preflight");
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const tag = `v${packageJson.version}`;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("release version must be a stable semver");
  runChecked("npm", ["test"]);
  runChecked("npm", ["run", "verify:provenance"]);
  runChecked("npm", ["run", "pack:check"]);
  const artifact = buildTarball(sourceCommit, PROJECT_ROOT);
  requireNpmAuth();
  requireExplicit404(`${packageJson.name}@${packageJson.version}`);
  const attestation = createAttestation({ sourceCommit, packageJson, artifact });
  const artifactDirectory = join(PROJECT_ROOT, "dist", "releases", tag);
  const attestationFile = join(PROJECT_ROOT, ATTESTATION_PATH);
  mkdirSync(artifactDirectory, { recursive: true });
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactDirectory],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "ignore"] },
  );
  const tarballPath = join(artifactDirectory, artifact.filename);
  if (sha256Bytes(readFileSync(tarballPath)) !== artifact.sha256) throw new Error("local tarball changed during preflight");
  mkdirSync(dirname(attestationFile), { recursive: true });
  writeFileSync(attestationFile, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return {
    sourceCommit,
    tag,
    attestationPath: relative(PROJECT_ROOT, attestationFile),
    tarballPath: relative(PROJECT_ROOT, tarballPath),
    tarballSha256: artifact.sha256,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = preflightRelease();
    process.stdout.write(`release preflight ok: ${result.tag} ${basename(result.tarballPath)}\n`);
  } catch {
    process.stderr.write("release preflight failed\n");
    process.exitCode = 1;
  }
}

export { createAttestation, requireExplicit404, requireNpmAuth };
