#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsePackReport(output) {
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

function readManifest(sourceRoot) {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  if (!manifest.name || !manifest.version || !manifest.bin || !Array.isArray(manifest.files)) {
    throw new Error("source package manifest is incomplete");
  }
  const files = [...new Set(manifest.files)].sort();
  if (files.some((path) => !SAFE_PATH.test(path) || path.includes("..") || path.endsWith("/"))) {
    throw new Error("source package files allowlist is unsafe");
  }
  return { manifest, files };
}

function consumerManifest(manifest, files) {
  const result = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    type: manifest.type,
    bin: manifest.bin,
    files,
    repository: manifest.repository,
    bugs: manifest.bugs,
    homepage: manifest.homepage,
    keywords: manifest.keywords,
    engines: manifest.engines,
  };
  if (manifest.dependencies) result.dependencies = manifest.dependencies;
  return result;
}

export function buildConsumerPackage({
  sourceRoot = PROJECT_ROOT,
  outputDirectory = null,
  keepStaging = false,
} = {}) {
  const { manifest, files } = readManifest(sourceRoot);
  const parentDirectory = outputDirectory
    ? resolve(outputDirectory)
    : mkdtempSync(join(process.env.TMPDIR || "/tmp", "fast-context-package-"));
  const stagingDirectory = join(parentDirectory, "staging");
  mkdirSync(parentDirectory, { recursive: true });
  rmSync(stagingDirectory, { recursive: true, force: true });

  for (const path of files) {
    const sourcePath = join(sourceRoot, path);
    const targetPath = join(stagingDirectory, path);
    if (!statSync(sourcePath).isFile()) throw new Error(`missing allowlisted runtime file: ${path}`);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);
  }

  const packageJson = consumerManifest(manifest, files);
  const packageJsonText = `${JSON.stringify(packageJson, null, 2)}\n`;
  writeFileSync(join(stagingDirectory, "package.json"), packageJsonText, "utf8");
  const output = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", parentDirectory],
    { cwd: stagingDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const report = parsePackReport(output);
  const tarballPath = join(parentDirectory, report.filename);
  const result = {
    filename: report.filename,
    tarballPath,
    sha256: sha256(readFileSync(tarballPath)),
    files: report.files.map(({ path }) => path).sort(),
    manifest: packageJson,
    manifestSha256: sha256(Buffer.from(packageJsonText)),
    stagingDirectory,
  };
  if (!keepStaging && !outputDirectory) {
    rmSync(parentDirectory, { recursive: true, force: true });
    result.tarballPath = null;
    result.stagingDirectory = null;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const outputIndex = process.argv.indexOf("--output");
    const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
    if (outputIndex >= 0 && !outputDirectory) throw new Error("--output requires a directory");
    const result = buildConsumerPackage({ outputDirectory });
    process.stdout.write(`${JSON.stringify({
      filename: result.filename,
      tarball: result.tarballPath,
      sha256: result.sha256,
      files: result.files,
      manifest_sha256: result.manifestSha256,
    })}\n`);
  } catch {
    process.stderr.write("package staging failed\n");
    process.exitCode = 1;
  }
}

export { consumerManifest, readManifest };
