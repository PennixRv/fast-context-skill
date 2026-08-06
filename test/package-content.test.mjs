import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildConsumerPackage } from "../scripts/release/build-package.mjs";

function unpack(tarball, destination) {
  execFileSync("tar", ["-xzf", tarball, "-C", destination], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("staged npm tarball contains exactly the individual allowlist", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-package-content-"));
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const expected = [...new Set(["package.json", ...packageJson.files])].sort();
  try {
    const artifact = buildConsumerPackage({ outputDirectory: temporaryDirectory });
    assert.deepEqual(artifact.files, expected);
    assert.equal(artifact.manifest.version, packageJson.version);
    assert.equal(artifact.manifest.scripts, undefined);
    assert.equal(artifact.manifest.devDependencies, undefined);
    assert.equal(typeof packageJson.scripts.test, "string");
    assert.equal(typeof packageJson.scripts["release:publish"], "string");
    assert.ok(artifact.files.every((path) => !path.startsWith("test/") && !path.startsWith("scripts/release/")));
    assert.ok(artifact.files.every((path) => !path.startsWith(".trellis/") && !path.startsWith(".codex/") && !path.startsWith(".github/")));

    const unpackDirectory = join(temporaryDirectory, "unpacked");
    mkdirSync(unpackDirectory);
    unpack(artifact.tarballPath, unpackDirectory);
    const installedRoot = join(unpackDirectory, "package");
    const installedManifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedManifest.scripts, undefined);
    assert.equal(installedManifest.devDependencies, undefined);
    assert.ok(readFileSync(join(installedRoot, "README.md"), "utf8").includes("references/source-provenance.json"));
    const projection = JSON.parse(readFileSync(join(installedRoot, "references", "source-provenance.json"), "utf8"));
    assert.equal(projection.package, `@pennixrv/fast-context-skill@${packageJson.version}`);
    assert.equal(projection.privacy.contains_credentials, false);
    assert.equal(projection.privacy.contains_runtime_state, false);
    assert.equal(projection.privacy.contains_local_absolute_paths, false);
    const serializedProjection = JSON.stringify(projection);
    assert.doesNotMatch(serializedProjection, /\/home\/|\\\\|\.trellis\/\.runtime|npm_[A-Za-z0-9_-]+|WINDSURF_API_KEY=/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

export { unpack };
