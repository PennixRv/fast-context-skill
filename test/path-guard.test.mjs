import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PathGuard } from "../scripts/lib/path-guard.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fast-context-guard-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "logs"));
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "src", "a.mjs"), "first\nsecond\nthird\n");
  writeFileSync(join(root, "src", "nested", "b.mjs"), "nested\n");
  writeFileSync(join(root, ".git", "config"), "metadata\n");
  writeFileSync(join(root, ".env.local"), "secret\n");
  writeFileSync(join(root, "logs", "run.log"), "log\n");
  writeFileSync(join(root, "secrets", "config"), "secret\n");
  const outside = mkdtempSync(join(tmpdir(), "fast-context-outside-"));
  writeFileSync(join(outside, "outside.mjs"), "outside\n");
  symlinkSync(join(outside, "outside.mjs"), join(root, "escape.mjs"));
  return { root, outside };
}

test("PathGuard confines, denies, and projects local paths", () => {
  const { root, outside } = fixture();
  try {
    const guard = new PathGuard(root, ["src/nested/*"]);
    assert.equal(guard.root, root);
    assert.equal(guard.resolveExisting("/codebase/src/a.mjs", { kind: "file" }).relativePath, "src/a.mjs");
    assert.throws(() => guard.resolveExisting("/tmp/outside"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.resolveExisting("/codebase/../outside"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.resolveExisting("src/../a.mjs"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.resolveExisting("src\\..\\a.mjs"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.resolveExisting("C:\\outside"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.resolveExisting("/codebase/escape.mjs"), { code: "FC_PATH_DENIED" });
    assert.throws(() => guard.resolveExisting("/codebase/.git/config", { kind: "file" }), { code: "FC_PATH_DENIED" });
    assert.throws(() => guard.resolveExisting("/codebase/.env.local", { kind: "file" }), { code: "FC_PATH_DENIED" });
    assert.throws(() => guard.resolveExisting("/codebase/secrets/config", { kind: "file" }), { code: "FC_PATH_DENIED" });
    assert.throws(() => guard.resolveExisting("/codebase/missing.mjs", { kind: "file" }), { code: "FC_PATH_UNAVAILABLE" });
    assert.throws(() => guard.resolveExisting("/codebase/src", { kind: "file" }), { code: "FC_PATH_UNAVAILABLE" });
    assert.throws(() => guard.resolveExisting("/codebase/src/nested/b.mjs", { kind: "file" }), { code: "FC_PATH_DENIED" });

    const listing = guard.listDirectory("/codebase").map((entry) => entry.name);
    assert.deepEqual(listing, ["src"]);
    assert.match(guard.readText("/codebase/src/a.mjs", 2, 2), /^2:second$/);
    assert.doesNotMatch(guard.tree("/codebase", 4), /\.git|escape|\.env/);
    assert.match(guard.glob("/codebase", "src/*.mjs", "file"), /\/codebase\/src\/a\.mjs/);
    assert.equal(guard.glob("/codebase", "src/nested/*.mjs", "file"), "(no matches)");
    assert.match(guard.glob("/codebase", "**/*.mjs", "file"), /a\.mjs/);
    assert.throws(() => guard.glob("/codebase", "src//*.mjs"), { code: "FC_PATH_INVALID" });
    assert.throws(() => guard.glob("/codebase", "src/*.mjs", "invalid"), { code: "FC_PATH_INVALID" });
    assert.ok(outside.startsWith("/tmp/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
