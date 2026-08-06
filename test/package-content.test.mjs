import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function packReport() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  if (Array.isArray(parsed)) return parsed[0];
  return Object.values(parsed)[0];
}

test("npm tarball contains exactly the individual allowlist", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const expected = [...new Set(["package.json", ...packageJson.files])].sort();
  const report = packReport();
  const actual = report.files.map(({ path }) => path).sort();
  assert.deepEqual(actual, expected);
  assert.ok(actual.every((path) => !path.startsWith("test/") && !path.startsWith(".trellis/") && !path.startsWith(".codex/")));
  assert.ok(actual.every((path) => !path.startsWith(".github/")));
});

export { packReport };
