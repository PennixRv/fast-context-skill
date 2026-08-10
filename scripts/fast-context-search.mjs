#!/usr/bin/env node

import { PathGuard } from "./lib/path-guard.mjs";
import { resolveCredential } from "./lib/credentials.mjs";
import { FastContextError, publicDiagnostic } from "./lib/public-error.mjs";

const MAX_QUERY_LENGTH = 2000;
const MAX_RESULTS = 50;

const USAGE = `Usage:
  fast-context-search --project <directory> --query <text> [--max-results <n>] [--deny <relative-glob> ...] [--no-external]
  fast-context-search --help`;

function cliError(code) {
  return new FastContextError(code);
}

function takeValue(argv, index) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) throw cliError("FC_ARG_VALUE_MISSING");
  return value;
}

function takeInteger(value) {
  if (!/^\d+$/.test(value)) throw cliError("FC_PATH_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RESULTS) {
    throw cliError("FC_PATH_INVALID");
  }
  return parsed;
}

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };

  const options = {
    project: null,
    query: null,
    maxResults: 10,
    deny: [],
    noExternal: false,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project-path") throw cliError("FC_PROJECT_ALIAS");
    if (argument === "--help") throw cliError("FC_ARG_UNKNOWN");
    if (argument === "--project" || argument === "--query" || argument === "--max-results") {
      if (seen.has(argument)) {
        throw cliError(argument === "--project" ? "FC_PROJECT_DUPLICATE" : "FC_ARG_DUPLICATE");
      }
      seen.add(argument);
      const value = takeValue(argv, index);
      index += 1;
      if (argument === "--project") options.project = value;
      if (argument === "--query") options.query = value;
      if (argument === "--max-results") options.maxResults = takeInteger(value);
      continue;
    }
    if (argument === "--deny") {
      const value = takeValue(argv, index);
      options.deny.push(value);
      index += 1;
      continue;
    }
    if (argument === "--no-external") {
      if (seen.has(argument)) throw cliError("FC_ARG_DUPLICATE");
      seen.add(argument);
      options.noExternal = true;
      continue;
    }
    throw cliError("FC_ARG_UNKNOWN");
  }

  if (!options.project) throw cliError("FC_PROJECT_REQUIRED");
  if (!options.query) throw cliError("FC_QUERY_REQUIRED");
  if (options.query.length > MAX_QUERY_LENGTH) throw cliError("FC_OUTPUT_LIMIT");
  return options;
}

function errorStatus(error) {
  return String(error?.code || "").startsWith("FC_ARG") ||
    String(error?.code || "").startsWith("FC_PROJECT") ||
    error?.code === "FC_QUERY_REQUIRED" ||
    error?.code === "FC_PROJECT_ALIAS" ||
    error?.code === "FC_PROJECT_DUPLICATE"
    ? 2
    : 1;
}

export async function runCli({
  argv,
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  loadCore = () => import("./lib/core.mjs"),
  resolveApiKey = resolveCredential,
} = {}) {
  try {
    const options = parseArgs(argv || []);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }

    const guard = new PathGuard(options.project, options.deny);
    if (options.noExternal) throw cliError("FC_EXTERNAL_DISABLED");
    const credential = await resolveApiKey({ environment });
    if (!credential) throw cliError("FC_KEY_MISSING");
    const { search } = await loadCore();
    const result = await search({
      query: options.query,
      guard,
      apiKey: credential.apiKey,
      maxResults: options.maxResults,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safeError = error instanceof FastContextError
      ? error
      : new FastContextError("FC_REMOTE_UNAVAILABLE");
    stderr.write(`${safeError.code}: ${publicDiagnostic(safeError)}\n`);
    return errorStatus(safeError);
  }
}

if (process.argv[1] && process.argv[1].endsWith("fast-context-search.mjs")) {
  runCli({ argv: process.argv.slice(2) }).then((status) => {
    process.exitCode = status;
  });
}

export { MAX_QUERY_LENGTH, MAX_RESULTS, USAGE };
