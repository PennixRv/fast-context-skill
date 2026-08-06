#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildConsumerPackage } from "./build-package.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

export function artifactPathForTag(tag, projectRoot = PROJECT_ROOT) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("tag must be v<semver>");
  return join(projectRoot, "docs", "releases", "artifacts", `${tag}.tgz`);
}

export function prepareReleaseArtifact({ projectRoot = PROJECT_ROOT } = {}) {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const tag = `v${packageJson.version}`;
  const destinationPath = artifactPathForTag(tag, projectRoot);
  if (existsSync(destinationPath)) throw new Error("attested release tarball already exists");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-artifact-"));
  try {
    const artifact = buildConsumerPackage({
      sourceRoot: projectRoot,
      outputDirectory: temporaryDirectory,
    });
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(artifact.tarballPath, destinationPath);
    return {
      tag,
      destinationPath,
      filename: artifact.filename,
      sha256: artifact.sha256,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = prepareReleaseArtifact();
    process.stdout.write(`release artifact prepared: ${result.tag} ${result.filename}\n`);
  } catch {
    process.stderr.write("release artifact preparation failed\n");
    process.exitCode = 1;
  }
}
