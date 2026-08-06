import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseArgs, runCli } from "../scripts/fast-context-search.mjs";

function stream() {
  let value = "";
  return { write(chunk) { value += chunk; }, value: () => value };
}

test("CLI accepts only the finite argument grammar", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  try {
    assert.deepEqual(parseArgs(["--project", root, "--query", "find this", "--max-results", "3", "--deny", "src/private/*"]), {
      project: root,
      query: "find this",
      maxResults: 3,
      deny: ["src/private/*"],
    });
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    for (const args of [
      ["--query", "q"],
      ["--project", root],
      ["--project", root, "--project", root, "--query", "q"],
      ["--project", root, "--query", "q", "--project-path", root],
      ["--project", root, "--query", "q", "-p", root],
      ["--project", root, "--query", "q", "--print-key"],
      ["--project", root, "--query", "q", "positional"],
      ["--project", root, "--query"],
    ]) {
      assert.throws(() => parseArgs(args));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects missing key before core import or request setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  let loaded = false;
  let keyRead = false;
  const stdout = stream();
  const stderr = stream();
  const environment = {};
  Object.defineProperty(environment, "WINDSURF_API_KEY", {
    get() { keyRead = true; return ""; },
  });
  try {
    const status = await runCli({
      argv: ["--project", root, "--query", "q"],
      environment,
      stdout,
      stderr,
      loadCore: async () => { loaded = true; return {}; },
    });
    assert.equal(status, 1);
    assert.equal(loaded, false);
    assert.equal(keyRead, true);
    assert.match(stderr.value(), /^FC_KEY_MISSING: WINDSURF_API_KEY is required\n$/);
    assert.equal(stdout.value(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI argument failures do not inspect environment or load core", async () => {
  let loaded = false;
  const environment = {};
  Object.defineProperty(environment, "WINDSURF_API_KEY", { get() { throw new Error("sentinel"); } });
  const stderr = stream();
  const status = await runCli({
    argv: ["--project-path", "/tmp", "--query", "q"],
    environment,
    stderr,
    loadCore: async () => { loaded = true; return {}; },
  });
  assert.equal(status, 2);
  assert.equal(loaded, false);
  assert.match(stderr.value(), /^FC_PROJECT_ALIAS:/);
});

test("CLI redacts remote and parser sentinels from public diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  const stdout = stream();
  const stderr = stream();
  try {
    const status = await runCli({
      argv: ["--project", root, "--query", "q"],
      environment: { WINDSURF_API_KEY: "synthetic-key-not-a-real-credential" },
      stdout,
      stderr,
      loadCore: async () => ({
        async search() { throw new Error("REMOTE_RESPONSE_SENTINEL synthetic-key-not-a-real-credential"); },
      }),
    });
    assert.equal(status, 1);
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /^FC_REMOTE_UNAVAILABLE:/);
    assert.doesNotMatch(stderr.value(), /SENTINEL|synthetic-key/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
