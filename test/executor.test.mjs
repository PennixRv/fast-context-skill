import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PathGuard } from "../scripts/lib/path-guard.mjs";
import { ToolExecutor } from "../scripts/lib/executor.mjs";

test("executor uses approved files, fixed rg argv, and minimal environment", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-exec-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "ok.mjs"), "needle\n");
  writeFileSync(join(root, ".env"), "needle-secret\n");
  try {
    const guard = new PathGuard(root);
    let call;
    const executor = new ToolExecutor(guard, {
      rgBinary: "/opt/rg",
      executeFileSync(binary, args, options) {
        call = { binary, args, options };
        const file = args.at(-1);
        return `${file}:1:needle\n`;
      },
    });
    const result = executor.rg("-n --hidden SENTINEL", "/codebase");
    assert.match(result, /\/codebase\/src\/ok\.mjs:1:needle/);
    assert.equal(call.binary, "/opt/rg");
    assert.deepEqual(call.args.slice(0, 12), [
      "--no-config", "--no-ignore", "--no-follow", "--no-heading", "--line-number",
      "--color", "never", "--max-count", "50", "--regexp", "-n --hidden SENTINEL", "--",
    ]);
    assert.deepEqual(call.options.env, { LANG: "C", LC_ALL: "C", RIPGREP_CONFIG_PATH: "" });
    assert.ok(call.args.every((arg) => !arg.includes(".env")));
    assert.equal(executor.tree("/codebase", 1).includes(".env"), false);
    assert.equal(executor.ls("/codebase", false, true).includes(".env"), false);
    assert.match(executor.glob("*.mjs", "/codebase/src", "file"), /ok\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor converts child failures to a closed error", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-exec-"));
  writeFileSync(join(root, "ok.txt"), "x\n");
  try {
    const executor = new ToolExecutor(new PathGuard(root), {
      rgBinary: "/opt/rg",
      executeFileSync() {
        const error = new Error("child stderr SECRET_SENTINEL");
        error.status = 2;
        throw error;
      },
    });
    assert.throws(() => executor.rg("x", "/codebase"), { code: "FC_TOOL_UNAVAILABLE" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
