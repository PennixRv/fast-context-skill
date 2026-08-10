import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { runBoundedProcess } from "./executor.mjs";

const DEVIN_CREDENTIAL_PATTERN = /^(?:devin-session-token\$|devin-|sk-)[A-Za-z0-9._~-]{10,}$/;

export const CREDENTIAL_LIMITS = Object.freeze({
  HELPER_TIMEOUT_MS: 1_000,
  MAX_HELPER_OUTPUT_BYTES: 16 * 1024,
});

function explicitCredential(environment) {
  const value = environment?.WINDSURF_API_KEY;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isSupportedDevinCredential(value) {
  return typeof value === "string" && DEVIN_CREDENTIAL_PATTERN.test(value);
}

function helperEnvironment(environment) {
  const home = environment?.HOME;
  return typeof home === "string" && home.length > 0 ? { HOME: home } : {};
}

export async function readDevinCredential({
  environment = process.env,
  platformName = platform(),
  nodePath = process.execPath,
  helperPath = fileURLToPath(new URL("./devin-credential-helper.mjs", import.meta.url)),
  runProcess = runBoundedProcess,
} = {}) {
  if (platformName !== "linux") return null;

  const signal = AbortSignal.timeout(CREDENTIAL_LIMITS.HELPER_TIMEOUT_MS);
  try {
    const result = await runProcess(nodePath, [helperPath], {
      env: helperEnvironment(environment),
      signal,
      maxOutputBytes: CREDENTIAL_LIMITS.MAX_HELPER_OUTPUT_BYTES,
    });
    if (result.status !== 0 || !isSupportedDevinCredential(result.stdout)) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

export async function resolveCredential(options = {}) {
  const explicit = explicitCredential(options.environment);
  if (explicit) return { apiKey: explicit, source: "environment" };

  const discovered = await readDevinCredential(options);
  if (discovered) return { apiKey: discovered, source: "devin" };
  return null;
}
