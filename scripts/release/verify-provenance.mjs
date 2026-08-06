#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) &&
    !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === "..") &&
    !value.startsWith(".");
}

function expectedPaths(projectRoot = PROJECT_ROOT) {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const paths = ["package.json", ...(packageJson.files || [])];
  if (paths.some((path) => !safeRelativePath(path) || path.endsWith("/"))) {
    throw new Error("package files allowlist contains an unsafe or directory path");
  }
  return [...new Set(paths)].sort();
}

function verify({
  upstreamRoot = null,
  projectRoot = PROJECT_ROOT,
  provenancePath = join(projectRoot, "docs/security/source-provenance.json"),
} = {}) {
  const document = JSON.parse(readFileSync(provenancePath, "utf8"));
  const expected = expectedPaths(projectRoot);
  const declared = document.expected_runtime_paths;
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new Error("provenance runtime path universe does not match package allowlist");
  }
  if (!Array.isArray(document.files)) throw new Error("provenance files must be an array");

  const seen = new Set();
  for (const record of document.files) {
    const path = record?.path;
    if (!safeRelativePath(path) || !expected.includes(path) || seen.has(path)) {
      throw new Error("provenance contains an unsafe, extra, or duplicate path");
    }
    seen.add(path);
    const shippedPath = join(projectRoot, path);
    if (!statSync(shippedPath).isFile()) throw new Error(`missing shipped path: ${path}`);
    const shippedDigest = sha256(shippedPath);
    if (record.shipped_sha256 !== shippedDigest) throw new Error(`shipped digest mismatch: ${path}`);

    if (record.classification === "fork_owned") {
      if (!record.owner || !record.change_summary) throw new Error(`incomplete fork record: ${path}`);
      continue;
    }
    if (record.classification !== "vendored") throw new Error(`invalid classification: ${path}`);
    for (const field of ["source_repository", "source_commit", "source_path", "upstream_sha256", "license_reference", "change_summary"]) {
      if (!record[field]) throw new Error(`incomplete vendored record: ${path}`);
    }
    if (upstreamRoot) {
      if (!/^[0-9a-f]{7,64}$/i.test(record.source_commit) || !safeRelativePath(record.source_path)) {
        throw new Error(`unsafe upstream reference: ${path}`);
      }
      let upstreamBytes;
      try {
        upstreamBytes = execFileSync(
          "git",
          ["-C", resolve(upstreamRoot), "show", `${record.source_commit}:${record.source_path}`],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch {
        throw new Error(`upstream Git object unavailable: ${path}`);
      }
      const upstreamDigest = createHash("sha256").update(upstreamBytes).digest("hex");
      if (upstreamDigest !== record.upstream_sha256) throw new Error(`upstream digest mismatch: ${path}`);
    }
  }
  if (seen.size !== expected.length) throw new Error("provenance is missing an allowlisted path");
  return { files: expected.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const upstreamIndex = process.argv.indexOf("--upstream-root");
    const upstreamRoot = upstreamIndex >= 0 ? process.argv[upstreamIndex + 1] : null;
    const result = verify({ upstreamRoot });
    process.stdout.write(`provenance ok: ${result.files} files\n`);
  } catch (error) {
    process.stderr.write("provenance verification failed\n");
    process.exitCode = 1;
  }
}

export { expectedPaths, verify };
