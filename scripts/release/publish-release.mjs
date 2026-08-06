#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "./attestation.mjs";
import { verifyReleaseEvidence } from "./verify-release-evidence.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

function git(args) {
  return execFileSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runNpm(args) {
  return spawnSync("npm", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForPublishedVersion(packageCoordinate, version, { attempts = 6, delaySeconds = 10 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = runNpm([
      "view",
      `${packageCoordinate}@${version}`,
      "version",
      "--json",
      "--prefer-online",
      "--registry=https://registry.npmjs.org",
    ]);
    let observedVersion = null;
    try {
      observedVersion = result.status === 0 ? JSON.parse(result.stdout) : null;
    } catch {
      observedVersion = null;
    }
    if (observedVersion === version) return true;
    if (attempt + 1 < attempts) execFileSync("sleep", [String(delaySeconds)], { stdio: "ignore" });
  }
  throw new Error("published version did not become visible");
}

function requireNpmAuth() {
  const result = runNpm(["whoami", "--registry=https://registry.npmjs.org"]);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("npm authentication unavailable");
}

function requireExplicit404(packageCoordinate) {
  const result = runNpm(["view", packageCoordinate, "version", "--json", "--registry=https://registry.npmjs.org"]);
  if (result.status === 0) throw new Error("target npm version already exists");
  if (!/E404|404 Not Found/.test(result.stderr || "")) {
    throw new Error("npm version lookup did not return an explicit 404");
  }
}

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!/^--(?:tag|tarball)$/.test(flag) || !value || Object.hasOwn(values, flag)) {
      throw new Error("usage: publish-release.mjs --tag v<semver> --tarball <path>");
    }
    values[flag] = value;
  }
  if (!values["--tag"] || !values["--tarball"]) throw new Error("usage: publish-release.mjs --tag v<semver> --tarball <path>");
  return { tag: values["--tag"], tarballPath: resolve(PROJECT_ROOT, values["--tarball"]) };
}

export function publishRelease({ tag, tarballPath }) {
  if (git(["status", "--porcelain"])) throw new Error("worktree is not clean");
  const evidence = verifyReleaseEvidence({ tag });
  const tarballDigest = sha256Bytes(readFileSync(tarballPath));
  const tagDigest = git(["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"])
    .split("\n")
    .find((line) => line.startsWith("tarball_sha256="))
    ?.slice("tarball_sha256=".length);
  if (tarballDigest !== tagDigest) throw new Error("supplied tarball digest mismatch");
  requireNpmAuth();
  requireExplicit404(evidence.package);
  if (git(["status", "--porcelain"])) throw new Error("worktree changed before publish");
  const result = runNpm(["publish", tarballPath, "--provenance", "--access", "public", "--ignore-scripts"]);
  if (result.status !== 0) throw new Error("npm publish failed");
  const separator = evidence.package.lastIndexOf("@");
  waitForPublishedVersion(evidence.package.slice(0, separator), evidence.package.slice(separator + 1));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const result = publishRelease(argumentsValue);
    process.stdout.write(`npm publish ok: ${result.package}\n`);
  } catch {
    process.stderr.write("npm publication failed\n");
    process.exitCode = 1;
  }
}

export { parseArguments, requireExplicit404, requireNpmAuth, waitForPublishedVersion };
