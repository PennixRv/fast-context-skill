import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("exact packed tarball installs offline with lifecycle scripts disabled", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-pack-"));
  try {
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const report = Array.isArray(JSON.parse(output)) ? JSON.parse(output)[0] : Object.values(JSON.parse(output))[0];
    const tarball = join(temporaryDirectory, report.filename);
    const installDirectory = join(temporaryDirectory, "install");
    execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  assert.ok(true);
});
