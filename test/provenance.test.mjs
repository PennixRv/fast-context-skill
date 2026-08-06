import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verify } from "../scripts/release/verify-provenance.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeFixture(records) {
  const root = mkdtempSync(join(tmpdir(), "fast-context-provenance-"));
  mkdirSync(join(root, "docs", "security"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  const packageSource = `${JSON.stringify({ files: ["scripts/runtime.mjs"] })}\n`;
  const runtimeSource = "export const runtime = true;\n";
  writeFileSync(join(root, "package.json"), packageSource);
  writeFileSync(join(root, "scripts", "runtime.mjs"), runtimeSource);
  const expected = ["package.json", "scripts/runtime.mjs"];
  const defaultRecords = expected.map((path) => ({
    path,
    classification: "fork_owned",
    owner: "test",
    change_summary: "fixture",
    shipped_sha256: digest(path === "package.json" ? packageSource : runtimeSource),
  }));
  const provenancePath = join(root, "docs", "security", "source-provenance.json");
  writeFileSync(provenancePath, `${JSON.stringify({ expected_runtime_paths: expected, files: records || defaultRecords })}\n`);
  return { root, provenancePath, defaultRecords };
}

test("provenance verifier accepts the exact allowlist and rejects duplicate records", () => {
  const fixture = writeFixture();
  try {
    assert.deepEqual(verify({ projectRoot: fixture.root, provenancePath: fixture.provenancePath }), { files: 2 });
    const duplicate = [...fixture.defaultRecords, fixture.defaultRecords[0]];
    writeFileSync(fixture.provenancePath, `${JSON.stringify({
      expected_runtime_paths: ["package.json", "scripts/runtime.mjs"],
      files: duplicate,
    })}\n`);
    assert.throws(
      () => verify({ projectRoot: fixture.root, provenancePath: fixture.provenancePath }),
      /duplicate path/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
