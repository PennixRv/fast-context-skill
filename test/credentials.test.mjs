import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CREDENTIAL_LIMITS,
  isSupportedDevinCredential,
  readDevinCredential,
  resolveCredential,
} from "../scripts/lib/credentials.mjs";

const devinSession = "devin-session-token$synthetic-session-token-12345";
const devinKey = "devin-synthetic-token-12345";

function credentialHome(content) {
  const home = mkdtempSync(join(tmpdir(), "fast-context-devin-"));
  const directory = join(home, ".local", "share", "devin");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "credentials.toml"), content);
  return home;
}

test("credential format accepts only supported Devin and static key prefixes", () => {
  assert.equal(isSupportedDevinCredential(devinSession), true);
  assert.equal(isSupportedDevinCredential(devinKey), true);
  assert.equal(isSupportedDevinCredential("sk-synthetic-token-12345"), true);
  assert.equal(isSupportedDevinCredential("plain-secret-value"), false);
  assert.equal(isSupportedDevinCredential("devin-short"), false);
});

test("explicit static credential wins without starting Devin discovery", async () => {
  let helperCalled = false;
  const result = await resolveCredential({
    environment: { WINDSURF_API_KEY: "  static-synthetic-key  " },
    runProcess: async () => { helperCalled = true; return { status: 0, stdout: devinSession }; },
  });
  assert.deepEqual(result, { apiKey: "static-synthetic-key", source: "environment" });
  assert.equal(helperCalled, false);
});

test("Linux helper reads only the fixed Devin credentials fixture", async () => {
  const home = credentialHome(`windsurfAuthStatus = "${devinSession}"\n`);
  try {
    assert.equal(await readDevinCredential({ environment: { HOME: home } }), devinSession);
    writeFileSync(join(home, ".local", "share", "devin", "credentials.toml"), `api_key = '${devinKey}'\n`);
    assert.equal(await readDevinCredential({ environment: { HOME: home } }), devinKey);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("helper rejects unknown fields, invalid values, and symlinked credentials files", async () => {
  const home = credentialHome(`unrelated = "${devinSession}"\n`);
  const credentialPath = join(home, ".local", "share", "devin", "credentials.toml");
  try {
    assert.equal(await readDevinCredential({ environment: { HOME: home } }), null);
    writeFileSync(credentialPath, "api_key = plain-secret-value\n");
    assert.equal(await readDevinCredential({ environment: { HOME: home } }), null);
    const target = join(home, "outside.toml");
    writeFileSync(target, `api_key = "${devinKey}"\n`);
    rmSync(credentialPath);
    symlinkSync(target, credentialPath);
    assert.equal(await readDevinCredential({ environment: { HOME: home } }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-Linux discovery and helper failures close as no credential", async () => {
  let helperCalled = false;
  assert.equal(await readDevinCredential({
    platformName: "darwin",
    runProcess: async () => { helperCalled = true; return { status: 0, stdout: devinSession }; },
  }), null);
  assert.equal(helperCalled, false);
  assert.equal(await readDevinCredential({
    platformName: "linux",
    runProcess: async () => { throw new Error("child stderr sentinel"); },
  }), null);
});

test("discovery uses a no-shell helper with a minimal environment and byte cap", async () => {
  let call;
  const result = await readDevinCredential({
    environment: { HOME: "/synthetic/home", WINDSURF_API_KEY: "must-not-be-forwarded" },
    platformName: "linux",
    runProcess: async (binary, args, options) => {
      call = { binary, args, options };
      return { status: 0, stdout: devinSession };
    },
  });
  assert.equal(result, devinSession);
  assert.equal(call.binary, process.execPath);
  assert.equal(call.args.length, 1);
  assert.match(call.args[0], /devin-credential-helper\.mjs$/);
  assert.deepEqual(call.options.env, { HOME: "/synthetic/home" });
  assert.equal(call.options.maxOutputBytes, CREDENTIAL_LIMITS.MAX_HELPER_OUTPUT_BYTES);
  assert.ok(call.options.signal instanceof AbortSignal);
});
