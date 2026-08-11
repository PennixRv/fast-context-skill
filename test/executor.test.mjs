import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PathGuard, ResourceBudget } from "../scripts/lib/path-guard.mjs";
import { runBoundedProcess, ToolExecutor } from "../scripts/lib/executor.mjs";

function matchEvent(path, text = "needle\n", lineNumber = 1) {
  return `${JSON.stringify({
    type: "match",
    data: { path: { text: path }, lines: { text }, line_number: lineNumber },
  })}\n`;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("executor uses approved files, fixed rg JSON argv, and minimal environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-exec-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "ok.mjs"), "needle\n");
  writeFileSync(join(root, ".env"), "needle-secret\n");
  const budget = new ResourceBudget();
  try {
    const guard = new PathGuard(root);
    let call;
    const executor = new ToolExecutor(guard, {
      budget,
      rgBinary: "/opt/rg",
      async runProcess(binary, args, options) {
        call = { binary, args, options };
        const file = args.at(-1);
        return { status: 0, stdout: matchEvent(file) };
      },
    });
    const result = await executor.rg("-n --hidden SENTINEL", "/codebase");
    assert.equal(result.status, "complete");
    assert.match(result.output, /\/codebase\/src\/ok\.mjs:1:needle/);
    assert.equal(call.binary, "/opt/rg");
    assert.deepEqual(call.args.slice(0, 9), [
      "--no-config", "--no-ignore", "--no-follow", "--json", "--max-count",
      "50", "--regexp", "-n --hidden SENTINEL", "--",
    ]);
    assert.deepEqual(call.options.env, { LANG: "C", LC_ALL: "C", RIPGREP_CONFIG_PATH: "" });
    assert.ok(call.args.every((arg) => !arg.includes(".env")));
    assert.deepEqual(
      await executor.recoverCandidateRange("/codebase/src/ok.mjs", { start_line: 8, end_line: 10 }),
      {
        relativePath: "src/ok.mjs",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
    );
    assert.equal((await executor.tree("/codebase", 1)).output.includes(".env"), false);
    assert.equal((await executor.ls("/codebase", false, true)).output.includes(".env"), false);
    assert.match((await executor.glob("*.mjs", "/codebase/src", "file")).output, /ok\.mjs/);
  } finally {
    budget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate recovery does not reinterpret rg evidence after a version change", async () => {
  const budget = new ResourceBudget();
  let reads = 0;
  const guard = {
    normalizeVirtualPath() { return "src/changing.mjs"; },
    async validateCandidateRange() {
      budget.markTruncated("candidate_changed");
      return null;
    },
    async readText() {
      reads += 1;
      return { read_range: { start_line: 1, end_line: 1 } };
    },
  };
  try {
    const executor = new ToolExecutor(guard, { budget });
    executor.readEvidence.set("src/changing.mjs", [{ start_line: 1, end_line: 1 }]);
    executor.rgEvidence.set("src/changing.mjs", [1]);
    assert.equal(await executor.recoverCandidateRange("/codebase/src/changing.mjs"), null);
    assert.equal(reads, 0);
    assert.deepEqual(budget.snapshot().reasons, ["candidate_changed"]);
  } finally {
    budget.dispose();
  }
});

test("implementation evidence ranks guarded reads before the strongest rg path", () => {
  const budget = new ResourceBudget();
  try {
    const executor = new ToolExecutor({}, { budget });
    executor.readEvidence.set("src/primary.mjs", [{ start_line: 1, end_line: 10 }]);
    executor.readEvidence.set("test/primary.test.mjs", [{ start_line: 1, end_line: 10 }]);
    executor.rgEvidence.set("src/weak.mjs", [4]);
    executor.rgEvidence.set("src/strong.mjs", [2, 8, 12]);
    assert.deepEqual(executor.implementationEvidencePaths({ includeRg: false }), [
      "src/primary.mjs",
    ]);
    assert.deepEqual(executor.implementationEvidencePaths(), [
      "src/primary.mjs",
      "src/strong.mjs",
      "src/weak.mjs",
    ]);
  } finally {
    budget.dispose();
  }
});

test("test import recovery resolves one guarded TypeScript implementation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-import-recovery-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "implementation.ts"), "export const implementation = true;\n");
  writeFileSync(
    join(root, "test", "implementation.test.ts"),
    'import { implementation } from "../src/implementation.js";\n',
  );
  const budget = new ResourceBudget();
  try {
    const executor = new ToolExecutor(new PathGuard(root), { budget });
    assert.deepEqual(await executor.recoverImportedImplementation(["test/implementation.test.ts"]), {
      relativePath: "src/implementation.ts",
      startLine: 1,
      endLine: 1,
      lineCount: 1,
    });
  } finally {
    budget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("executor exposes closed typed failures without child details", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-exec-"));
  writeFileSync(join(root, "ok.txt"), "x\n");
  const budget = new ResourceBudget();
  try {
    const executor = new ToolExecutor(new PathGuard(root), {
      budget,
      rgBinary: "/opt/rg",
      async runProcess() {
        throw new Error("child stderr SECRET_SENTINEL");
      },
    });
    await assert.rejects(executor.rg("x", "/codebase"), { code: "FC_TOOL_UNAVAILABLE" });
    const rendered = await executor.execToolCall({
      command1: { type: "rg", pattern: "x", path: "/codebase" },
    });
    assert.match(rendered, /"status":"failure"/);
    assert.match(rendered, /"code":"FC_TOOL_UNAVAILABLE"/);
    assert.doesNotMatch(rendered, /SECRET_SENTINEL|child stderr/);
  } finally {
    budget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rg searches batches beyond file 512 and preserves truncation when enumeration stops", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-rg-batches-"));
  for (let index = 0; index < 513; index += 1) {
    writeFileSync(join(root, `file-${String(index).padStart(3, "0")}.mjs`), "ordinary\n");
  }
  writeFileSync(join(root, "z-target.mjs"), "needle\n");
  const completeBudget = new ResourceBudget();
  const limitedBudget = new ResourceBudget({ limits: { MAX_WALK_FILES: 512 } });
  try {
    let completeCalls = 0;
    const complete = new ToolExecutor(new PathGuard(root), {
      budget: completeBudget,
      rgBinary: "/opt/rg",
      async runProcess(_binary, args) {
        completeCalls += 1;
        const files = args.slice(args.indexOf("--") + 1);
        const target = files.find((file) => file.endsWith("z-target.mjs"));
        return target
          ? { status: 0, stdout: matchEvent(target) }
          : { status: 1, stdout: "" };
      },
    });
    const completeResult = await complete.rg("needle", "/codebase");
    assert.equal(completeResult.status, "complete");
    assert.equal(completeCalls, 5);
    assert.match(completeResult.output, /\/codebase\/z-target\.mjs:1:needle/);

    let limitedCalls = 0;
    const limited = new ToolExecutor(new PathGuard(root), {
      budget: limitedBudget,
      rgBinary: "/opt/rg",
      async runProcess() {
        limitedCalls += 1;
        return { status: 1, stdout: "" };
      },
    });
    const limitedResult = await limited.rg("needle", "/codebase");
    assert.equal(limitedResult.status, "truncated");
    assert.equal(limitedResult.reason, "file_limit");
    assert.equal(limitedResult.output, "(no matches in visited files)");
    assert.equal(limitedCalls, 4);
    assert.ok(limitedResult.continuation);
  } finally {
    completeBudget.dispose();
    limitedBudget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBoundedProcess waits for an aborted child to close and leaves no process", async (t) => {
  const controller = new AbortController();
  let pid;
  t.after(() => {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
  });
  const started = performance.now();
  const pending = runBoundedProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    {
      signal: controller.signal,
      killGraceMs: 25,
      onSpawn(value) {
        pid = value;
        setTimeout(() => controller.abort(), 50);
      },
    },
  );
  await assert.rejects(pending, { code: "FC_TOOL_UNAVAILABLE" });
  assert.equal(processExists(pid), false);
  assert.ok(performance.now() - started < 1_000);
});

test("runBoundedProcess enforces output bytes before collecting an entire child response", async (t) => {
  let pid;
  t.after(() => {
    if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
  });
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      { maxOutputBytes: 64, killGraceMs: 25, onSpawn: (value) => { pid = value; } },
    ),
    { code: "FC_OUTPUT_LIMIT" },
  );
  assert.equal(processExists(pid), false);
});
