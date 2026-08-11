import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseArgs, runCli } from "../scripts/fast-context-search.mjs";
import { FastContextError } from "../scripts/lib/public-error.mjs";

function stream() {
  let value = "";
  return { write(chunk) { value += chunk; }, value: () => value };
}

test("direct CLI entry awaits bounded credential discovery before exiting", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-entry-"));
  const home = mkdtempSync(join(tmpdir(), "fast-context-cli-home-"));
  try {
    const environment = { ...process.env, HOME: home };
    delete environment.WINDSURF_API_KEY;
    const result = spawnSync(process.execPath, [
      "scripts/fast-context-search.mjs",
      "--project",
      root,
      "--query",
      "find candidate",
    ], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "FC_KEY_MISSING: WINDSURF_API_KEY is required\n");
    const entry = readFileSync("scripts/fast-context-search.mjs", "utf8");
    assert.match(entry, /const cliKeepalive = setInterval/);
    assert.match(entry, /await runCli\(/);
    assert.match(entry, /clearInterval\(cliKeepalive\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI accepts only the finite argument grammar", () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  try {
    assert.deepEqual(parseArgs(["--project", root, "--query", "find this", "--max-results", "3", "--deny", "src/private/*"]), {
      project: root,
      query: "find this",
      maxResults: 3,
      deny: ["src/private/*"],
      noExternal: false,
    });
    assert.deepEqual(parseArgs(["--project", root, "--query", "find this", "--no-external"]), {
      project: root,
      query: "find this",
      maxResults: 10,
      deny: [],
      noExternal: true,
    });
    assert.deepEqual(parseArgs(["--help"]), { help: true });
    for (const args of [
      ["--query", "q"],
      ["--project", root],
      ["--project", root, "--project", root, "--query", "q"],
      ["--project", root, "--query", "q", "--project-path", root],
      ["--project", root, "--query", "q", "-p", root],
      ["--project", root, "--query", "q", "--print-key"],
      ["--project", root, "--query", "q", "--no-external", "--no-external"],
      ["--project", root, "--query", "q", "positional"],
      ["--project", root, "--query"],
    ]) {
      assert.throws(() => parseArgs(args));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects missing credentials before core import or request setup", async () => {
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
      resolveApiKey: async ({ environment: candidateEnvironment }) => {
        assert.equal(candidateEnvironment, environment);
        assert.equal(candidateEnvironment.WINDSURF_API_KEY, "");
        return null;
      },
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

test("CLI explicit disable avoids environment access, credential discovery, and core import", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  let resolved = false;
  let loaded = false;
  const environment = {};
  Object.defineProperty(environment, "WINDSURF_API_KEY", {
    get() { throw new Error("environment must not be read"); },
  });
  const stderr = stream();
  try {
    const status = await runCli({
      argv: ["--project", root, "--query", "q", "--no-external"],
      environment,
      stderr,
      resolveApiKey: async () => { resolved = true; return null; },
      loadCore: async () => { loaded = true; return {}; },
    });
    assert.equal(status, 1);
    assert.equal(resolved, false);
    assert.equal(loaded, false);
    assert.equal(stderr.value(), "FC_EXTERNAL_DISABLED: external search is disabled by the caller\n");
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
      resolveApiKey: async () => ({ apiKey: "synthetic-key-not-a-real-credential", source: "environment" }),
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

test("CLI preserves stable remote categories without exposing a synthetic credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  try {
    for (const code of ["FC_AUTH_REJECTED", "FC_REMOTE_TIMEOUT", "FC_REMOTE_SERVER_ERROR", "FC_PROTOCOL_INVALID"]) {
      const stderr = stream();
      const status = await runCli({
        argv: ["--project", root, "--query", "q"],
        environment: { WINDSURF_API_KEY: "synthetic-key-not-a-real-credential" },
        stderr,
        resolveApiKey: async () => ({ apiKey: "synthetic-key-not-a-real-credential", source: "environment" }),
        loadCore: async () => ({ async search() { throw new FastContextError(code); } }),
      });
      assert.equal(status, 1);
      assert.match(stderr.value(), new RegExp(`^${code}: `));
      assert.doesNotMatch(stderr.value(), /synthetic-key|REMOTE_BODY_SENTINEL|Authorization|request-id/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI preserves candidate projection incompleteness without remote details", async () => {
  const root = mkdtempSync(join(tmpdir(), "fast-context-cli-"));
  const stdout = stream();
  const stderr = stream();
  const result = {
    status: "truncated",
    search_terms: ["ledger"],
    candidates: [],
    truncated: true,
    projection: {
      remote_candidates: 1,
      accepted_candidates: 0,
      rejected_candidates: 1,
      unprocessed_candidates: 0,
      rejection_reasons: ["remote_candidate_missing_range"],
    },
    coverage: {
      visited: { entries: 1, directories: 1, files: 1, matches: 0, outputBytes: 1 },
      continuation: null,
      reasons: ["remote_candidate_projection_rejected"],
    },
  };
  try {
    const status = await runCli({
      argv: ["--project", root, "--query", "q"],
      environment: { WINDSURF_API_KEY: "synthetic-key-not-a-real-credential" },
      stdout,
      stderr,
      resolveApiKey: async () => ({ apiKey: "synthetic-key-not-a-real-credential", source: "environment" }),
      loadCore: async () => ({ async search() { return result; } }),
    });
    assert.equal(status, 0);
    assert.equal(stderr.value(), "");
    assert.deepEqual(JSON.parse(stdout.value()), result);
    assert.doesNotMatch(stdout.value(), /synthetic-key|JWT|REMOTE_RESPONSE/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
