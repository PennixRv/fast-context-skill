import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PathGuard, ResourceBudget } from "../scripts/lib/path-guard.mjs";

function createBudget(options = {}) {
  return new ResourceBudget({ timeoutMs: 5_000, ...options });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fast-context-guard-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "logs"));
  mkdirSync(join(root, "secrets"));
  writeFileSync(join(root, "root.mjs"), "root\n");
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

test("PathGuard keeps canonical, deny, and symlink boundaries across async tools", async () => {
  const { root, outside } = fixture();
  const budget = createBudget();
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

    const listing = await guard.listDirectory("/codebase", budget);
    assert.equal(listing.status, "complete");
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["root.mjs", "src"]);
    assert.match((await guard.readText("/codebase/src/a.mjs", 2, 2, budget)).output, /^2:second$/);
    assert.doesNotMatch((await guard.tree("/codebase", 4, budget)).output, /\.git|escape|\.env/);

    const shallow = await guard.glob("/codebase", "src/*.mjs", "file", budget);
    assert.equal(shallow.status, "complete");
    assert.match(shallow.output, /\/codebase\/src\/a\.mjs/);
    const denied = await guard.glob("/codebase", "src/nested/*.mjs", "file", budget);
    assert.deepEqual({ status: denied.status, output: denied.output }, { status: "complete", output: "(no matches)" });
    const recursive = await guard.glob("/codebase", "**/*.mjs", "file", budget);
    assert.match(recursive.output, /\/codebase\/root\.mjs/);
    assert.match(recursive.output, /\/codebase\/src\/a\.mjs/);
    assert.doesNotMatch(recursive.output, /nested|escape/);
    await assert.rejects(guard.glob("/codebase", "src//*.mjs", "file", budget), { code: "FC_PATH_INVALID" });
    await assert.rejects(guard.glob("/codebase", "src/*.mjs", "invalid", budget), { code: "FC_PATH_INVALID" });
    assert.ok(outside.startsWith("/tmp/"));
  } finally {
    budget.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("glob **/ matches root and nested files and reports a bounded 100-result continuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-glob-"));
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(join(root, "root.mjs"), "root\n");
  writeFileSync(join(root, "nested", "nested.mjs"), "nested\n");
  writeFileSync(join(root, "nested", "deeper", "deep.mjs"), "deep\n");
  for (let index = 0; index < 105; index += 1) {
    writeFileSync(join(root, `item-${String(index).padStart(3, "0")}.txt`), "x\n");
  }
  const budget = createBudget();
  try {
    const guard = new PathGuard(root);
    const recursive = await guard.glob("/codebase", "**/*.mjs", "file", budget);
    assert.equal(recursive.status, "complete");
    assert.equal(recursive.output.split("\n").length, 3);

    const bounded = await guard.glob("/codebase", "**/*.txt", "file", budget);
    assert.equal(bounded.status, "truncated");
    assert.equal(bounded.reason, "glob_result_limit");
    assert.equal(bounded.output.split("\n").length, 100);
    assert.match(bounded.continuation.next_path, /^\/codebase\/item-/);
  } finally {
    budget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("file 513 and later are either searched or exposed as typed truncation", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-files-"));
  for (let index = 0; index < 514; index += 1) {
    writeFileSync(join(root, `file-${String(index).padStart(3, "0")}.mjs`), `${index}\n`);
  }
  const completeBudget = createBudget();
  const limitedBudget = createBudget({ limits: { MAX_WALK_FILES: 512 } });
  try {
    const guard = new PathGuard(root);
    const complete = await guard.regularFiles("/codebase", completeBudget);
    assert.equal(complete.status, "complete");
    assert.equal(complete.files.length, 514);
    assert.ok(complete.files.some((file) => file.relativePath === "file-513.mjs"));

    const limited = await guard.regularFiles("/codebase", limitedBudget);
    assert.equal(limited.status, "truncated");
    assert.equal(limited.reason, "file_limit");
    assert.equal(limited.files.length, 512);
    assert.equal(limited.visited.files, 512);
    assert.match(limited.continuation.next_path, /^\/codebase\/file-/);
  } finally {
    completeBudget.dispose();
    limitedBudget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wide, deep, and 2500-directory walks stop with explicit truncation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-bounds-"));
  mkdirSync(join(root, "wide"));
  for (let index = 0; index < 200; index += 1) {
    writeFileSync(join(root, "wide", `entry-${String(index).padStart(3, "0")}.txt`), "x\n");
  }
  let deep = join(root, "deep");
  mkdirSync(deep);
  for (let index = 0; index < 10; index += 1) {
    deep = join(deep, `level-${index}`);
    mkdirSync(deep);
  }
  writeFileSync(join(deep, "leaf.txt"), "leaf\n");
  mkdirSync(join(root, "empties"));
  for (let index = 0; index < 2_500; index += 1) {
    mkdirSync(join(root, "empties", `empty-${String(index).padStart(4, "0")}`));
  }

  const wideBudget = createBudget({ limits: { MAX_VISITED_ENTRIES: 50 } });
  const deepBudget = createBudget({ limits: { MAX_WALK_DEPTH: 4 } });
  const directoryBudget = createBudget({ limits: { MAX_VISITED_DIRECTORIES: 40 } });
  try {
    const guard = new PathGuard(root);
    const wideStarted = performance.now();
    const wide = await guard.glob("/codebase/wide", "*.missing", "file", wideBudget);
    assert.equal(wide.status, "truncated");
    assert.equal(wide.reason, "entry_limit");
    assert.equal(wide.output, "(no matches in visited paths)");

    const deepResult = await guard.regularFiles("/codebase/deep", deepBudget);
    assert.equal(deepResult.status, "truncated");
    assert.equal(deepResult.reason, "depth_limit");

    const empties = await guard.glob("/codebase/empties", "**/*.missing", "file", directoryBudget);
    assert.equal(empties.status, "truncated");
    assert.equal(empties.reason, "directory_limit");
    assert.equal(empties.output, "(no matches in visited paths)");
    assert.equal(empties.visited.directories, 40);
    const elapsed = Math.round(performance.now() - wideStarted);
    t.diagnostic(`bounded large-fixture walk: 200 files + depth 10 + 2500 empty directories in ${elapsed} ms`);
    assert.ok(elapsed < 5_000);
  } finally {
    wideBudget.dispose();
    deepBudget.dispose();
    directoryBudget.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("small repository traversal has repeatable scale and latency", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-benchmark-"));
  for (let directory = 0; directory < 4; directory += 1) {
    mkdirSync(join(root, `src-${directory}`));
    for (let file = 0; file < 8; file += 1) {
      writeFileSync(join(root, `src-${directory}`, `file-${file}.mjs`), "export const value = 1;\n");
    }
  }
  try {
    const guard = new PathGuard(root);
    const durations = [];
    for (let run = 0; run < 3; run += 1) {
      const budget = createBudget();
      const started = performance.now();
      const result = await guard.regularFiles("/codebase", budget);
      durations.push(performance.now() - started);
      assert.equal(result.status, "complete");
      assert.equal(result.files.length, 32);
      assert.deepEqual(result.visited, {
        entries: 36,
        directories: 5,
        files: 32,
        matches: 0,
        outputBytes: 0,
      });
      budget.dispose();
    }
    t.diagnostic(`small-repository benchmark: 32 files/5 directories, runs=${durations.map((value) => value.toFixed(1)).join(",")} ms`);
    assert.ok(Math.max(...durations) < 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate ranges fail closed on EOF, empty files, span, escapes, and file changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-ranges-"));
  mkdirSync(join(root, "denied"));
  writeFileSync(join(root, "trailing.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "no-tail.txt"), "one\ntwo\nthree");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(root, "long.txt"), Array.from({ length: 201 }, (_, index) => `line-${index + 1}`).join("\n"));
  writeFileSync(join(root, "changing.txt"), "stable\ncontent\n");
  writeFileSync(join(root, "denied", "hidden.txt"), "hidden\n");
  const outside = mkdtempSync(join(tmpdir(), "fast-context-range-outside-"));
  writeFileSync(join(outside, "outside.txt"), "outside\n");
  symlinkSync(join(outside, "outside.txt"), join(root, "escape.txt"));
  const budget = createBudget();
  const changingBudget = createBudget();
  try {
    const guard = new PathGuard(root, ["denied/*"]);
    assert.deepEqual(
      await guard.validateCandidateRange("/codebase/trailing.txt", 3, 3, budget),
      { relativePath: "trailing.txt", startLine: 3, endLine: 3, lineCount: 3 },
    );
    assert.deepEqual(
      await guard.validateCandidateRange("/codebase/no-tail.txt", 3, 3, budget),
      { relativePath: "no-tail.txt", startLine: 3, endLine: 3, lineCount: 3 },
    );
    assert.equal(await guard.validateCandidateRange("/codebase/trailing.txt", 4, 4, budget), null);
    assert.equal(await guard.validateCandidateRange("/codebase/trailing.txt", 2, 4, budget), null);
    assert.equal(await guard.validateCandidateRange("/codebase/empty.txt", 1, 1, budget), null);
    assert.equal(await guard.validateCandidateRange("/codebase/long.txt", 1, 201, budget), null);
    await assert.rejects(
      guard.validateCandidateRange("/codebase/denied/hidden.txt", 1, 1, budget),
      { code: "FC_PATH_DENIED" },
    );
    await assert.rejects(
      guard.validateCandidateRange("/codebase/escape.txt", 1, 1, budget),
      { code: "FC_PATH_DENIED" },
    );
    await assert.rejects(
      guard.validateCandidateRange("/tmp/outside.txt", 1, 1, budget),
      { code: "FC_PATH_INVALID" },
    );

    const changingGuard = new PathGuard(root);
    const resolveExistingAsync = changingGuard.resolveExistingAsync.bind(changingGuard);
    let resolveCalls = 0;
    changingGuard.resolveExistingAsync = async (...args) => {
      resolveCalls += 1;
      if (resolveCalls === 2) writeFileSync(join(root, "changing.txt"), "changed\nwith\nmore\nlines\n");
      return resolveExistingAsync(...args);
    };
    assert.equal(
      await changingGuard.validateCandidateRange("/codebase/changing.txt", 1, 1, changingBudget),
      null,
    );
    assert.equal(changingBudget.truncated, true);
    assert.deepEqual(changingBudget.snapshot().reasons, ["candidate_changed"]);
  } finally {
    budget.dispose();
    changingBudget.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("ResourceBudget uses one monotonic deadline and external cancellation", () => {
  let now = 1_000;
  const controller = new AbortController();
  const budget = new ResourceBudget({ timeoutMs: 100, signal: controller.signal, now: () => now });
  try {
    assert.equal(budget.remainingMs(), 100);
    assert.equal(budget.tryConsume("entries", 3), true);
    now += 40;
    assert.equal(budget.remainingMs(), 60);
    assert.equal(budget.snapshot().elapsed_ms, 40);
    controller.abort();
    assert.throws(() => budget.remainingMs(), { code: "FC_REMOTE_UNAVAILABLE" });
  } finally {
    budget.dispose();
  }
});
