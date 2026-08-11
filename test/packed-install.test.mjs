import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildConsumerPackage } from "../scripts/release/build-package.mjs";

test("staged tarball installs offline and the runtime CLI does not need maintainer files", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-pack-"));
  try {
    const artifact = buildConsumerPackage({ outputDirectory: temporaryDirectory });
    const installDirectory = join(temporaryDirectory, "install");
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, artifact.tarballPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packageRoot = join(installDirectory, "node_modules", "@pennixrv", "fast-context-skill");
    const help = execFileSync(process.execPath, [join(packageRoot, "scripts", "fast-context-search.mjs"), "--help"], {
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(help, /fast-context-search --project/);
    const disabled = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "fast-context-search.mjs"),
      "--project", installDirectory,
      "--query", "query",
      "--no-external",
    ], {
      encoding: "utf8",
      env: { HOME: temporaryDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(disabled.status, 1);
    assert.equal(disabled.stdout, "");
    assert.equal(disabled.stderr, "FC_EXTERNAL_DISABLED: external search is disabled by the caller\n");
    const missingCredential = spawnSync(process.execPath, [
      join(packageRoot, "scripts", "fast-context-search.mjs"),
      "--project", installDirectory,
      "--query", "query",
    ], {
      encoding: "utf8",
      env: { HOME: temporaryDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(missingCredential.status, 1);
    assert.equal(missingCredential.stdout, "");
    assert.equal(missingCredential.stderr, "FC_KEY_MISSING: WINDSURF_API_KEY is required\n");
    assert.equal(existsSync(join(packageRoot, "scripts", "lib", "credentials.mjs")), true);
    assert.equal(existsSync(join(packageRoot, "scripts", "lib", "devin-credential-helper.mjs")), true);
    assert.equal(
      readFileSync(join(packageRoot, "scripts", "fast-context-search.mjs"), "utf8"),
      readFileSync("scripts/fast-context-search.mjs", "utf8"),
    );
    assert.match(
      readFileSync(join(packageRoot, "scripts", "fast-context-search.mjs"), "utf8"),
      /await runCli\(/,
    );
    const installedCore = readFileSync(join(packageRoot, "scripts", "lib", "core.mjs"), "utf8");
    assert.equal(installedCore, readFileSync("scripts/lib/core.mjs", "utf8"));
    assert.match(installedCore, /remote_candidate_projection_rejected/);
    assert.match(installedCore, /recovered_candidates/);
    assert.match(installedCore, /MAX_SESSION_REFRESHES = 2/);
    assert.match(installedCore, /rejection_reasons/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
