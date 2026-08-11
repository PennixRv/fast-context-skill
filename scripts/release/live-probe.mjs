import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveCredential } from "../lib/credentials.mjs";
import { search } from "../lib/core.mjs";
import { PathGuard } from "../lib/path-guard.mjs";
import { buildConsumerPackage } from "./build-package.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const FIXTURE_DIRECTORY = join(PROJECT_ROOT, "test", "fixtures", "ledger-recall");
const SOURCE_CLI = join(PROJECT_ROOT, "scripts", "fast-context-search.mjs");
const MAX_CAPTURED_BYTES = 128 * 1024;
const PROBE_INTER_RUN_DELAY_MS = 3_000;
const RETAINED_QUERY = "Where does the application resume financial records left in a partially committed state after an interrupted batch?";
const QUERY_VARIANTS = [
  RETAINED_QUERY,
  "Which code repairs financial records that were only half applied when a batch was interrupted?",
  "Find the implementation that resumes incomplete settlement records after a failed batch run.",
];

function controlledEnvironment(overrides = {}, { allowApiKey = false } = {}) {
  const environment = { ...process.env, ...overrides };
  if (!allowApiKey) delete environment.WINDSURF_API_KEY;
  return environment;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const append = (current, chunk) => {
      if (current.length > MAX_CAPTURED_BYTES - chunk.length) {
        overflow = true;
        child.kill("SIGTERM");
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", () => resolveRun({ status: null, stdout: "", stderr: "", overflow: true }));
    child.on("close", (status) => resolveRun({
      status,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      overflow,
    }));
  });
}

function failureCode(stderr, overflow) {
  if (overflow) return "FC_OUTPUT_LIMIT";
  const match = stderr.match(/^(FC_[A-Z_]+):/);
  return match ? match[1] : "FC_REMOTE_UNAVAILABLE";
}

function summarizeResult(label, processResult) {
  if (processResult.status !== 0) {
    return {
      label,
      exit_status: processResult.status,
      candidate_count: 0,
      candidates: [],
      failure: failureCode(processResult.stderr, processResult.overflow),
      stdout_shape: processResult.stdout.length === 0 ? "empty" : "not_parsed",
      target_found: false,
      pseudo_complete_empty: false,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(processResult.stdout);
  } catch {
    return {
      label,
      exit_status: processResult.status,
      candidate_count: 0,
      candidates: [],
      failure: "FC_PROTOCOL_INVALID",
      stdout_shape: processResult.stdout.trim().length === 0 ? "empty" : "invalid_json",
      target_found: false,
      pseudo_complete_empty: false,
    };
  }
  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
      .filter((candidate) => typeof candidate?.path === "string"
        && Number.isSafeInteger(candidate?.start_line)
        && Number.isSafeInteger(candidate?.end_line))
      .map((candidate) => ({
        path: candidate.path,
        start_line: candidate.start_line,
        end_line: candidate.end_line,
      }))
    : [];
  const target = candidates.some((candidate) => candidate.path === "src/ledger/repair.ts"
    && candidate.start_line <= 8 && candidate.end_line >= 8);
  const pseudoCompleteEmpty = parsed.status === "complete" && candidates.length === 0;
  return {
    label,
    exit_status: processResult.status,
    status: parsed.status === "complete" || parsed.status === "truncated" ? parsed.status : "invalid",
    candidate_count: candidates.length,
    candidates,
    failure: null,
    stdout_shape: "json",
    target_found: target,
    pseudo_complete_empty: pseudoCompleteEmpty,
  };
}

function summarizedCandidates(value) {
  return Array.isArray(value)
    ? value
      .filter((candidate) => typeof candidate?.path === "string"
        && Number.isSafeInteger(candidate?.start_line)
        && Number.isSafeInteger(candidate?.end_line))
      .map((candidate) => ({
        path: candidate.path,
        start_line: candidate.start_line,
        end_line: candidate.end_line,
      }))
    : [];
}

function summarizeProtocolEvents(events) {
  const preflight = events
    .filter((event) => event?.event === "rate_limit_preflight" && typeof event.status === "string")
    .map((event) => event.status);
  const streamRetries = events.filter((event) => event?.event === "stream_retry").length;
  const toolCalls = events
    .filter((event) => typeof event?.tool_name === "string" && Number.isSafeInteger(event?.turn))
    .map((event) => ({
      turn: event.turn,
      final_turn: event.final_turn === true,
      tool_name: event.tool_name,
    }));
  const localTools = events
    .filter((event) => event?.event === "local_tool")
    .map((event) => ({
      turn: Number.isSafeInteger(event.turn) ? event.turn : null,
      command_type: typeof event.command_type === "string" ? event.command_type : "invalid",
      status: typeof event.status === "string" ? event.status : "failure",
      reason: typeof event.reason === "string" ? event.reason : null,
      code: typeof event.code === "string" ? event.code : null,
    }));
  return {
    preflight,
    stream_retries: streamRetries,
    tool_calls: toolCalls,
    local_tools: localTools,
  };
}

function transportStage(url) {
  if (typeof url === "string" && url.includes("GetUserJwt")) return "jwt";
  if (typeof url === "string" && url.includes("CheckUserMessageRateLimit")) return "preflight";
  return "stream";
}

function observedFetch(events) {
  return async (url, options) => {
    const stage = transportStage(url);
    try {
      const response = await fetch(url, options);
      events.push({ stage, status: response.status });
      return response;
    } catch (error) {
      events.push({ stage, status: "transport_failure" });
      throw error;
    }
  };
}

function writeEvent(event, value) {
  process.stdout.write(`${JSON.stringify({ event, ...value })}\n`);
}

function waitForProbeInterval() {
  return new Promise((resolveWait) => setTimeout(resolveWait, PROBE_INTER_RUN_DELAY_MS));
}

async function probeCli(cliPath, projectRoot, queries, labelPrefix, environment) {
  const summary = [];
  for (const [index, query] of queries.entries()) {
    if (index > 0) await waitForProbeInterval();
    const processResult = await run(process.execPath, [
      cliPath,
      "--project",
      projectRoot,
      "--query",
      query,
    ], { cwd: PROJECT_ROOT, env: environment });
    const entry = summarizeResult(`${labelPrefix}-${String(index + 1).padStart(2, "0")}`, processResult);
    summary.push(entry);
    writeEvent("run", entry);
  }
  return summary;
}

function verifySuccessfulRuns(summary) {
  return summary.every((result) => result.exit_status === 0
    && result.status !== "invalid"
    && result.target_found
    && !result.pseudo_complete_empty
    && result.failure === null);
}

async function invalidKeyProbe(projectRoot) {
  const processResult = await run(process.execPath, [
    SOURCE_CLI,
    "--project",
    projectRoot,
    "--query",
    RETAINED_QUERY,
  ], {
    cwd: PROJECT_ROOT,
    env: controlledEnvironment(
      { WINDSURF_API_KEY: "invalid-controlled-auth-test-key" },
      { allowApiKey: true },
    ),
  });
  return {
    exit_status: processResult.status,
    failure: failureCode(processResult.stderr, processResult.overflow),
    stdout_empty: processResult.stdout.length === 0,
  };
}

async function diagnose(projectRoot, queries = QUERY_VARIANTS) {
  const credential = await resolveCredential({ environment: controlledEnvironment() });
  if (!credential) throw new Error("credential discovery failed");
  const summaries = [];
  for (const [index, query] of queries.entries()) {
    const protocol_events = [];
    const transport_events = [];
    try {
      const result = await search({
        query,
        guard: new PathGuard(projectRoot),
        apiKey: credential.apiKey,
        fetchImpl: observedFetch(transport_events),
        onProtocolEvent(event) { protocol_events.push(event); },
      });
      const candidates = summarizedCandidates(result.candidates);
      summaries.push({
        label: `diagnostic-${String(index + 1).padStart(2, "0")}`,
        status: result.status,
        candidate_count: candidates.length,
        candidates,
        projection: result.projection,
        coverage_reasons: Array.isArray(result.coverage?.reasons) ? result.coverage.reasons : [],
        failure: null,
        protocol: summarizeProtocolEvents(protocol_events),
        transport: transport_events,
      });
    } catch (error) {
      summaries.push({
        label: `diagnostic-${String(index + 1).padStart(2, "0")}`,
        candidate_count: 0,
        candidates: [],
        failure: typeof error?.code === "string" ? error.code : "FC_REMOTE_UNAVAILABLE",
        protocol_reason: typeof error?.protocolReason === "string" ? error.protocolReason : null,
        protocol: summarizeProtocolEvents(protocol_events),
        transport: transport_events,
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ event: "diagnostic_summary", summaries })}\n`);
  if (!summaries.every((summary) => summary.failure === null)) process.exitCode = 1;
}

function installConsumerPackage(outputDirectory) {
  const artifact = buildConsumerPackage({ outputDirectory });
  const installDirectory = join(outputDirectory, "install");
  const result = spawnSync("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDirectory,
    artifact.tarballPath,
  ], {
    cwd: PROJECT_ROOT,
    env: controlledEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("offline package installation failed");
  return {
    cliPath: join(installDirectory, "node_modules", "@pennixrv", "fast-context-skill", "scripts", "fast-context-search.mjs"),
    tarball_sha256: sha256(artifact.tarballPath),
  };
}

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-live-probe-"));
  const projectRoot = join(temporaryDirectory, "ledger-recall");
  try {
    cpSync(FIXTURE_DIRECTORY, projectRoot, { recursive: true });
    const environment = controlledEnvironment();
    const retainedRuns = await probeCli(
      SOURCE_CLI,
      projectRoot,
      Array.from({ length: 10 }, () => RETAINED_QUERY),
      "source-retained",
      environment,
    );
    const sourceVariants = await probeCli(
      SOURCE_CLI,
      projectRoot,
      QUERY_VARIANTS.slice(1),
      "source-variant",
      environment,
    );
    const consumer = installConsumerPackage(temporaryDirectory);
    const packedVariants = await probeCli(
      consumer.cliPath,
      projectRoot,
      QUERY_VARIANTS,
      "packed-variant",
      environment,
    );
    const invalidKey = await invalidKeyProbe(projectRoot);
    writeEvent("invalid_static_key", invalidKey);
    const summary = {
      platform: process.platform,
      credential_mode: "env-unset-devin-discovery",
      source_retained: retainedRuns,
      source_variants: sourceVariants,
      packed_variants: packedVariants,
      invalid_static_key: invalidKey,
      checks: {
        retained_ten_successes: verifySuccessfulRuns(retainedRuns),
        three_wordings_successful: verifySuccessfulRuns([...retainedRuns.slice(0, 1), ...sourceVariants]),
        packed_entry_matches_source_behavior: verifySuccessfulRuns(packedVariants),
        zero_protocol_invalid: [...retainedRuns, ...sourceVariants, ...packedVariants]
          .every((result) => result.failure !== "FC_PROTOCOL_INVALID"),
        zero_pseudo_complete_empty: [...retainedRuns, ...sourceVariants, ...packedVariants]
          .every((result) => !result.pseudo_complete_empty),
        invalid_static_key_is_auth_rejected: invalidKey.failure === "FC_AUTH_REJECTED" && invalidKey.stdout_empty,
      },
      packed_tarball_sha256: consumer.tarball_sha256,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (!Object.values(summary.checks).every(Boolean)) process.exitCode = 1;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runProbe() {
  if (!process.argv.includes("--diagnose")) return main();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "fast-context-live-diagnostic-"));
  const projectRoot = join(temporaryDirectory, "ledger-recall");
  try {
    cpSync(FIXTURE_DIRECTORY, projectRoot, { recursive: true });
    const queries = process.argv.includes("--diagnose-retained")
      ? Array.from({ length: 10 }, () => RETAINED_QUERY)
      : QUERY_VARIANTS;
    await diagnose(projectRoot, queries);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

// Node may unref a pending fetch socket. Keep this release-only diagnostic
// process alive until its awaited bounded work settles, then always clear it.
const probeKeepalive = setInterval(() => {}, 2 ** 31 - 1);
try {
  await runProbe();
} catch {
  process.stderr.write("live probe failed\n");
  process.exitCode = 1;
} finally {
  clearInterval(probeKeepalive);
}
