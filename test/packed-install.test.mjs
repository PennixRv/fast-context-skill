import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
    const help = execFileSync("node", [join(packageRoot, "scripts", "fast-context-search.mjs"), "--help"], {
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(help, /fast-context-search --project/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
