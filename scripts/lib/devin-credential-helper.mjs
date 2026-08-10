import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isSupportedDevinCredential } from "./credentials.mjs";

const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;
const CREDENTIAL_PATH = platform() === "linux"
  ? join(homedir(), ".local", "share", "devin", "credentials.toml")
  : null;
const TOML_FIELDS = Object.freeze([
  "windsurfAuthStatus",
  "api_key",
  "apiKey",
  "devin_api_key",
  "devinApiKey",
  "windsurf_api_key",
  "windsurfApiKey",
  "access_token",
  "accessToken",
  "token",
]);

function tomlValue(text, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|([^\\s#\\r\\n]+))\\s*(?:#.*)?$`, "m"));
  return (match?.[1] || match?.[2] || match?.[3] || "").trim();
}

function extractCredential(text) {
  for (const field of TOML_FIELDS) {
    const value = tomlValue(text, field);
    if (isSupportedDevinCredential(value)) return value;
  }
  return null;
}

function readCredentialFile() {
  if (!CREDENTIAL_PATH) return null;
  let descriptor;
  try {
    const initial = lstatSync(CREDENTIAL_PATH);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_CREDENTIAL_FILE_BYTES) return null;
    descriptor = openSync(CREDENTIAL_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return null;
    return extractCredential(readFileSync(descriptor, "utf8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The helper never emits filesystem details.
      }
    }
  }
}

const credential = readCredentialFile();
if (credential) process.stdout.write(credential);
process.exitCode = credential ? 0 : 1;
