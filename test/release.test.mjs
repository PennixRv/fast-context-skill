import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyTag } from "../scripts/release/verify-tag.mjs";

test("tag verifier requires an annotated, exact, clean version tag", () => {
  const calls = [];
  const values = new Map([
    ["cat-file -t v0.1.0", "tag"],
    ["rev-parse v0.1.0^{}", "abc123"],
    ["rev-parse HEAD", "abc123"],
    ["status --porcelain", ""],
  ]);
  const gitRunner = (args) => {
    calls.push(args.join(" "));
    return values.get(args.join(" ")) || "";
  };
  assert.equal(verifyTag({ tag: "v0.1.0", gitRunner }), true);
  assert.ok(calls.includes("cat-file -t v0.1.0"));
  assert.throws(() => verifyTag({ tag: "v0.1.1", gitRunner }));
  assert.throws(() => verifyTag({ tag: "0.1.0", gitRunner }));
});

test("workflow permissions isolate validation, release, and npm publication", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const tag = readFileSync(".github/workflows/release-tag.yml", "utf8");
  const publish = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  assert.match(ci, /permissions:\n  contents: read/);
  assert.doesNotMatch(ci, /id-token:\s*write/);
  assert.match(tag, /permissions:\n  contents: read/);
  assert.match(tag, /permissions:\n      contents: write/);
  assert.match(publish, /permissions:\n  contents: read/);
  assert.match(publish, /contents: read\n      id-token: write/);
  assert.doesNotMatch(publish, /contents: write/);
  assert.doesNotMatch(publish, /schedule:/);
  assert.match(publish, /--ignore-scripts/);
  assert.match(publish, /actions\/upload-artifact@v4/);
  assert.match(publish, /actions\/download-artifact@v4/);
  assert.match(publish, /tarball_sha256/);
  assert.match(publish, /E404\|404 Not Found/);
});
